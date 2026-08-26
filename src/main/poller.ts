import type { LogicAppAdapter } from './azure/adapter.js'
import { isFailureStatus } from '../shared/types.js'
import type { AppError, Scope, WorkflowRef, WorkflowRun } from '../shared/types.js'

/**
 * Motor de polling.
 *
 * Três cuidados que o plano exige, e o motivo de cada um:
 *
 *  1. Cursor por workflow — guardamos o startTime do run mais recente já visto
 *     e só pedimos o que veio depois. Sem isso relemos o histórico inteiro a
 *     cada ciclo e queimamos quota do ARM.
 *
 *  2. Dedupe por runId com TTL — um mesmo run aparece em duas janelas de
 *     polling quando está na fronteira do cursor. Sem o Set, o usuário recebe
 *     a mesma notificação duas vezes.
 *
 *  3. Backoff POR WORKFLOW, não global — um workflow barulhento que toma 429
 *     não pode travar os outros. É por isso que o estado de backoff vive no
 *     mapa por resourceId em vez de numa variável só.
 *
 * A classe não conhece Electron: não notifica, não desenha, não abre URL. Ela
 * emite resultado e deixa o chamador decidir. Isso a torna testável sem mock
 * de app.
 */

const DEDUPE_TTL_MS = 48 * 60 * 60 * 1000
const MAX_BACKOFF_MS = 15 * 60 * 1000
const BASE_BACKOFF_MS = 30 * 1000

export interface PollCycleResult {
  /** Runs falhos vistos pela primeira vez neste ciclo — o que merece notificação. */
  readonly newFailures: readonly WorkflowRun[]
  /** Todos os runs falhos dentro da janela, incluindo os já conhecidos. */
  readonly allFailures: readonly WorkflowRun[]
  readonly workflowsPolled: number
  /**
   * Inventário completo descoberto, inclusive workflows não observados.
   *
   * A UI precisa deles para listar o que existe e permitir reativar o que foi
   * ignorado — se só devolvêssemos os observados, não haveria caminho de volta.
   */
  readonly discoveredWorkflows: readonly WorkflowRef[]
  /** Erros por workflow. Um ciclo pode ter sucesso parcial. */
  readonly errors: readonly PollError[]
}

export interface PollCycleOptions {
  /**
   * Decide se um workflow deve ser consultado.
   *
   * Filtrar aqui — e não depois — é o que faz a seleção economizar quota: o
   * workflow ignorado nunca vira chamada ao ARM.
   */
  readonly shouldPoll?: (workflow: WorkflowRef) => boolean
}

export interface PollError {
  readonly workflowResourceId: string
  readonly workflowName: string
  readonly error: AppError
}

interface WorkflowState {
  /** startTime do run mais recente já observado. */
  cursor?: Date
  /** Enquanto Date.now() < skipUntil, o workflow é pulado (backoff). */
  skipUntil?: number
  consecutiveFailures: number
}

export interface PollerOptions {
  readonly lookbackHours: number
  /** Injeção de relógio, para testes determinísticos. */
  readonly now?: () => Date
}

export class Poller {
  #adapters: LogicAppAdapter[]
  #lookbackHours: number
  readonly #now: () => Date

  readonly #workflowState = new Map<string, WorkflowState>()
  /**
   * Últimos runs vistos por workflow, com qualquer status.
   *
   * Serve à tela de detalhes, que mostra sucessos junto das falhas para
   * distinguir "quebrou agora" de "quebrado o dia inteiro". Fica aqui — e não
   * numa chamada nova ao Azure — porque o ciclo já traz esses runs; buscá-los
   * de novo ao abrir o detalhe seria quota gasta à toa.
   */
  readonly #recentByWorkflow = new Map<string, WorkflowRun[]>()
  /** runId -> timestamp em que foi visto. Base do dedupe. */
  readonly #seenRuns = new Map<string, number>()
  /** Runs dispensados manualmente pelo usuário; não voltam para a lista. */
  readonly #dismissed = new Set<string>()

  constructor(adapters: LogicAppAdapter[], options: PollerOptions) {
    this.#adapters = adapters
    this.#lookbackHours = options.lookbackHours
    this.#now = options.now ?? (() => new Date())
  }

  /** Troca a fonte de dados (ex.: alternar entre Azure e demo). */
  setAdapters(adapters: LogicAppAdapter[]): void {
    this.#adapters = adapters
    // Cursores e histórico pertencem à fonte antiga; mantê-los esconderia
    // runs da nova e misturaria dados de demo com dados reais.
    this.#workflowState.clear()
    this.#recentByWorkflow.clear()
  }

  setLookbackHours(hours: number): void {
    this.#lookbackHours = hours
  }

  dismiss(runId: string): void {
    this.#dismissed.add(runId)
  }

  dismissAll(runIds: readonly string[]): void {
    for (const id of runIds) this.#dismissed.add(id)
  }

  /**
   * Marca runs como já notificados sem emiti-los como novos.
   * Usado no primeiro ciclo após o boot: o histórico existente não deve
   * disparar uma avalanche de notificações.
   */
  primeSeen(runs: readonly WorkflowRun[]): void {
    const now = this.#now().getTime()
    for (const run of runs) this.#seenRuns.set(run.runId, now)
  }

  async runCycle(scope: Scope, options: PollCycleOptions = {}): Promise<PollCycleResult> {
    this.#pruneSeen()

    const errors: PollError[] = []
    const discoveredWorkflows = await this.#discoverWorkflows(scope, errors)
    const shouldPoll = options.shouldPoll ?? (() => true)
    const workflows = discoveredWorkflows.filter(shouldPoll)

    const results = await Promise.all(
      workflows.map((wf) => this.#pollWorkflow(wf, errors)),
    )

    const allRuns = results.flat()
    this.#rememberRecent(allRuns)
    const failures = allRuns.filter((run) => isFailureStatus(run.status))

    const newFailures: WorkflowRun[] = []
    const now = this.#now().getTime()
    for (const run of failures) {
      if (this.#dismissed.has(run.runId)) continue
      if (this.#seenRuns.has(run.runId)) continue
      this.#seenRuns.set(run.runId, now)
      newFailures.push(run)
    }

    const visibleFailures = failures
      .filter((run) => !this.#dismissed.has(run.runId))
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))

    return {
      newFailures,
      allFailures: visibleFailures,
      workflowsPolled: workflows.length,
      discoveredWorkflows,
      errors,
    }
  }

  async #discoverWorkflows(scope: Scope, errors: PollError[]): Promise<WorkflowRef[]> {
    const found: WorkflowRef[] = []
    for (const adapter of this.#adapters) {
      try {
        found.push(...(await adapter.listWorkflows(scope)))
      } catch (cause) {
        errors.push({
          workflowResourceId: `adapter:${adapter.id}`,
          workflowName: adapter.id,
          error: classifyError(cause),
        })
      }
    }
    // Dois adapters podem enxergar o mesmo recurso; resourceId é a chave.
    const unique = new Map<string, WorkflowRef>()
    for (const wf of found) unique.set(wf.resourceId, wf)
    return [...unique.values()]
  }

  async #pollWorkflow(workflow: WorkflowRef, errors: PollError[]): Promise<WorkflowRun[]> {
    const state = this.#stateFor(workflow.resourceId)
    const nowMs = this.#now().getTime()

    // Em backoff: pular sem consumir quota.
    if (state.skipUntil !== undefined && nowMs < state.skipUntil) return []

    const adapter = this.#adapterFor(workflow)
    if (!adapter) return []

    const since = state.cursor ?? new Date(nowMs - this.#lookbackHours * 60 * 60 * 1000)

    try {
      const runs = await adapter.listRuns(workflow, since)
      state.consecutiveFailures = 0
      delete state.skipUntil

      // Avança o cursor com o run mais recente visto, inclusive quando todos
      // tiveram sucesso — é o que evita reler a janela inteira.
      const newest = runs.reduce<number>(
        (max, run) => Math.max(max, Date.parse(run.startTime)),
        state.cursor?.getTime() ?? 0,
      )
      if (newest > 0) {
        // 1s para trás cobre runs com o mesmo timestamp que chegam fora de ordem.
        state.cursor = new Date(newest - 1000)
      }
      return runs
    } catch (cause) {
      const error = classifyError(cause)
      state.consecutiveFailures += 1
      state.skipUntil = nowMs + this.#backoffFor(state, cause)
      errors.push({
        workflowResourceId: workflow.resourceId,
        workflowName: workflow.name,
        error,
      })
      return []
    }
  }

  /**
   * Backoff exponencial com jitter. Respeita `Retry-After` quando o ARM manda,
   * porque adivinhar contra uma instrução explícita do servidor só piora.
   */
  #backoffFor(state: WorkflowState, cause: unknown): number {
    const retryAfterMs = retryAfterFromError(cause)
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_BACKOFF_MS)

    const exponential = BASE_BACKOFF_MS * 2 ** Math.min(state.consecutiveFailures - 1, 5)
    const jitter = exponential * 0.25 * Math.random()
    return Math.min(exponential + jitter, MAX_BACKOFF_MS)
  }

  #adapterFor(workflow: WorkflowRef): LogicAppAdapter | undefined {
    // Demo atende os dois kinds; os reais são especializados por sabor.
    return (
      this.#adapters.find((a) => a.id === workflow.kind) ??
      this.#adapters.find((a) => a.id === 'demo')
    )
  }

  #stateFor(resourceId: string): WorkflowState {
    let state = this.#workflowState.get(resourceId)
    if (!state) {
      state = { consecutiveFailures: 0 }
      this.#workflowState.set(resourceId, state)
    }
    return state
  }

  /**
   * Runs recentes de um workflow, mais recente primeiro.
   * Devolve cópia: o chamador não deve conseguir mexer no estado interno.
   */
  getRecentRuns(workflowResourceId: string, limit: number): WorkflowRun[] {
    return (this.#recentByWorkflow.get(workflowResourceId) ?? []).slice(0, limit)
  }

  /**
   * Funde os runs do ciclo no histórico por workflow.
   *
   * Como o cursor avança, cada ciclo traz só o que é novo — por isso fundimos
   * com o que já havia em vez de substituir, senão o histórico encolheria para
   * um único run assim que o workflow ficasse quieto.
   */
  #rememberRecent(runs: readonly WorkflowRun[]): void {
    const HISTORY_PER_WORKFLOW = 20
    const touched = new Set<string>()

    for (const run of runs) {
      const list = this.#recentByWorkflow.get(run.workflowResourceId) ?? []
      if (!list.some((existing) => existing.runId === run.runId)) list.push(run)
      this.#recentByWorkflow.set(run.workflowResourceId, list)
      touched.add(run.workflowResourceId)
    }

    for (const resourceId of touched) {
      const list = this.#recentByWorkflow.get(resourceId)
      if (!list) continue
      list.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
      if (list.length > HISTORY_PER_WORKFLOW) list.length = HISTORY_PER_WORKFLOW
    }
  }

  /** Remove entradas de dedupe velhas para o Set não crescer sem limite. */
  #pruneSeen(): void {
    const cutoff = this.#now().getTime() - DEDUPE_TTL_MS
    for (const [runId, seenAt] of this.#seenRuns) {
      if (seenAt < cutoff) this.#seenRuns.delete(runId)
    }
  }
}

// ---------------------------------------------------------------------------
// Classificação de erros
// ---------------------------------------------------------------------------

interface HttpishError {
  statusCode?: number
  status?: number
  code?: string
  message?: string
  response?: { headers?: { get?: (name: string) => string | undefined } }
}

function asHttpish(cause: unknown): HttpishError {
  return typeof cause === 'object' && cause !== null ? (cause as HttpishError) : {}
}

/** Converte o erro cru do SDK numa categoria que a UI sabe apresentar. */
export function classifyError(cause: unknown): AppError {
  const err = asHttpish(cause)
  const status = err.statusCode ?? err.status
  const message = err.message ?? String(cause)

  if (status === 401 || status === 403) {
    const isAuth = status === 401 || /credential|token|login/i.test(message)
    return {
      kind: isAuth ? 'auth' : 'permission',
      message: isAuth
        ? 'Não foi possível autenticar no Azure — verifique sua sessão.'
        : 'Sem permissão para ler o histórico de runs.',
      detail: message,
    }
  }

  if (status === 429) {
    return {
      kind: 'throttled',
      message: 'O Azure está limitando as requisições. Tentando de novo em instantes.',
      detail: message,
    }
  }

  if (
    err.code === 'ENOTFOUND' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ETIMEDOUT' ||
    /network|fetch failed|getaddrinfo/i.test(message)
  ) {
    return { kind: 'network', message: 'Sem conexão com o Azure.', detail: message }
  }

  if (/credential|DefaultAzureCredential|AzureCliCredential|az login/i.test(message)) {
    return {
      kind: 'auth',
      message: 'Nenhuma credencial do Azure encontrada. Rode `az login`.',
      detail: message,
    }
  }

  return { kind: 'unknown', message: 'Falha ao consultar o Azure.', detail: message }
}

/** Lê `Retry-After` (segundos ou data HTTP) e devolve milissegundos. */
export function retryAfterFromError(cause: unknown): number | undefined {
  const err = asHttpish(cause)
  const raw = err.response?.headers?.get?.('retry-after')
  if (!raw) return undefined

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds * 1000

  const asDate = Date.parse(raw)
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())

  return undefined
}
