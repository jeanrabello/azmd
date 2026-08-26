import type { HealthStatus, LogicAppSummary, WorkflowSummary } from '../../shared/types.js'
import { formatRelativeTime } from '../lib/time.js'

interface WorkflowListProps {
  readonly logicApp: LogicAppSummary
  readonly workflows: readonly WorkflowSummary[]
  readonly onBack: () => void
  readonly onSelectWorkflow: (workflowResourceId: string) => void
}

/**
 * Segundo nível da hierarquia: os workflows dentro de um Logic App já
 * selecionado. Mesma estrutura de linha da lista de Logic Apps, um nível
 * mais fundo.
 */
export default function WorkflowList({
  logicApp,
  workflows,
  onBack,
  onSelectWorkflow,
}: WorkflowListProps): React.JSX.Element {
  return (
    <section className="details">
      <div className="details__nav">
        <button type="button" className="link-button" onClick={onBack}>
          ‹ Voltar
        </button>
      </div>

      <header className="list-header">
        <h2 className="list-header__title">{logicApp.group.name}</h2>
        <p className="list-header__subtitle">
          {/* Sem o GUID da subscription: ocupa a linha inteira e não é o que
              identifica o Logic App no dia a dia. */}
          {logicApp.group.resourceGroup}
          {logicApp.group.siteName ? ` · ${logicApp.group.kind === 'standard' ? 'App Service' : ''}` : ''}
        </p>
      </header>

      <div className="details__scroll">
        {workflows.length === 0 ? (
          <p className="details__placeholder">Nenhum workflow neste Logic App</p>
        ) : (
          <ul className="run-list">
            {workflows.map((workflow) => (
              <WorkflowRow key={workflow.resourceId} workflow={workflow} onSelect={onSelectWorkflow} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function WorkflowRow({
  workflow,
  onSelect,
}: {
  readonly workflow: WorkflowSummary
  readonly onSelect: (workflowResourceId: string) => void
}): React.JSX.Element {
  const { resourceId, health, watched } = workflow

  function handleOpenRuns(): void {
    onSelect(resourceId)
  }

  function handleToggleWatch(event: React.MouseEvent): void {
    event.stopPropagation()
    void window.azmd.setWorkflowWatched(resourceId, !watched)
  }

  function handleOpenPortal(event: React.MouseEvent): void {
    event.stopPropagation()
    void window.azmd.openWorkflowResourceInPortal(resourceId)
  }

  const watchLabel = watched ? 'Parar de monitorar' : 'Voltar a monitorar'

  return (
    <li className="run-row">
      <button
        type="button"
        className="run-row__main"
        onClick={handleOpenRuns}
        aria-label={`Ver falhas de ${workflow.name}`}
      >
        <div className="run-row__top">
          <HealthDot health={health} />
          <span className={`run-row__name${watched ? '' : ' run-row__name--dimmed'}`}>
            {workflow.name}
          </span>
        </div>
        <div className="run-row__bottom">
          {health === 'failing' ? (
            <>
              <span className="count-pill">{workflow.failedRunCount}</span>
              {workflow.lastFailureAt !== undefined && (
                <span className="run-row__time">{formatRelativeTime(workflow.lastFailureAt)}</span>
              )}
            </>
          ) : (
            <span className="run-row__error">{describeWorkflow(workflow)}</span>
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
          aria-label={`${watchLabel} ${workflow.name}`}
          title={watchLabel}
        >
          <EyeIcon slashed={!watched} />
        </button>

        <button
          type="button"
          className="run-row__action"
          onClick={handleOpenPortal}
          aria-label={`Abrir ${workflow.name} no portal`}
          title="Abrir no portal"
        >
          <ExternalLinkIcon />
        </button>
      </div>
    </li>
  )
}

/** Só chamada para 'unwatched'/'healthy' — 'failing' usa o pill de contagem em vez de texto. */
function describeWorkflow(workflow: WorkflowSummary): string {
  return workflow.health === 'unwatched' ? 'Não monitorado' : 'Sem falhas'
}

function HealthDot({ health }: { readonly health: HealthStatus }): React.JSX.Element {
  return <span className={`health-dot health-dot--${health}`} aria-hidden="true" />
}

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
