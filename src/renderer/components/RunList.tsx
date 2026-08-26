import type { FailedRun } from '../../shared/types.js'
import { formatRelativeTime } from '../lib/time.js'

interface RunListProps {
  readonly runs: readonly FailedRun[]
  readonly onSelectRun: (runId: string) => void
}

export default function RunList({ runs, onSelectRun }: RunListProps): React.JSX.Element {
  // Mais recente primeiro — startTime é ISO, comparação por string não
  // funciona de forma confiável entre fusos, então parseia.
  const sorted = [...runs].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  )

  return (
    <ul className="run-list">
      {sorted.map((run) => (
        <RunRow key={run.runId} run={run} onSelect={onSelectRun} />
      ))}
    </ul>
  )
}

function RunRow({
  run,
  onSelect,
}: {
  readonly run: FailedRun
  readonly onSelect: (runId: string) => void
}): React.JSX.Element {
  /**
   * Clicar na linha abre os detalhes, não o portal.
   *
   * A troca é deliberada: a mensagem de erro aqui vem truncada em uma linha, e
   * mandar o usuário para o navegador só para ler o motivo é um caminho longo
   * demais. Abrir no portal virou uma ação explícita, no botão ao lado.
   */
  function handleOpenDetails(): void {
    onSelect(run.runId)
  }

  function handleOpenPortal(event: React.MouseEvent): void {
    event.stopPropagation()
    void window.runbar.openRunInPortal(run.runId)
  }

  function handleDismiss(event: React.MouseEvent): void {
    event.stopPropagation()
    void window.runbar.dismissRun(run.runId)
  }

  const portalLabel = run.portalUrlIsFallback
    ? 'Abrir no portal (cai na lista de runs — não achamos o link exato)'
    : 'Abrir run no portal'

  return (
    <li className="run-row">
      <button
        type="button"
        className="run-row__main"
        onClick={handleOpenDetails}
        aria-label={`Ver detalhes da falha de ${run.workflowName}`}
      >
        <div className="run-row__top">
          <span className="run-row__name">{run.workflowName}</span>
          <span className={`kind-badge kind-badge--${run.kind}`}>
            {run.kind === 'consumption' ? 'Consumption' : 'Standard'}
          </span>
        </div>
        <div className="run-row__bottom">
          <span className="run-row__error" title={run.error?.message}>
            {run.error?.message ?? 'Falha sem mensagem detalhada'}
          </span>
          <span className="run-row__time">{formatRelativeTime(run.startTime)}</span>
        </div>
      </button>

      <div className="run-row__actions">
        <button
          type="button"
          className="run-row__action"
          onClick={handleOpenPortal}
          aria-label={portalLabel}
          title={portalLabel}
        >
          {/* Glifo de "abrir em outro lugar", desenhado em vez de emoji para
              acompanhar a cor do tema. */}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4.5 1.5h6v6M10.5 1.5L5 7M9 7.5v3h-7.5V3h3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {run.portalUrlIsFallback && <span className="run-row__action-flag" aria-hidden="true" />}
        </button>

        <button
          type="button"
          className="run-row__action run-row__action--dismiss"
          onClick={handleDismiss}
          aria-label={`Descartar run de ${run.workflowName}`}
          title="Descartar"
        >
          ×
        </button>
      </div>
    </li>
  )
}
