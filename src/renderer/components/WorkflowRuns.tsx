import type { FailedRun, WorkflowSummary } from '../../shared/types.js'
import RunList from './RunList'

interface WorkflowRunsProps {
  readonly workflow: WorkflowSummary
  readonly runs: readonly FailedRun[]
  readonly onBack: () => void
  readonly onSelectRun: (runId: string) => void
}

/**
 * Terceiro e último nível da hierarquia: as falhas de UM workflow. `runs` já
 * chega filtrado pelo chamador — aqui só cuidamos do cabeçalho e reusamos
 * `RunList` para o corpo, para não duplicar a linha de run em dois lugares.
 */
export default function WorkflowRuns({
  workflow,
  runs,
  onBack,
  onSelectRun,
}: WorkflowRunsProps): React.JSX.Element {
  return (
    <section className="details">
      <div className="details__nav">
        <button type="button" className="link-button" onClick={onBack}>
          ‹ Back
        </button>
      </div>

      <header className="list-header">
        <h2 className="list-header__title">{workflow.name}</h2>
      </header>

      <div className="details__scroll">
        {runs.length === 0 ? (
          <p className="details__placeholder">No failures in this workflow in the last few hours</p>
        ) : (
          <RunList runs={runs} onSelectRun={onSelectRun} hideWorkflowName />
        )}
      </div>
    </section>
  )
}
