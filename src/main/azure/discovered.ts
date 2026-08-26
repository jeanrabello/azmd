import type { TokenCredential } from '@azure/identity'
import type { Scope, WorkflowRef, WorkflowRun } from '../../shared/types.js'
import type { LogicAppAdapter } from './adapter.js'
import { ConsumptionAdapter } from './consumption.js'
import { StandardAdapter } from './standard.js'
import { ResourceGraphDiscovery } from './discovery.js'

/**
 * Adapters que descobrem o inventário via Resource Graph.
 *
 * Motivo de existirem: `ConsumptionAdapter` e `StandardAdapter` listam
 * workflows iterando `scope.subscriptionIds`. Com o escopo vazio — que é o
 * padrão, "monitorar tudo" — esse laço não executa e eles devolvem lista
 * vazia sem nunca falar com o Azure. O app então exibia "conectado, 0
 * workflows" mesmo sem credencial alguma: silencioso e enganoso.
 *
 * Aqui a descoberta vem do Resource Graph, que cobre todas as subscriptions
 * visíveis numa query só e propaga erro de auth de verdade quando não há
 * credencial. A busca de runs continua delegada ao adapter especializado —
 * cada um sabe da sua API.
 *
 * O cache existe porque o inventário muda em minutos/horas, enquanto o poll
 * roda a cada 45s; refazer a query a cada ciclo só gastaria quota.
 */

const INVENTORY_TTL_MS = 5 * 60 * 1000

/** Descoberta compartilhada entre os dois adapters, para uma query só por ciclo. */
class SharedInventory {
  readonly #discovery: ResourceGraphDiscovery
  readonly #standard: StandardAdapter
  #cache: { at: number; consumption: WorkflowRef[]; standard: WorkflowRef[] } | undefined
  #inFlight: Promise<{ consumption: WorkflowRef[]; standard: WorkflowRef[] }> | undefined

  constructor(credential: TokenCredential, standard: StandardAdapter) {
    this.#discovery = new ResourceGraphDiscovery(credential)
    this.#standard = standard
  }

  async get(scope: Scope): Promise<{ consumption: WorkflowRef[]; standard: WorkflowRef[] }> {
    const cached = this.#cache
    if (cached && Date.now() - cached.at < INVENTORY_TTL_MS) {
      return { consumption: cached.consumption, standard: cached.standard }
    }
    // Os dois adapters chamam no mesmo ciclo; sem isto, duas queries idênticas.
    this.#inFlight ??= this.#load(scope).finally(() => {
      this.#inFlight = undefined
    })
    return this.#inFlight
  }

  async #load(scope: Scope): Promise<{ consumption: WorkflowRef[]; standard: WorkflowRef[] }> {
    const result = await this.#discovery.discover(scope)

    // Sites Standard precisam ser expandidos nos workflows que hospedam.
    const standard: WorkflowRef[] = []
    for (const site of result.sites) {
      const siteScope: Scope = {
        subscriptionIds: [site.subscriptionId],
        resourceGroups: [site.resourceGroup],
        workflowResourceIds: [],
      }
      try {
        standard.push(...(await this.#standard.listWorkflows(siteScope)))
      } catch {
        // Um site inacessível não pode derrubar o inventário inteiro.
      }
    }

    const consumption = result.workflows
    this.#cache = { at: Date.now(), consumption, standard }
    return { consumption, standard }
  }
}

/** Consumption com inventário vindo do Resource Graph. */
export class DiscoveredConsumptionAdapter implements LogicAppAdapter {
  readonly id = 'consumption'
  readonly #inner: ConsumptionAdapter
  readonly #inventory: SharedInventory

  constructor(inner: ConsumptionAdapter, inventory: SharedInventory) {
    this.#inner = inner
    this.#inventory = inventory
  }

  async listWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    return (await this.#inventory.get(scope)).consumption
  }

  listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    return this.#inner.listRuns(workflow, since)
  }
}

/** Standard com inventário vindo do Resource Graph. */
export class DiscoveredStandardAdapter implements LogicAppAdapter {
  readonly id = 'standard'
  readonly #inner: StandardAdapter
  readonly #inventory: SharedInventory

  constructor(inner: StandardAdapter, inventory: SharedInventory) {
    this.#inner = inner
    this.#inventory = inventory
  }

  async listWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    return (await this.#inventory.get(scope)).standard
  }

  listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    return this.#inner.listRuns(workflow, since)
  }
}

/** Monta o par de adapters reais compartilhando uma única descoberta. */
export function createAzureAdapters(credential: TokenCredential): LogicAppAdapter[] {
  const consumption = new ConsumptionAdapter(credential)
  const standard = new StandardAdapter(credential)
  const inventory = new SharedInventory(credential, standard)
  return [
    new DiscoveredConsumptionAdapter(consumption, inventory),
    new DiscoveredStandardAdapter(standard, inventory),
  ]
}
