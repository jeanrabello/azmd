import { ResourceGraphClient } from '@azure/arm-resourcegraph'
import type { TokenCredential } from '@azure/identity'
import type { Scope, WorkflowRef } from '../../shared/types.js'

/**
 * Um site `Microsoft.Web/sites` (kind contendo `workflowapp`) encontrado pelo
 * Resource Graph. NÃO é um workflow monitorável — é o contêiner. Os workflows
 * de verdade vivem dentro dele e só são conhecidos expandindo o site via
 * `StandardAdapter.listWorkflows` (chamada `webApps.listWorkflows`).
 *
 * Modelar isso como um tipo separado de `WorkflowRef` é proposital: um site
 * não tem `name` de workflow nem é pollável como está, então fingir que é
 * um `WorkflowRef` (com um `name` inventado, por exemplo) esconderia essa
 * diferença do chamador e ele acabaria tentando ler runs de um recurso que
 * não é um workflow.
 */
export interface DiscoveredSite {
  readonly resourceId: string
  readonly name: string
  readonly subscriptionId: string
  readonly resourceGroup: string
  readonly location: string
}

/** Resultado da descoberta: workflows Consumption prontos para poll + sites Standard a expandir. */
export interface DiscoveryResult {
  readonly workflows: WorkflowRef[]
  readonly sites: DiscoveredSite[]
}

const QUERY = `
resources
| where type =~ 'microsoft.logic/workflows'
   or (type =~ 'microsoft.web/sites' and kind contains 'workflowapp')
| project id, name, type, kind, resourceGroup, subscriptionId, location
`

/**
 * Inventário via Azure Resource Graph: uma query cobre todas as subscriptions
 * do escopo de uma vez, em vez de N chamadas (uma por subscription) como os
 * adapters fazem em `listWorkflows`. Usado pelo poller para descoberta inicial
 * e refresh periódico do inventário.
 */
export class ResourceGraphDiscovery {
  readonly #credential: TokenCredential
  readonly #client: ResourceGraphClient

  constructor(credential: TokenCredential) {
    this.#credential = credential
    this.#client = new ResourceGraphClient(this.#credential)
  }

  /**
   * Atalho para quem só quer workflows Consumption prontos para poll. Sites
   * Standard descobertos na mesma query são descartados aqui — use `discover`
   * quando precisar deles para expansão via `StandardAdapter`.
   */
  async discoverWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    const result = await this.discover(scope)
    return result.workflows
  }

  /** Inventário completo: workflows Consumption + sites Standard a expandir. */
  async discover(scope: Scope): Promise<DiscoveryResult> {
    const workflows: WorkflowRef[] = []
    const sites: DiscoveredSite[] = []

    let skipToken: string | undefined
    do {
      const response = await this.#client.resources({
        query: QUERY,
        ...(scope.subscriptionIds.length > 0 ? { subscriptions: [...scope.subscriptionIds] } : {}),
        options: {
          ...(skipToken ? { skipToken } : {}),
        },
      })

      const rows = parseRows(response.data)
      for (const row of rows) {
        if (scope.resourceGroups.length > 0 && !scope.resourceGroups.includes(row.resourceGroup)) {
          continue
        }

        if (row.type === 'microsoft.logic/workflows') {
          workflows.push({
            resourceId: row.id,
            name: row.name,
            kind: 'consumption',
            subscriptionId: row.subscriptionId,
            resourceGroup: row.resourceGroup,
            location: row.location,
          })
        } else if (row.type === 'microsoft.web/sites') {
          // Site Standard: não é um workflow, precisa ser expandido separadamente.
          sites.push({
            resourceId: row.id,
            name: row.name,
            subscriptionId: row.subscriptionId,
            resourceGroup: row.resourceGroup,
            location: row.location,
          })
        }
      }

      // Resource Graph pagina via skipToken — sem esse loop só a primeira
      // página volta, e em tenants grandes isso é fácil de passar despercebido.
      skipToken = response.skipToken
    } while (skipToken)

    return { workflows, sites }
  }
}

/** Uma linha já validada da resposta do Resource Graph. */
interface DiscoveryRow {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly resourceGroup: string
  readonly subscriptionId: string
  readonly location: string
}

/**
 * A resposta do Resource Graph vem como `data: any` no SDK — sem tipo forte,
 * já que o formato depende da query. Em vez de confiar num cast cego,
 * validamos cada linha em tempo de execução e descartamos as inválidas.
 */
function parseRows(data: unknown): DiscoveryRow[] {
  if (!Array.isArray(data)) return []

  const rows: DiscoveryRow[] = []
  for (const item of data) {
    const row = parseRow(item)
    if (row) rows.push(row)
  }
  return rows
}

function parseRow(item: unknown): DiscoveryRow | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>

  const id = record['id']
  const name = record['name']
  const type = record['type']
  const resourceGroup = record['resourceGroup']
  const subscriptionId = record['subscriptionId']
  const location = record['location']

  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof type !== 'string' ||
    typeof resourceGroup !== 'string' ||
    typeof subscriptionId !== 'string' ||
    typeof location !== 'string'
  ) {
    return undefined
  }

  return {
    id,
    name,
    type: type.toLowerCase(),
    resourceGroup,
    subscriptionId,
    location,
  }
}
