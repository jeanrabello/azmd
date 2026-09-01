import { useEffect, useState } from 'react'
import type { RunDetails, RunStatus, WorkflowRunSummary } from '../../shared/types.js'
import { formatRelativeTime } from '../lib/time.js'

interface RunDetailsPanelProps {
  readonly runId: string
  readonly onBack: () => void
}

/**
 * Tela de detalhes de um run que falhou.
 *
 * Existe porque a listagem só cabe uma linha de erro truncada — e mensagem de
 * Logic App costuma ser longa, com a parte útil no fim. Aqui a mensagem
 * aparece inteira, junto do payload cru quando a normalizada não basta.
 *
 * Os dados vêm prontos do main via `getRunDetails`; nenhuma chamada ao Azure
 * acontece por abrir esta tela.
 */
export default function RunDetailsPanel({
  runId,
  onBack,
}: RunDetailsPanelProps): React.JSX.Element {
  const [details, setDetails] = useState<RunDetails | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    void window.azmd.getRunDetails(runId).then((result) => {
      // O run pode ter sido descartado enquanto a busca acontecia.
      if (!active) return
      setDetails(result ?? null)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [runId])

  if (loading) {
    return (
      <section className="details">
        <DetailsHeader onBack={onBack} />
        <p className="details__placeholder">Loading…</p>
      </section>
    )
  }

  if (!details) {
    return (
      <section className="details">
        <DetailsHeader onBack={onBack} />
        <p className="details__placeholder">
          This run is no longer available — it may have been dismissed.
        </p>
      </section>
    )
  }

  const { run, recentRuns, durationMs } = details

  return (
    <section className="details">
      <DetailsHeader onBack={onBack} />

      <div className="details__scroll">
        <header className="details__title-block">
          <h2 className="details__workflow">{run.workflowName}</h2>
          <div className="details__badges">
            <span className={`kind-badge kind-badge--${run.kind}`}>
              {run.kind === 'consumption' ? 'Consumption' : 'Standard'}
            </span>
            <StatusBadge status={run.status} />
          </div>
        </header>

        <section className="details__section">
          <h3 className="details__section-title">Error</h3>
          {run.error ? (
            <>
              {run.error.code !== undefined && (
                <p className="details__error-code">{run.error.code}</p>
              )}
              {/* Mensagem completa, sem truncar: é o motivo desta tela existir. */}
              <p className="details__error-message">{run.error.message}</p>
              {run.error.raw !== undefined && <RawErrorDisclosure raw={run.error.raw} />}
            </>
          ) : (
            <p className="details__placeholder">
              Azure did not return error details for this run.
            </p>
          )}
        </section>

        <section className="details__section">
          <h3 className="details__section-title">Execution</h3>
          <dl className="details__facts">
            <Fact label="Start" value={formatAbsolute(run.startTime)} />
            <Fact label="End" value={run.endTime ? formatAbsolute(run.endTime) : '—'} />
            <Fact label="Duration" value={formatDuration(durationMs)} />
            <Fact label="Run" value={run.runName} mono />
            {/* No Standard o clientTrackingId costuma ser igual ao nome do run;
                repetir o mesmo valor em duas linhas só ocupa espaço. */}
            {run.correlationId !== undefined && run.correlationId !== run.runName && (
              <Fact label="Correlation" value={run.correlationId} mono />
            )}
          </dl>
        </section>

        {recentRuns.length > 0 && (
          <section className="details__section">
            <h3 className="details__section-title">Recent workflow runs</h3>
            {/* Sucessos entram junto de propósito: é o que distingue uma falha
                isolada de um workflow quebrado há horas. */}
            <ul className="history">
              {recentRuns.map((entry) => (
                <HistoryRow key={entry.runId} entry={entry} />
              ))}
            </ul>
          </section>
        )}
      </div>

      <footer className="details__actions">
        <button
          type="button"
          className="details__action details__action--primary"
          onClick={() => void window.azmd.openRunInPortal(run.runId)}
          title={
            run.portalUrlIsFallback
              ? 'The portal has no per-run blade on Standard — this opens the history, with this run on top'
              : undefined
          }
        >
          {/* No Standard o portal só tem o histórico do workflow; prometer
              "este run" e entregar a lista seria mentir para o usuário. */}
          {run.portalUrlIsFallback ? 'Open history in portal' : 'Open run in portal'}
        </button>
        <button
          type="button"
          className="details__action"
          onClick={() => void window.azmd.openWorkflowInPortal(run.runId)}
        >
          View workflow
        </button>
      </footer>
    </section>
  )
}

function DetailsHeader({ onBack }: { readonly onBack: () => void }): React.JSX.Element {
  return (
    <div className="details__nav">
      <button type="button" className="link-button" onClick={onBack}>
        ‹ Back
      </button>
    </div>
  )
}

/** O payload cru fica escondido por padrão: é ruído até você precisar dele. */
function RawErrorDisclosure({ raw }: { readonly raw: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="details__raw">
      <button
        type="button"
        className="link-button link-button--small"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? 'Hide Azure response' : 'View Azure response'}
      </button>
      {open && <pre className="details__raw-body">{raw}</pre>}
    </div>
  )
}

function HistoryRow({ entry }: { readonly entry: WorkflowRunSummary }): React.JSX.Element {
  return (
    <li className={`history__row${entry.isCurrent ? ' history__row--current' : ''}`}>
      <StatusDot status={entry.status} />
      <span className="history__status">{translateStatus(entry.status)}</span>
      <span className="history__time">{formatRelativeTime(entry.startTime)}</span>
      {entry.isCurrent && <span className="history__current-tag">this one</span>}
    </li>
  )
}

function Fact({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}): React.JSX.Element {
  return (
    <div className="details__fact">
      <dt className="details__fact-label">{label}</dt>
      <dd className={`details__fact-value${mono ? ' details__fact-value--mono' : ''}`}>{value}</dd>
    </div>
  )
}

function StatusBadge({ status }: { readonly status: RunStatus }): React.JSX.Element {
  return (
    <span className={`status-badge status-badge--${statusTone(status)}`}>
      {translateStatus(status)}
    </span>
  )
}

function StatusDot({ status }: { readonly status: RunStatus }): React.JSX.Element {
  return <span className={`history__dot history__dot--${statusTone(status)}`} aria-hidden="true" />
}

type StatusTone = 'failure' | 'success' | 'running' | 'neutral'

function statusTone(status: RunStatus): StatusTone {
  switch (status) {
    case 'Failed':
    case 'TimedOut':
    case 'Aborted':
      return 'failure'
    case 'Succeeded':
      return 'success'
    case 'Running':
    case 'Waiting':
      return 'running'
    default:
      return 'neutral'
  }
}

function translateStatus(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    Succeeded: 'Succeeded',
    Failed: 'Failed',
    Cancelled: 'Cancelled',
    Running: 'Running',
    Waiting: 'Waiting',
    Suspended: 'Suspended',
    TimedOut: 'Timed out',
    Skipped: 'Skipped',
    Aborted: 'Aborted',
    Unknown: 'Unknown',
  }
  return labels[status]
}

function formatAbsolute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}min ${rest}s`
}
