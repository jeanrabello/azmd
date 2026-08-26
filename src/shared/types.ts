/**
 * Contratos compartilhados entre main, preload e renderer.
 *
 * Este arquivo é a fonte da verdade de tipos do app. O renderer nunca conhece
 * o SDK do Azure — ele só conhece o que está aqui. Isso é o que permite que a
 * fonte de dados seja trocada (Azure real <-> demo com mocks) sem que a UI
 * saiba da diferença.
 */

// ---------------------------------------------------------------------------
// Identificação de recursos
// ---------------------------------------------------------------------------

/** Os dois sabores de Logic App. As APIs por trás deles são completamente diferentes. */
export type WorkflowKind = 'consumption' | 'standard'

/** Status de um run, normalizado entre Consumption e Standard. */
export type RunStatus =
  | 'Succeeded'
  | 'Failed'
  | 'Cancelled'
  | 'Running'
  | 'Waiting'
  | 'Suspended'
  | 'TimedOut'
  | 'Skipped'
  | 'Aborted'
  | 'Unknown'

/** Status que representam uma execução encerrada sem sucesso. */
export const FAILURE_STATUSES: readonly RunStatus[] = ['Failed', 'TimedOut', 'Aborted']

export function isFailureStatus(status: RunStatus): boolean {
  return FAILURE_STATUSES.includes(status)
}

/**
 * Referência a um workflow monitorável.
 *
 * `resourceId` é o ARM resource ID completo e serve como chave primária
 * estável em todo o app (cursores, settings, dedupe).
 *
 * Para Consumption, o recurso é o próprio workflow:
 *   /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Logic/workflows/{name}
 *
 * Para Standard, o recurso é o *site*, e o workflow vive dentro dele. Por isso
 * `siteName` é obrigatório nesse caso — sem ele não dá para montar a chamada.
 */
export interface WorkflowRef {
  readonly resourceId: string
  readonly name: string
  readonly kind: WorkflowKind
  readonly subscriptionId: string
  readonly resourceGroup: string
  readonly location: string
  /** Só existe em Standard: o nome do App Service que hospeda o workflow. */
  readonly siteName?: string
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Um run de workflow, normalizado. Datas trafegam como ISO string (IPC-safe). */
export interface WorkflowRun {
  /** Nome do run no Azure — único dentro do workflow. */
  readonly runName: string
  /** Chave global única: `${workflowResourceId}/runs/${runName}`. Usada no dedupe. */
  readonly runId: string
  readonly workflowResourceId: string
  readonly workflowName: string
  readonly kind: WorkflowKind
  readonly status: RunStatus
  /** ISO 8601. */
  readonly startTime: string
  /** ISO 8601. Ausente enquanto o run não terminou. */
  readonly endTime?: string
  readonly error?: RunError
  /** Correlation ID do Azure, útil ao cruzar com logs. */
  readonly correlationId?: string
}

export interface RunError {
  readonly code?: string
  readonly message: string
}

/**
 * Um run com falha, já pronto para a UI: inclui o deep link resolvido.
 * É este o tipo que cruza o IPC para o renderer.
 */
export interface FailedRun extends WorkflowRun {
  readonly portalUrl: string
  /** true quando o deep link é o fallback (lista de runs), não o run específico. */
  readonly portalUrlIsFallback: boolean
}

// ---------------------------------------------------------------------------
// Escopo e configuração
// ---------------------------------------------------------------------------

/** Filtro de onde procurar workflows. Listas vazias significam "tudo". */
export interface Scope {
  readonly subscriptionIds: readonly string[]
  readonly resourceGroups: readonly string[]
  /** Resource IDs específicos. Quando não vazio, tem precedência sobre os demais. */
  readonly workflowResourceIds: readonly string[]
}

export const EMPTY_SCOPE: Scope = {
  subscriptionIds: [],
  resourceGroups: [],
  workflowResourceIds: [],
}

/** De onde vêm os dados. É o toggle central real <-> demo. */
export type DataSourceMode = 'azure' | 'demo'

export interface Settings {
  /** 'demo' usa dados mockados; 'azure' fala com o ARM de verdade. */
  readonly mode: DataSourceMode
  /** Intervalo de polling em segundos. Limitado por POLL_INTERVAL_BOUNDS. */
  readonly pollIntervalSeconds: number
  /** Janela de retrospecto ao buscar runs, em horas. */
  readonly lookbackHours: number
  readonly scope: Scope
  readonly notificationsEnabled: boolean
  readonly launchAtLogin: boolean
  /** Tenant usado ao montar URLs do portal. Opcional — o portal resolve sem ele. */
  readonly tenantId?: string
}

export const POLL_INTERVAL_BOUNDS = { min: 15, max: 300 } as const
export const LOOKBACK_BOUNDS = { min: 1, max: 48 } as const

export const DEFAULT_SETTINGS: Settings = {
  mode: 'demo',
  pollIntervalSeconds: 45,
  lookbackHours: 24,
  scope: EMPTY_SCOPE,
  notificationsEnabled: true,
  launchAtLogin: false,
}

// ---------------------------------------------------------------------------
// Estado de conexão
// ---------------------------------------------------------------------------

/**
 * Estado do último ciclo de polling. Modelado como união discriminada para que
 * a UI não precise adivinhar combinações inválidas (ex.: erro + dados frescos).
 */
export type ConnectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ok'; readonly lastSyncedAt: string; readonly workflowsMonitored: number }
  | { readonly kind: 'error'; readonly error: AppError; readonly lastSyncedAt?: string }

/** Categorias de erro que a UI trata de formas diferentes. */
export type AppErrorKind =
  | 'auth'          // credencial ausente/expirada -> ação: reconectar
  | 'permission'    // autenticado, mas sem RBAC   -> ação: pedir acesso
  | 'throttled'     // 429                          -> ação: esperar
  | 'network'       // offline/DNS/timeout          -> ação: tentar de novo
  | 'unknown'

export interface AppError {
  readonly kind: AppErrorKind
  readonly message: string
  /** Detalhe técnico, exibido apenas sob "mostrar detalhes". */
  readonly detail?: string
}

/** Snapshot completo enviado ao renderer a cada atualização. */
export interface AppState {
  readonly runs: readonly FailedRun[]
  readonly connection: ConnectionState
  readonly settings: Settings
}

// ---------------------------------------------------------------------------
// Contrato IPC exposto pelo preload
// ---------------------------------------------------------------------------

export interface RunbarAPI {
  getState(): Promise<AppState>
  onStateChanged(cb: (state: AppState) => void): () => void
  openRunInPortal(runId: string): Promise<void>
  refreshNow(): Promise<void>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  dismissRun(runId: string): Promise<void>
  dismissAll(): Promise<void>
  quit(): Promise<void>
}

/** Nomes dos canais IPC. Centralizados para não divergirem entre os lados. */
export const IPC = {
  getState: 'runbar:get-state',
  stateChanged: 'runbar:state-changed',
  openRunInPortal: 'runbar:open-run-in-portal',
  refreshNow: 'runbar:refresh-now',
  getSettings: 'runbar:get-settings',
  updateSettings: 'runbar:update-settings',
  dismissRun: 'runbar:dismiss-run',
  dismissAll: 'runbar:dismiss-all',
  quit: 'runbar:quit',
} as const
