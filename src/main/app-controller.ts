import { powerMonitor } from 'electron'
import type { LogicAppAdapter } from './azure/adapter.js'
import { createAzureAdapters } from './azure/discovered.js'
import { DemoAdapter, DEMO_TENANT_ID } from './azure/demo.js'
import { createAzureCredential, probeCredential } from './auth/credential.js'
import { Poller, classifyError } from './poller.js'
import { buildPortalLink } from './portal-url.js'
import { SettingsStore } from './settings-store.js'
import type {
  AppState,
  ConnectionState,
  FailedRun,
  Settings,
  WorkflowRun,
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

      const result = await this.#poller.runCycle(settings.scope)
      const tenantId = settings.tenantId ?? this.#resolvedTenantId
      this.#runs = result.allFailures.map((run) => this.#toFailedRun(run, tenantId))

      // Um ciclo pode falhar em alguns workflows e ter sucesso em outros.
      // Só reportamos erro quando nada foi coletado — caso contrário mostrar
      // "erro" com dados frescos na tela confunde mais do que informa.
      const totalFailure = result.errors.length > 0 && result.workflowsPolled === 0
      const firstError = result.errors[0]

      if (totalFailure && firstError) {
        this.#connection = { kind: 'error', error: firstError.error }
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

  /** Anexa o deep link resolvido; o renderer nunca monta URL. */
  #toFailedRun(run: WorkflowRun, tenantId: string | undefined): FailedRun {
    const link = buildPortalLink(run, tenantId)
    return { ...run, portalUrl: link.url, portalUrlIsFallback: link.isFallback }
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
