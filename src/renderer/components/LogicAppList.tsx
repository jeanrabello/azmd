import type { HealthStatus, LogicAppSummary } from '../../shared/types.js'
import { formatRelativeTime } from '../lib/time.js'

interface LogicAppListProps {
  readonly logicApps: readonly LogicAppSummary[]
  readonly onSelect: (logicAppId: string) => void
}

/**
 * Nível raiz da hierarquia: um Logic App (Standard) ou resource group agrupado
 * (Consumption) por linha. Selecionar uma linha drilla para os workflows dele.
 */
export default function LogicAppList({
  logicApps,
  onSelect,
}: LogicAppListProps): React.JSX.Element {
  if (logicApps.length === 0) {
    return <p className="details__placeholder">Nenhum Logic App encontrado</p>
  }

  return (
    <ul className="run-list">
      {logicApps.map((logicApp) => (
        <LogicAppRow key={logicApp.group.id} logicApp={logicApp} onSelect={onSelect} />
      ))}
    </ul>
  )
}

function LogicAppRow({
  logicApp,
  onSelect,
}: {
  readonly logicApp: LogicAppSummary
  readonly onSelect: (logicAppId: string) => void
}): React.JSX.Element {
  const { group, health, watched } = logicApp

  function handleOpenWorkflows(): void {
    onSelect(group.id)
  }

  function handleToggleWatch(event: React.MouseEvent): void {
    event.stopPropagation()
    void window.runbar.setLogicAppWatched(group.id, !watched)
  }

  function handleOpenPortal(event: React.MouseEvent): void {
    event.stopPropagation()
    void window.runbar.openLogicAppInPortal(group.id)
  }

  const watchLabel = watched ? 'Parar de monitorar' : 'Voltar a monitorar'

  return (
    <li className="run-row">
      <button
        type="button"
        className="run-row__main"
        onClick={handleOpenWorkflows}
        aria-label={`Ver workflows de ${group.name}`}
      >
        <div className="run-row__top">
          <HealthDot health={health} />
          <span className={`run-row__name${watched ? '' : ' run-row__name--dimmed'}`}>
            {group.name}
          </span>
          <span className={`kind-badge kind-badge--${group.kind}`}>
            {group.kind === 'consumption' ? 'Consumption' : 'Standard'}
          </span>
        </div>
        <div className="run-row__bottom">
          <span className="run-row__error">{describeLogicApp(logicApp)}</span>
          {health === 'failing' && (
            <>
              <span className="count-pill">{logicApp.failedRunCount}</span>
              {logicApp.lastFailureAt !== undefined && (
                <span className="run-row__time">{formatRelativeTime(logicApp.lastFailureAt)}</span>
              )}
            </>
          )}
          <span className="run-row__chevron" aria-hidden="true">
            ›
          </span>
        </div>
      </button>

      <div className="run-row__actions">
        <button
          type="button"
          className="run-row__action"
          onClick={handleToggleWatch}
          aria-label={`${watchLabel} ${group.name}`}
          title={watchLabel}
        >
          <EyeIcon slashed={!watched} />
        </button>

        <button
          type="button"
          className="run-row__action"
          onClick={handleOpenPortal}
          aria-label={`Abrir ${group.name} no portal`}
          title="Abrir no portal"
        >
          <ExternalLinkIcon />
        </button>
      </div>
    </li>
  )
}

/** Monta a linha secundária: contagem de workflows falhando, saudáveis ou "não monitorado". */
function describeLogicApp(logicApp: LogicAppSummary): string {
  const { health, failingWorkflowCount, totalWorkflowCount } = logicApp

  if (health === 'unwatched') {
    return 'Não monitorado'
  }

  if (health === 'failing') {
    return `${failingWorkflowCount} de ${totalWorkflowCount} ${pluralWorkflows(totalWorkflowCount)} falhando`
  }

  return `${totalWorkflowCount} ${pluralWorkflows(totalWorkflowCount)}`
}

function pluralWorkflows(count: number): string {
  return count === 1 ? 'workflow' : 'workflows'
}

function HealthDot({ health }: { readonly health: HealthStatus }): React.JSX.Element {
  return <span className={`health-dot health-dot--${health}`} aria-hidden="true" />
}

/* Glifos desenhados em vez de emoji, para acompanhar a cor do tema. */

/** Olho aberto = monitorado; olho riscado = ignorado. O clique inverte o estado. */
function EyeIcon({ slashed }: { readonly slashed: boolean }): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M1 6s1.8-3.5 5-3.5S11 6 11 6s-1.8 3.5-5 3.5S1 6 1 6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="6" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {slashed && (
        <line x1="1.5" y1="10" x2="10.5" y2="1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      )}
    </svg>
  )
}

function ExternalLinkIcon(): React.JSX.Element {
  return (
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
  )
}
