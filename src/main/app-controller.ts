import { powerMonitor } from 'electron'
import type { LogicAppAdapter } from './azure/adapter.js'
import { createAzureAdapters } from './azure/discovered.js'
import { DemoAdapter, DEMO_TENANT_ID } from './azure/demo.js'
import { createAzureCredential, probeCredential } from './auth/credential.js'
import { Poller, classifyError } from './poller.js'
import { buildPortalLink, buildResourceUrl, buildRunsListUrl } from './portal-url.js'
import { buildHierarchy, groupFor, isWorkflowWatched } from './grouping.js'
import { SettingsStore } from './settings-store.js'
import { RECENT_RUNS_LIMIT } from '../shared/types.js'
import type {
  AppState,
  ConnectionState,
  FailedRun,
  LogicAppSummary,
  RunDetails,
  Settings,
  WorkflowRef,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowSummary,
} from '../shared/types.js'

/**
 * Orquestrador do main process.
 *
 * Ele é dono do estado e do ciclo de vida do polling; tray, IPC e notificação
 * são consumidores. Toda mudança de estado passa por `#emit`, o que garante
 * que o renderer e o ícone da tray nunca divirjam.
 */

export interface AppControllerOptions {
  readonly onStateChanged: (state: AppState) => void
  readonly onNewFailures: (runs: readonly FailedRun[]) => void
}

export class AppController {
  readonly #settings: SettingsStore
  readonly #onStateChanged: AppControllerOptions['onStateChanged']
  readonly #onNewFailures: AppControllerOptions['onNewFailures']

  #poller: Poller
  #runs: readonly FailedRun[] = []
  #logicApps: readonly LogicAppSummary[] = []
  #workflowSummaries: readonly WorkflowSummary[] = []
  /** Inventário do último ciclo, para resolver ações vindas do renderer. */
  #discovered: readonly WorkflowRef[] = []
  #connection: ConnectionState = { kind: 'idle' }
  #timer: NodeJS.Timeout | undefined
  /** Impede ciclos concorrentes — um refresh manual durante o automático. */
  #cycleInFlight = false
  /** Tenant descoberto na autenticação; melhora as URLs do portal. */
  #resolvedTenantId: string | undefined
  #isFirstCycle = true
  #disposed = false

  constructor(options: AppControllerOptions) {
    this.#settings = new SettingsStore()
    this.#onStateChanged = options.onStateChanged
    this.#onNewFailures = options.onNewFailures

    const settings = this.#settings.get()
    this.#poller = new Poller(this.#buildAdapters(settings), {
      lookbackHours: settings.lookbackHours,
    })
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  start(): void {
    this.#watchPower()
    void this.refreshNow()
    this.#scheduleNext()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
  }

  /**
   * Pausa o polling durante o sleep e faz catch-up ao acordar.
   * Sem isso, o Mac acorda com um timer vencido e um burst de chamadas.
   */
  #watchPower(): void {
    powerMonitor.on('suspend', () => {
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = undefined
    })
    powerMonitor.on('resume', () => {
      void this.refreshNow()
      this.#scheduleNext()
    })
  }

  #scheduleNext(): void {
    if (this.#disposed) return
    if (this.#timer) clearTimeout(this.#timer)
    const intervalMs = this.#settings.get().pollIntervalSeconds * 1000
    this.#timer = setTimeout(() => {
      void this.refreshNow().finally(() => this.#scheduleNext())
    }, intervalMs)
  }

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  getState(): AppState {
    return {
      runs: this.#runs,
      logicApps: this.#logicApps,
      workflows: this.#workflowSummaries,
      connection: this.#connection,
      settings: this.#settings.get(),
    }
  }

  #emit(): void {
    this.#onStateChanged(this.getState())
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  async refreshNow(): Promise<void> {
    if (this.#cycleInFlight || this.#disposed) return
    this.#cycleInFlight = true

    if (this.#connection.kind === 'idle') {
      this.#connection = { kind: 'connecting' }
      this.#emit()
    }

    const settings = this.#settings.get()

    try {
      if (settings.mode === 'azure' && !this.#resolvedTenantId) {
        await this.#resolveTenant()
      }

      const result = await this.#poller.runCycle(settings.scope, {
        // Filtra antes da chamada: workflow ignorado não vira request ao ARM.
        shouldPoll: (workflow) => isWorkflowWatched(workflow, settings.watch),
      })
      const tenantId = settings.tenantId ?? this.#resolvedTenantId
      // Antes de mapear os runs: #toFailedRun resolve o Logic App a partir do
      // inventário, e com o de ontem o nome sairia vazio ou errado.
      this.#discovered = result.discoveredWorkflows
      this.#runs = result.allFailures.map((run) => this.#toFailedRun(run, tenantId))

      const hierarchy = buildHierarchy({
        workflows: result.discoveredWorkflows,
        failedRuns: result.allFailures,
        watch: settings.watch,
        portalUrlFor: (workflow) => buildRunsListUrl(workflow.resourceId, tenantId),
      })
      this.#logicApps = hierarchy.logicApps
      this.#workflowSummaries = hierarchy.workflows

      // Um ciclo pode falhar em alguns workflows e ter sucesso em outros.
      // Só reportamos erro quando nada foi coletado — caso contrário mostrar
      // "erro" com dados frescos na tela confunde mais do que informa.
      const totalFailure = result.errors.length > 0 && result.workflowsPolled === 0
      const firstError = result.errors[0]

      if (totalFailure && firstError) {
        this.#connection = { kind: 'error', error: firstError.error }
      } else if (result.discoveredWorkflows.length === 0 && result.errors.length > 0) {
        // Descoberta vazia COM erro: não é "tudo certo, nada existe" — é falha
        // de acesso. Sem isto o app mostrava ponto verde e lista vazia, que
        // parece bug e esconde o motivo real.
        this.#connection = {
          kind: 'error',
          error:
            firstError?.error ?? {
              kind: 'unknown',
              message: 'Não foi possível listar os Logic Apps.',
            },
        }
      } else {
        this.#connection = {
          kind: 'ok',
          lastSyncedAt: new Date().toISOString(),
          workflowsMonitored: result.workflowsPolled,
        }
      }

      // O primeiro ciclo apenas absorve o histórico: notificar tudo que já
      // existia no boot seria ruído, não sinal.
      if (this.#isFirstCycle) {
        this.#poller.primeSeen(result.newFailures)
        this.#isFirstCycle = false
      } else if (result.newFailures.length > 0 && settings.notificationsEnabled) {
        this.#onNewFailures(result.newFailures.map((run) => this.#toFailedRun(run, tenantId)))
      }
    } catch (cause) {
      this.#connection = { kind: 'error', error: classifyError(cause) }
    } finally {
      this.#cycleInFlight = false
      this.#emit()
    }
  }

  async #resolveTenant(): Promise<void> {
    const probe = await probeCredential(createAzureCredential())
    if (probe.ok) this.#resolvedTenantId = probe.tenantId
  }

  /** Anexa os deep links resolvidos; o renderer nunca monta URL. */
  #toFailedRun(run: WorkflowRun, tenantId: string | undefined): FailedRun {
    const link = buildPortalLink(run, tenantId)
    const workflow = this.#discovered.find((w) => w.resourceId === run.workflowResourceId)
    const group = workflow ? groupFor(workflow) : undefined

    return {
      ...run,
      portalUrl: link.url,
      portalUrlIsFallback: link.isFallback,
      workflowPortalUrl: buildRunsListUrl(run.workflowResourceId, tenantId),
      logicAppId: group?.id ?? '',
      logicAppName: group?.name ?? '',
    }
  }

  /**
   * Monta os detalhes de um run para a tela de detalhes.
   *
   * Não faz chamada nova ao Azure: o histórico sai do que o poller já coletou.
   * Retorna undefined se o run não está mais na lista (foi descartado, ou o
   * modo mudou).
   */
  getRunDetails(runId: string): RunDetails | undefined {
    const run = this.findRun(runId)
    if (!run) return undefined

    const tenantId = this.#settings.get().tenantId ?? this.#resolvedTenantId
    const recentRuns: WorkflowRunSummary[] = this.#poller
      .getRecentRuns(run.workflowResourceId, RECENT_RUNS_LIMIT)
      .map((entry) => ({
        runId: entry.runId,
        runName: entry.runName,
        status: entry.status,
        startTime: entry.startTime,
        ...(entry.endTime ? { endTime: entry.endTime } : {}),
        portalUrl: buildPortalLink(entry, tenantId).url,
        isCurrent: entry.runId === run.runId,
      }))

    const durationMs = run.endTime
      ? Date.parse(run.endTime) - Date.parse(run.startTime)
      : undefined

    return {
      run,
      recentRuns,
      ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Ações vindas do renderer
  // -------------------------------------------------------------------------

  getSettings(): Settings {
    return this.#settings.get()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const before = this.#settings.get()
    const after = this.#settings.update(patch)

    if (after.mode !== before.mode) {
      // Trocar de fonte invalida cursores e o que já foi visto.
      this.#poller = new Poller(this.#buildAdapters(after), {
        lookbackHours: after.lookbackHours,
      })
      this.#runs = []
      this.#logicApps = []
      this.#workflowSummaries = []
      this.#discovered = []
      this.#isFirstCycle = true
      this.#resolvedTenantId = after.mode === 'demo' ? DEMO_TENANT_ID : undefined
      this.#connection = { kind: 'connecting' }
    }

    if (after.lookbackHours !== before.lookbackHours) {
      this.#poller.setLookbackHours(after.lookbackHours)
    }

    if (after.pollIntervalSeconds !== before.pollIntervalSeconds) {
      this.#scheduleNext()
    }

    this.#emit()
    if (after.mode !== before.mode) void this.refreshNow()
    return after
  }

  /**
   * Liga/desliga um Logic App inteiro.
   *
   * Rebuilda a hierarquia na hora com o inventário que já temos, para a UI
   * responder ao clique sem esperar o próximo ciclo de polling.
   */
  setLogicAppWatched(logicAppId: string, watched: boolean): void {
    const current = this.#settings.get().watch
    const ignored = new Set(current.ignoredLogicAppIds)
    if (watched) ignored.delete(logicAppId)
    else ignored.add(logicAppId)

    this.#applyWatch({ ...current, ignoredLogicAppIds: [...ignored] })
  }

  setWorkflowWatched(workflowResourceId: string, watched: boolean): void {
    const current = this.#settings.get().watch
    const ignored = new Set(current.ignoredWorkflowResourceIds)
    if (watched) ignored.delete(workflowResourceId)
    else ignored.add(workflowResourceId)

    this.#applyWatch({ ...current, ignoredWorkflowResourceIds: [...ignored] })
  }

  /**
   * Limpa toda a seleção de ignorados.
   *
   * Uma ação só em vez de N chamadas: reativar dezenas de apps um a um
   * dispararia um refresh por clique e gravaria o settings.json toda vez.
   */
  watchAll(): void {
    this.#applyWatch({ ignoredLogicAppIds: [], ignoredWorkflowResourceIds: [] })
  }

  #applyWatch(watch: Settings['watch']): void {
    const settings = this.#settings.update({ watch })
    const tenantId = settings.tenantId ?? this.#resolvedTenantId

    // Runs de workflows recém-ignorados somem da lista imediatamente.
    const watchedIds = new Set(
      this.#discovered
        .filter((workflow) => isWorkflowWatched(workflow, settings.watch))
        .map((workflow) => workflow.resourceId),
    )
    this.#runs = this.#runs.filter((run) => watchedIds.has(run.workflowResourceId))

    const hierarchy = buildHierarchy({
      workflows: this.#discovered,
      failedRuns: this.#runs,
      watch: settings.watch,
      portalUrlFor: (workflow) => buildRunsListUrl(workflow.resourceId, tenantId),
    })
    this.#logicApps = hierarchy.logicApps
    this.#workflowSummaries = hierarchy.workflows
    this.#emit()

    // Reativar exige buscar o que não foi coletado enquanto estava ignorado.
    if (watchedIds.size > 0) void this.refreshNow()
  }

  /** URL do App Service (Standard) ou do resource group (Consumption). */
  logicAppPortalUrl(logicAppId: string): string | undefined {
    const summary = this.#logicApps.find((app) => app.group.id === logicAppId)
    if (!summary) return undefined
    const settings = this.#settings.get()
    const tenantId = settings.tenantId ?? this.#resolvedTenantId

    const { group } = summary
    const resourceId =
      group.siteResourceId ??
      `/subscriptions/${group.subscriptionId}/resourceGroups/${group.resourceGroup}`
    return buildResourceUrl(resourceId, tenantId)
  }

  workflowPortalUrl(workflowResourceId: string): string | undefined {
    return this.#workflowSummaries.find((w) => w.resourceId === workflowResourceId)?.portalUrl
  }

  findRun(runId: string): FailedRun | undefined {
    return this.#runs.find((run) => run.runId === runId)
  }

  dismissRun(runId: string): void {
    this.#poller.dismiss(runId)
    this.#runs = this.#runs.filter((run) => run.runId !== runId)
    this.#emit()
  }

  dismissAll(): void {
    this.#poller.dismissAll(this.#runs.map((run) => run.runId))
    this.#runs = []
    this.#emit()
  }

  /**
   * Escolhe os adapters conforme o modo.
   *
   * Este método é o toggle real <-> demo por inteiro. Nada além dele muda
   * quando o modo troca — poller, notificação, UI e IPC seguem idênticos,
   * porque todos falam com `LogicAppAdapter`, não com o Azure.
   */
  #buildAdapters(settings: Settings): LogicAppAdapter[] {
    if (settings.mode === 'demo') {
      this.#resolvedTenantId = DEMO_TENANT_ID
      return [new DemoAdapter()]
    }
    return createAzureAdapters(createAzureCredential())
  }
}
