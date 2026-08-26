import type { Scope, WorkflowRef, WorkflowRun } from '../../shared/types.js'
import type { LogicAppAdapter } from './adapter.js'
import { makeRunId } from './adapter.js'

/**
 * Adapter de demonstração.
 *
 * Serve a dois propósitos:
 *  1. Rodar o app inteiro — poller, dedupe, notificações, UI — sem credencial
 *     nenhuma do Azure.
 *  2. Servir de espécie executável: os dados aqui têm exatamente o formato que
 *     os adapters reais produzem, então divergências aparecem no type-check.
 *
 * O gerador é determinístico por padrão (LCG com seed fixa) para que a UI não
 * fique piscando entre ciclos. `simulateNewFailures` liga a produção de runs
 * novos ao longo do tempo, que é o que exercita notificação e dedupe.
 */

const DEMO_SUBSCRIPTION = '00000000-0000-0000-0000-000000000001'
const DEMO_TENANT = '00000000-0000-0000-0000-0000000000ff'

export const DEMO_TENANT_ID = DEMO_TENANT

function consumptionId(rg: string, name: string): string {
  return `/subscriptions/${DEMO_SUBSCRIPTION}/resourceGroups/${rg}/providers/Microsoft.Logic/workflows/${name}`
}

function standardId(rg: string, site: string, workflow: string): string {
  return `/subscriptions/${DEMO_SUBSCRIPTION}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${site}/workflows/${workflow}`
}

const DEMO_WORKFLOWS: readonly WorkflowRef[] = [
  {
    resourceId: consumptionId('rg-integracoes', 'processa-pedidos'),
    name: 'processa-pedidos',
    kind: 'consumption',
    subscriptionId: DEMO_SUBSCRIPTION,
    resourceGroup: 'rg-integracoes',
    location: 'brazilsouth',
  },
  {
    resourceId: consumptionId('rg-integracoes', 'sincroniza-estoque'),
    name: 'sincroniza-estoque',
    kind: 'consumption',
    subscriptionId: DEMO_SUBSCRIPTION,
    resourceGroup: 'rg-integracoes',
    location: 'brazilsouth',
  },
  {
    resourceId: consumptionId('rg-financeiro', 'concilia-pagamentos'),
    name: 'concilia-pagamentos',
    kind: 'consumption',
    subscriptionId: DEMO_SUBSCRIPTION,
    resourceGroup: 'rg-financeiro',
    location: 'eastus',
  },
  {
    resourceId: standardId('rg-plataforma', 'la-plataforma-prd', 'notifica-cliente'),
    name: 'notifica-cliente',
    kind: 'standard',
    subscriptionId: DEMO_SUBSCRIPTION,
    resourceGroup: 'rg-plataforma',
    location: 'brazilsouth',
    siteName: 'la-plataforma-prd',
  },
  {
    resourceId: standardId('rg-plataforma', 'la-plataforma-prd', 'exporta-relatorio'),
    name: 'exporta-relatorio',
    kind: 'standard',
    subscriptionId: DEMO_SUBSCRIPTION,
    resourceGroup: 'rg-plataforma',
    location: 'brazilsouth',
    siteName: 'la-plataforma-prd',
  },
]

/** Erros realistas de Logic Apps, para a UI ser exercitada com texto de verdade. */
const DEMO_ERRORS: readonly { code: string; message: string }[] = [
  {
    code: 'BadRequest',
    message:
      "The execution of template action 'HTTP_Criar_Pedido' failed: the result of the evaluation of 'body' is not valid.",
  },
  {
    code: 'Unauthorized',
    message:
      "The API operation 'PostItem' failed with status code 401 (Unauthorized). The connection may need to be reauthorized.",
  },
  {
    code: 'RequestTimeout',
    message:
      "The HTTP request to 'https://api.interna.local/v2/estoque' timed out after 00:02:00.",
  },
  {
    code: 'ActionFailed',
    message: "The execution of template action 'Parse_JSON' failed: invalid JSON payload.",
  },
  {
    code: 'ServiceProviderConnectionFailed',
    message:
      'Connection to the Service Bus namespace failed. Verify the connection string and firewall rules.',
  },
]

/** LCG determinística — evita depender de Math.random e mantém a UI estável. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export interface DemoAdapterOptions {
  /**
   * Quando true, novos runs falhos passam a existir conforme o tempo avança,
   * exercitando notificação e dedupe. Quando false, o conjunto é fixo.
   */
  readonly simulateNewFailures?: boolean
  /** Seed do gerador. Mesma seed => mesmos dados. */
  readonly seed?: number
  /** Injeção de relógio, para testes determinísticos. */
  readonly now?: () => Date
}

export class DemoAdapter implements LogicAppAdapter {
  readonly id = 'demo'

  readonly #simulateNewFailures: boolean
  readonly #seed: number
  readonly #now: () => Date
  /** Runs base, gerados uma vez para não mudarem a cada ciclo de polling. */
  #baseRuns: WorkflowRun[] | undefined

  constructor(options: DemoAdapterOptions = {}) {
    this.#simulateNewFailures = options.simulateNewFailures ?? true
    this.#seed = options.seed ?? 42
    this.#now = options.now ?? (() => new Date())
  }

  async listWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    return DEMO_WORKFLOWS.filter((wf) => matchesScope(wf, scope))
  }

  async listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    const all = this.#ensureBaseRuns()
    const extra = this.#simulateNewFailures ? this.#timeDerivedRuns(workflow) : []
    return [...all, ...extra]
      .filter((run) => run.workflowResourceId === workflow.resourceId)
      .filter((run) => new Date(run.startTime).getTime() >= since.getTime())
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
  }

  /** Conjunto estável de runs espalhados pelas últimas 24h. */
  #ensureBaseRuns(): WorkflowRun[] {
    if (this.#baseRuns) return this.#baseRuns

    const rand = createRandom(this.#seed)
    const now = this.#now().getTime()
    const runs: WorkflowRun[] = []

    for (const wf of DEMO_WORKFLOWS) {
      const count = 2 + Math.floor(rand() * 4)
      for (let i = 0; i < count; i++) {
        const minutesAgo = Math.floor(rand() * 22 * 60) + 5
        const startedAt = new Date(now - minutesAgo * 60_000)
        const durationMs = Math.floor(rand() * 90_000) + 1_500
        // ~40% dos runs falham — o suficiente para a lista nunca ficar vazia.
        const failed = rand() < 0.4
        runs.push(
          this.#makeRun(wf, startedAt, durationMs, failed, Math.floor(rand() * DEMO_ERRORS.length)),
        )
      }
    }
    this.#baseRuns = runs
    return runs
  }

  /**
   * Runs derivados do relógio: um novo run falho a cada ~3 minutos por
   * workflow. Como o runName vem do bucket de tempo, o mesmo run é estável
   * entre ciclos — é exatamente isso que o dedupe precisa enfrentar.
   */
  #timeDerivedRuns(workflow: WorkflowRef): WorkflowRun[] {
    const BUCKET_MS = 3 * 60_000
    const now = this.#now().getTime()
    const currentBucket = Math.floor(now / BUCKET_MS)
    const offset = hashString(workflow.resourceId) % 5
    const runs: WorkflowRun[] = []

    for (let back = 0; back < 3; back++) {
      const bucket = currentBucket - back
      if ((bucket + offset) % 5 !== 0) continue
      const startedAt = new Date(bucket * BUCKET_MS)
      runs.push(
        this.#makeRun(workflow, startedAt, 4_200, true, (bucket + offset) % DEMO_ERRORS.length),
      )
    }
    return runs
  }

  #makeRun(
    wf: WorkflowRef,
    startedAt: Date,
    durationMs: number,
    failed: boolean,
    errorIndex: number,
  ): WorkflowRun {
    const runName = `08${startedAt.getTime()}${wf.name.length}`
    const endTime = new Date(startedAt.getTime() + durationMs).toISOString()
    const error = DEMO_ERRORS[errorIndex % DEMO_ERRORS.length]

    const base = {
      runName,
      runId: makeRunId(wf.resourceId, runName),
      workflowResourceId: wf.resourceId,
      workflowName: wf.name,
      kind: wf.kind,
      startTime: startedAt.toISOString(),
      endTime,
      correlationId: `demo-${runName}`,
    }

    if (!failed) return { ...base, status: 'Succeeded' }
    return {
      ...base,
      status: 'Failed',
      error: {
        message: error?.message ?? 'Run terminou com status Failed',
        ...(error?.code ? { code: error.code } : {}),
      },
    }
  }
}

function matchesScope(wf: WorkflowRef, scope: Scope): boolean {
  if (scope.workflowResourceIds.length > 0) {
    return scope.workflowResourceIds.includes(wf.resourceId)
  }
  if (scope.subscriptionIds.length > 0 && !scope.subscriptionIds.includes(wf.subscriptionId)) {
    return false
  }
  if (scope.resourceGroups.length > 0 && !scope.resourceGroups.includes(wf.resourceGroup)) {
    return false
  }
  return true
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}
