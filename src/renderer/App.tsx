import { useEffect, useState } from 'react'
import type { AppState } from '../shared/types.js'
import Header from './components/Header'
import EmptyState from './components/EmptyState'
import ErrorState from './components/ErrorState'
import SettingsPanel from './components/SettingsPanel'
import RunDetailsPanel from './components/RunDetailsPanel'
import LogicAppList from './components/LogicAppList'
import WorkflowList from './components/WorkflowList'
import WorkflowRuns from './components/WorkflowRuns'
import Footer from './components/Footer'

/**
 * Vistas possíveis do popover. Mantido simples de propósito: não é um router.
 *
 * A navegação é uma pilha rasa: Logic Apps -> workflows -> runs -> detalhe.
 * Guardamos os IDs, não os objetos, para que a vista sempre reflita o estado
 * mais recente vindo do main em vez de um snapshot congelado no clique.
 */
type View =
  | { kind: 'logicApps' }
  | { kind: 'workflows'; logicAppId: string }
  | { kind: 'workflowRuns'; logicAppId: string; workflowResourceId: string }
  | { kind: 'details'; runId: string; from: View }
  | { kind: 'settings' }

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>({ kind: 'logicApps' })

  useEffect(() => {
    let cancelled = false

    window.azmd.getState().then((initial) => {
      if (!cancelled) {
        setState(initial)
      }
    })

    // onStateChanged devolve a função de unsubscribe — precisa ser chamada no
    // cleanup, senão o listener sobrevive a remounts (StrictMode duplica isso).
    const unsubscribe = window.azmd.onStateChanged((next) => {
      setState(next)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Se o alvo da vista some — run descartado, Logic App que sumiu do
  // inventário, troca de modo — a tela ficaria presa em algo inexistente.
  const viewTargetMissing =
    state !== null &&
    ((view.kind === 'details' && !state.runs.some((r) => r.runId === view.runId)) ||
      (view.kind === 'workflows' &&
        !state.logicApps.some((a) => a.group.id === view.logicAppId)) ||
      (view.kind === 'workflowRuns' &&
        !state.workflows.some((w) => w.resourceId === view.workflowResourceId)))

  useEffect(() => {
    if (viewTargetMissing) setView({ kind: 'logicApps' })
  }, [viewTargetMissing])

  /*
   * O tema vem resolvido do main, não do `prefers-color-scheme`.
   *
   * Marcá-lo no <html> faz o CSS usar os tokens certos mesmo quando o usuário
   * força claro num sistema escuro — a media query sozinha ignoraria a
   * preferência. O atributo é sempre explícito ('light' ou 'dark'), então as
   * regras `:root[data-theme=...]` vencem a media query nos dois sentidos.
   */
  const resolvedTheme = state?.resolvedTheme
  useEffect(() => {
    if (resolvedTheme) document.documentElement.dataset['theme'] = resolvedTheme
  }, [resolvedTheme])

  if (!state) {
    // Ainda não recebemos o primeiro snapshot — evita piscar um estado vazio.
    return (
      <div className="app app--loading">
        <div className="loading-indicator" aria-label="Loading" />
      </div>
    )
  }

  const { runs, logicApps, workflows, connection, settings } = state

  return (
    <div className="app">
      <Header
        connection={connection}
        settings={settings}
        onToggleSettings={() =>
          setView(view.kind === 'settings' ? { kind: 'logicApps' } : { kind: 'settings' })
        }
        settingsOpen={view.kind === 'settings'}
      />

      <main className="app-content">
        {renderContent()}
      </main>

      <Footer runCount={runs.length} />
    </div>
  )

  function renderContent(): React.JSX.Element {
    if (view.kind === 'settings') {
      return <SettingsPanel settings={settings} onBack={() => setView({ kind: 'logicApps' })} />
    }

    if (view.kind === 'details') {
      // Volta para onde o usuário estava, não para a raiz.
      const back = view.from
      return <RunDetailsPanel runId={view.runId} onBack={() => setView(back)} />
    }

    // O erro de conexão vale para qualquer nível da navegação.
    if (connection.kind === 'error') return <ErrorState error={connection.error} />

    if (view.kind === 'workflows') {
      const logicApp = logicApps.find((app) => app.group.id === view.logicAppId)
      if (!logicApp) return <EmptyState />
      return (
        <WorkflowList
          logicApp={logicApp}
          workflows={workflows.filter((w) => w.logicAppId === logicApp.group.id)}
          onBack={() => setView({ kind: 'logicApps' })}
          onSelectWorkflow={(workflowResourceId) =>
            setView({ kind: 'workflowRuns', logicAppId: logicApp.group.id, workflowResourceId })
          }
        />
      )
    }

    if (view.kind === 'workflowRuns') {
      const workflow = workflows.find((w) => w.resourceId === view.workflowResourceId)
      if (!workflow) return <EmptyState />
      const current = view
      return (
        <WorkflowRuns
          workflow={workflow}
          runs={runs.filter((run) => run.workflowResourceId === workflow.resourceId)}
          onBack={() => setView({ kind: 'workflows', logicAppId: current.logicAppId })}
          onSelectRun={(runId) => setView({ kind: 'details', runId, from: current })}
        />
      )
    }

    return <LogicAppList logicApps={logicApps} onSelect={(logicAppId) => setView({ kind: 'workflows', logicAppId })} />
  }
}
