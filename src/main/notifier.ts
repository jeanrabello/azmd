import { Notification } from 'electron'
import type { FailedRun } from '../shared/types.js'

/**
 * Notificações nativas.
 *
 * O dedupe forte mora no Poller (por runId, com TTL de 48h). Aqui há uma
 * segunda barreira, mais barata, contra dois problemas diferentes:
 *
 *  - Avalanche: se 40 runs falharem de uma vez, 40 banners empilhados são
 *    inúteis. Acima do limite, agregamos numa notificação só.
 *  - Repetição na mesma sessão, caso algum caminho chame notify duas vezes.
 */

const MAX_INDIVIDUAL_NOTIFICATIONS = 3

export interface NotifierOptions {
  /** Chamado quando o usuário clica na notificação. */
  readonly onActivate: (run: FailedRun) => void
  /** Chamado ao clicar numa notificação agregada. */
  readonly onActivateSummary?: () => void
}

export class Notifier {
  readonly #onActivate: NotifierOptions['onActivate']
  readonly #onActivateSummary: NotifierOptions['onActivateSummary']
  readonly #notifiedThisSession = new Set<string>()
  #enabled = true

  constructor(options: NotifierOptions) {
    this.#onActivate = options.onActivate
    this.#onActivateSummary = options.onActivateSummary
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
  }

  /** Notifica sobre runs novos. Silencioso quando desligado ou sem suporte. */
  notifyFailures(runs: readonly FailedRun[]): void {
    if (!this.#enabled || runs.length === 0) return
    if (!Notification.isSupported()) return

    const fresh = runs.filter((run) => !this.#notifiedThisSession.has(run.runId))
    if (fresh.length === 0) return
    for (const run of fresh) this.#notifiedThisSession.add(run.runId)

    if (fresh.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
      this.#notifySummary(fresh)
      return
    }
    for (const run of fresh) this.#notifyOne(run)
  }

  #notifyOne(run: FailedRun): void {
    const notification = new Notification({
      title: `${run.workflowName} falhou`,
      // Com muitos Logic Apps, o nome do workflow sozinho é ambíguo: o mesmo
      // 'notifica-cliente' existe em prd e dev. O subtítulo diz onde foi.
      subtitle: run.logicAppName,
      body: run.error?.message ?? 'Run terminou com status Failed',
      silent: false,
    })
    notification.on('click', () => this.#onActivate(run))
    notification.show()
  }

  #notifySummary(runs: readonly FailedRun[]): void {
    const apps = [...new Set(runs.map((r) => r.logicAppName).filter(Boolean))]
    const names = [...new Set(runs.map((r) => r.workflowName))]
    const subject =
      apps.length === 1 && apps[0]
        ? apps[0]
        : names.length === 1
          ? names[0]
          : `${names.length} workflows`
    const notification = new Notification({
      title: `${runs.length} runs falharam`,
      body: `Em ${subject}. Abra o azmd para ver a lista.`,
      silent: false,
    })
    notification.on('click', () => this.#onActivateSummary?.())
    notification.show()
  }
}
