import type { FailedRun } from '../../shared/types.js'
import { formatRelativeTime } from '../lib/time.js'

interface RunListProps {
  readonly runs: readonly FailedRun[]
}

export default function RunList({ runs }: RunListProps): React.JSX.Element {
  // Mais recente primeiro — startTime é ISO, comparação por string não
  // funciona de forma confiável entre fusos, então parseia.
  const sorted = [...runs].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  )

  return (
    <ul className="run-list">
      {sorted.map((run) => (
        <RunRow key={run.runId} run={run} />
      ))}
    </ul>
  )
}

function RunRow({ run }: { readonly run: FailedRun }): React.JSX.Element {
  function handleOpen(): void {
    window.runbar.openRunInPortal(run.runId)
  }

  function handleDismiss(event: React.MouseEvent): void {
    // Evita disparar a abertura do portal ao clicar no dismiss dentro da row.
    event.stopPropagation()
    window.runbar.dismissRun(run.runId)
  }

  return (
    <li className="run-row">
      <button type="button" className="run-row__main" onClick={handleOpen}>
        <div className="run-row__top">
          <span className="run-row__name">{run.workflowName}</span>
          <span className={`kind-badge kind-badge--${run.kind}`}>
            {run.kind === 'consumption' ? 'Consumption' : 'Standard'}
          </span>
          {run.portalUrlIsFallback && (
            <span className="fallback-indicator" title="Abre a lista de runs — não achamos o link exato">
              ⓘ
            </span>
          )}
        </div>
        <div className="run-row__bottom">
          <span className="run-row__error" title={run.error?.message}>
            {run.error?.message ?? 'Falha sem mensagem detalhada'}
          </span>
          <span className="run-row__time">{formatRelativeTime(run.startTime)}</span>
        </div>
      </button>

      <button
        type="button"
        className="run-row__dismiss"
        onClick={handleDismiss}
        aria-label={`Descartar run de ${run.workflowName}`}
        title="Descartar"
      >
        ×
      </button>
    </li>
  )
}
