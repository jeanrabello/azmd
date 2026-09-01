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
  /**
   * Stateful ou Stateless. Só em Standard.
   *
   * Necessário para o deep link: a WorkflowMenuBlade do portal recebe `kind`
   * como parâmetro de rota.
   */
  readonly statefulness?: 'Stateful' | 'Stateless'
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
  /**
   * Payload de erro cru, como veio do Azure.
   *
   * O SDK tipa `WorkflowRun.error` como `any` e o formato varia: às vezes
   * `{code, message}`, às vezes aninhado em `error.error`, às vezes com
   * `details[]`. Em vez de adivinhar, guardamos o original para a tela de
   * detalhes poder mostrar o que realmente chegou quando a mensagem
   * normalizada não for suficiente.
   */
  readonly raw?: string
}

/**
 * Um run com falha, já pronto para a UI: inclui o deep link resolvido.
 * É este o tipo que cruza o IPC para o renderer.
 */
export interface FailedRun extends WorkflowRun {
  readonly portalUrl: string
  /** true quando o deep link é o fallback (lista de runs), não o run específico. */
  readonly portalUrlIsFallback: boolean
  /** Link para a lista de runs do workflow — usado na tela de detalhes. */
  readonly workflowPortalUrl: string
  /**
   * Logic App ao qual o run pertence.
   *
   * Redundante com a hierarquia, mas necessário: a notificação nativa é
   * disparada fora da UI e precisa dizer *onde* falhou — com vários Logic
   * Apps, 'notifica-cliente' sozinho é ambíguo entre prd e dev.
   */
  readonly logicAppId: string
  readonly logicAppName: string
}

/** Dados do workflow necessários para montar o deep link do portal. */
export interface WorkflowLinkContext {
  readonly resourceId: string
  readonly kind: WorkflowKind
  /** Slug da região (ex.: 'centralus'). */
  readonly location: string
  readonly statefulness?: 'Stateful' | 'Stateless'
}

/**
 * Um run qualquer do histórico recente de um workflow, com ou sem falha.
 *
 * Existe separado de `FailedRun` porque aqui o status importa: a tela de
 * detalhes mostra sucessos junto das falhas para distinguir "quebrou agora"
 * de "quebrado o dia inteiro".
 */
export interface WorkflowRunSummary {
  readonly runId: string
  readonly runName: string
  readonly status: RunStatus
  readonly startTime: string
  readonly endTime?: string
  readonly portalUrl: string
  /** Marca o run que está sendo detalhado, para destaque na lista. */
  readonly isCurrent: boolean
}

/** Tudo que a tela de detalhes precisa. Montado no main, sob demanda. */
export interface RunDetails {
  readonly run: FailedRun
  /** Últimos runs do mesmo workflow (sucessos e falhas), mais recente primeiro. */
  readonly recentRuns: readonly WorkflowRunSummary[]
  /** Duração do run em ms, quando já terminou. */
  readonly durationMs?: number
}

/** Quantos runs recentes a tela de detalhes exibe. */
export const RECENT_RUNS_LIMIT = 5

// ---------------------------------------------------------------------------
// Escopo e configuração
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hierarquia: Logic App -> workflow -> runs
// ---------------------------------------------------------------------------

/**
 * Um "Logic App" na visão do app — o nível que agrupa workflows.
 *
 * O Azure não tem um conceito único aqui, e é por isso que este tipo existe:
 *
 *  - Standard: o grupo é o App Service (`Microsoft.Web/sites`), e os workflows
 *    vivem literalmente dentro dele. Agrupamento natural.
 *  - Consumption: cada workflow é um recurso independente, sem pai. Agrupamos
 *    por resource group, que é como o portal organiza e como as pessoas
 *    costumam separar ambiente/time (prd, dev, financeiro).
 *
 * `id` é sintético e estável — ver `makeLogicAppId`. Não é um resource ID do
 * Azure, e não deve ser usado como tal.
 */
export interface LogicAppGroup {
  readonly id: string
  /** Nome exibido: nome do site (Standard) ou do resource group (Consumption). */
  readonly name: string
  readonly kind: WorkflowKind
  readonly subscriptionId: string
  readonly resourceGroup: string
  /** Só em Standard: o App Service que hospeda os workflows. */
  readonly siteName?: string
  /** Resource ID do site, para o deep link. Só em Standard. */
  readonly siteResourceId?: string
}

/**
 * Chave estável de um grupo.
 *
 * Standard usa o resource ID do site; Consumption usa subscription +
 * resource group. Prefixado por kind para que um site e um resource group de
 * mesmo nome nunca colidam.
 */
export function makeLogicAppId(params: {
  readonly kind: WorkflowKind
  readonly subscriptionId: string
  readonly resourceGroup: string
  readonly siteResourceId?: string
}): string {
  return params.kind === 'standard' && params.siteResourceId
    ? `standard:${params.siteResourceId}`
    : `consumption:${params.subscriptionId}/${params.resourceGroup}`
}

/** Estado de saúde de um grupo ou workflow, para o indicador na lista. */
export type HealthStatus = 'failing' | 'healthy' | 'unwatched'

/** Um Logic App com o resumo do que está acontecendo dentro dele. */
export interface LogicAppSummary {
  readonly group: LogicAppGroup
  readonly health: HealthStatus
  /** Workflows com pelo menos uma falha na janela. */
  readonly failingWorkflowCount: number
  readonly totalWorkflowCount: number
  /** Total de runs falhos somando todos os workflows do grupo. */
  readonly failedRunCount: number
  /** Falha mais recente do grupo, em ISO. Ausente se não há falha. */
  readonly lastFailureAt?: string
  readonly watched: boolean
}

/** Um workflow dentro de um Logic App, com o resumo das suas falhas. */
export interface WorkflowSummary {
  readonly resourceId: string
  readonly name: string
  readonly kind: WorkflowKind
  readonly logicAppId: string
  readonly health: HealthStatus
  readonly failedRunCount: number
  readonly lastFailureAt?: string
  readonly watched: boolean
  /** Link para a lista de runs do workflow no portal. */
  readonly portalUrl: string
}

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

/**
 * Quais Logic Apps o usuário quer observar.
 *
 * Modelado como opt-out e não opt-in: por padrão tudo é observado, e a lista
 * guarda só o que foi *ignorado*. O motivo é que um Logic App novo aparecendo
 * no Azure deve ser monitorado sem exigir ação — o contrário faria o app
 * silenciosamente deixar de avisar sobre coisas que ainda não existiam quando
 * a seleção foi feita, que é o pior modo de falhar para um monitor.
 *
 * `ignoredLogicAppIds` usa as chaves de `makeLogicAppId`; ignorar um grupo
 * ignora todos os workflows dentro dele. `ignoredWorkflowResourceIds` permite
 * silenciar um workflow específico sem largar o grupo inteiro.
 */
export interface WatchSelection {
  readonly ignoredLogicAppIds: readonly string[]
  readonly ignoredWorkflowResourceIds: readonly string[]
}

export const EMPTY_WATCH_SELECTION: WatchSelection = {
  ignoredLogicAppIds: [],
  ignoredWorkflowResourceIds: [],
}

/** De onde vêm os dados. É o toggle central real <-> demo. */
export type DataSourceMode = 'azure' | 'demo'

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

/**
 * Como o app obtém token do Azure.
 *
 *  - `deviceCode`: o usuário autentica no navegador com a própria conta. Não
 *    exige CLI instalada nem App Registration — o `@azure/identity` usa por
 *    padrão o client ID público do Azure CLI, pré-autorizado em qualquer
 *    tenant. É o padrão do app.
 *  - `servicePrincipal`: credencial de aplicação (tenant + client + secret),
 *    digitada nas configurações. Para operação contínua sem interação.
 *  - `azureCli`: usa a sessão do `az` já presente na máquina. Exige a CLI.
 */
export type AuthMode = 'deviceCode' | 'servicePrincipal' | 'azureCli'

/** Conta identificada no último login interativo. */
export interface AuthAccount {
  readonly username: string
  readonly tenantId: string
}

/**
 * Configuração de autenticação.
 *
 * ATENÇÃO: este tipo trafega para o renderer, então NÃO carrega segredo. O
 * `clientSecret` mora no Keychain (ver main/auth/secret-store.ts) e aqui só
 * existe o booleano que diz se há um guardado — nunca o valor.
 */
export interface AuthConfig {
  readonly mode: AuthMode
  /** Tenant do service principal. Não confundir com `Settings.tenantId`. */
  readonly tenantId?: string
  readonly clientId?: string
  /** true quando há um secret no Keychain. Nunca o secret em si. */
  readonly hasClientSecret: boolean
  /** Conta do último login por device code, quando houve. */
  readonly account?: AuthAccount
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  mode: 'deviceCode',
  hasClientSecret: false,
}

/**
 * Patch de auth vindo do renderer.
 *
 * Separado de `AuthConfig` porque é o único caminho por onde um segredo entra:
 * `clientSecret` só existe aqui, no sentido renderer -> main, e nunca volta.
 * `undefined` significa "não mexer"; string vazia significa "apagar".
 */
export interface AuthConfigPatch {
  readonly mode?: AuthMode
  readonly tenantId?: string
  readonly clientId?: string
  readonly clientSecret?: string
}

/** Estado do fluxo de device code, para a UI acompanhar o login. */
export type AuthFlowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  /** Código emitido: a UI mostra `userCode` e o link de verificação. */
  | {
      readonly kind: 'prompt'
      readonly userCode: string
      readonly verificationUri: string
      readonly message: string
    }
  | { readonly kind: 'success'; readonly account: AuthAccount }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Tema da interface.
 *
 * `system` segue o SO — é o padrão e o que a maioria espera. As opções fixas
 * existem por um motivo concreto além de gosto: no Windows o ícone da bandeja
 * não é recolorido pelo sistema (ver tray.ts), então o tema também decide se o
 * glifo é claro ou escuro. Quem tem a barra de tarefas numa cor que o SO não
 * reporta corretamente precisa poder forçar a variante visível.
 */
export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  /** 'demo' usa dados mockados; 'azure' fala com o ARM de verdade. */
  readonly mode: DataSourceMode
  /** Intervalo de polling em segundos. Limitado por POLL_INTERVAL_BOUNDS. */
  readonly pollIntervalSeconds: number
  /** Janela de retrospecto ao buscar runs, em horas. */
  readonly lookbackHours: number
  readonly scope: Scope
  /** O que o usuário escolheu não observar. Ver WatchSelection. */
  readonly watch: WatchSelection
  readonly notificationsEnabled: boolean
  readonly launchAtLogin: boolean
  /** Tema da interface e do ícone da bandeja. Ver Theme. */
  readonly theme: Theme
  /** Tenant usado ao montar URLs do portal. Opcional — o portal resolve sem ele. */
  readonly tenantId?: string
  /**
   * Como autenticar no Azure.
   *
   * Distinto de `tenantId` acima de propósito: aquele é derivado do token e
   * serve só para montar URL do portal; este é configuração do usuário.
   */
  readonly auth: AuthConfig
}

export const POLL_INTERVAL_BOUNDS = { min: 15, max: 300 } as const
export const LOOKBACK_BOUNDS = { min: 1, max: 48 } as const

export const DEFAULT_SETTINGS: Settings = {
  mode: 'demo',
  pollIntervalSeconds: 45,
  lookbackHours: 24,
  scope: EMPTY_SCOPE,
  watch: EMPTY_WATCH_SELECTION,
  notificationsEnabled: true,
  launchAtLogin: false,
  theme: 'system',
  auth: DEFAULT_AUTH_CONFIG,
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
  /** Runs falhos dos workflows observados, mais recente primeiro. */
  readonly runs: readonly FailedRun[]
  /** Logic Apps conhecidos — inclusive os ignorados, para poder reativá-los. */
  readonly logicApps: readonly LogicAppSummary[]
  /** Workflows conhecidos, indexáveis por logicAppId. */
  readonly workflows: readonly WorkflowSummary[]
  readonly connection: ConnectionState
  readonly settings: Settings
  /**
   * Tema já resolvido para 'light' ou 'dark'.
   *
   * O renderer não consegue resolver `theme: 'system'` sozinho de forma
   * confiável: `prefers-color-scheme` responde pelo Chromium, enquanto quem
   * manda no popover é o `nativeTheme` do Electron — e é ele que também escolhe
   * o ícone da bandeja. Resolver num lugar só evita a UI e o ícone
   * discordarem sobre qual tema está valendo.
   */
  readonly resolvedTheme: 'light' | 'dark'
}

// ---------------------------------------------------------------------------
// Contrato IPC exposto pelo preload
// ---------------------------------------------------------------------------

export interface AzmdAPI {
  /**
   * Plataforma do main. Só para decisões de apresentação — o macOS tem
   * vibrancy e os outros precisam de um fundo opaco (ver app.css).
   */
  readonly platform: NodeJS.Platform
  getState(): Promise<AppState>
  onStateChanged(cb: (state: AppState) => void): () => void
  openRunInPortal(runId: string): Promise<void>
  /** Abre a lista de runs do workflow no portal. */
  openWorkflowInPortal(runId: string): Promise<void>
  /** Detalhes de um run, incluindo o histórico recente do workflow. */
  getRunDetails(runId: string): Promise<RunDetails | undefined>
  refreshNow(): Promise<void>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  /**
   * Dispara uma notificação de teste. Resolve `false` quando nada foi
   * mostrado — notificações desligadas ou sem suporte no sistema.
   */
  testNotification(): Promise<boolean>
  /** Liga/desliga o monitoramento de um Logic App inteiro. */
  setLogicAppWatched(logicAppId: string, watched: boolean): Promise<void>
  /** Liga/desliga o monitoramento de um workflow específico. */
  setWorkflowWatched(workflowResourceId: string, watched: boolean): Promise<void>
  /** Volta a observar tudo — desfaz silenciamentos em massa de uma vez. */
  watchAll(): Promise<void>
  /** Abre no portal o App Service (Standard) ou o resource group (Consumption). */
  openLogicAppInPortal(logicAppId: string): Promise<void>
  /** Abre a lista de runs de um workflow no portal. */
  openWorkflowResourceInPortal(workflowResourceId: string): Promise<void>
  dismissRun(runId: string): Promise<void>
  dismissAll(): Promise<void>
  quit(): Promise<void>

  // -- Autenticação --------------------------------------------------------

  /**
   * Salva a config de auth. É o único caminho por onde um `clientSecret`
   * entra, e ele nunca volta: a resposta é um `AuthConfig`, sem segredo.
   */
  updateAuthConfig(patch: AuthConfigPatch): Promise<AuthConfig>
  /**
   * Inicia o login por device code. Resolve quando o fluxo termina; o código
   * a exibir chega antes, por `onAuthFlowChanged`.
   */
  authSignIn(): Promise<AuthFlowState>
  /** Esquece a conta e apaga o secret guardado. */
  authSignOut(): Promise<AuthConfig>
  /** Acompanha o fluxo de login. Retorna a função de cancelamento. */
  onAuthFlowChanged(cb: (state: AuthFlowState) => void): () => void
  /**
   * Abre a página de device login no navegador.
   *
   * Existe separado de `openRunInPortal` porque a allowlist é outra: aqui os
   * hosts são os da Microsoft Entra, não os do portal. O renderer não abre URL
   * externa por conta própria em nenhuma hipótese.
   */
  openDeviceLoginUrl(url: string): Promise<void>
}

/** Nomes dos canais IPC. Centralizados para não divergirem entre os lados. */
export const IPC = {
  getState: 'azmd:get-state',
  stateChanged: 'azmd:state-changed',
  openRunInPortal: 'azmd:open-run-in-portal',
  openWorkflowInPortal: 'azmd:open-workflow-in-portal',
  getRunDetails: 'azmd:get-run-details',
  refreshNow: 'azmd:refresh-now',
  getSettings: 'azmd:get-settings',
  updateSettings: 'azmd:update-settings',
  testNotification: 'azmd:test-notification',
  setLogicAppWatched: 'azmd:set-logic-app-watched',
  setWorkflowWatched: 'azmd:set-workflow-watched',
  watchAll: 'azmd:watch-all',
  openLogicAppInPortal: 'azmd:open-logic-app-in-portal',
  openWorkflowResourceInPortal: 'azmd:open-workflow-resource-in-portal',
  dismissRun: 'azmd:dismiss-run',
  dismissAll: 'azmd:dismiss-all',
  quit: 'azmd:quit',
  updateAuthConfig: 'azmd:update-auth-config',
  authSignIn: 'azmd:auth-sign-in',
  authSignOut: 'azmd:auth-sign-out',
  openDeviceLoginUrl: 'azmd:open-device-login-url',
  /** main -> renderer: andamento do fluxo de device code. */
  authFlowChanged: 'azmd:auth-flow-changed',
} as const
