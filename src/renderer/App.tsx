import { useEffect, useState } from 'react'
import type { AppState } from '../shared/types.js'
import Header from './components/Header'
import RunList from './components/RunList'
import EmptyState from './components/EmptyState'
import ErrorState from './components/ErrorState'
import SettingsPanel from './components/SettingsPanel'
import RunDetailsPanel from './components/RunDetailsPanel'
import Footer from './components/Footer'

/** Vistas possíveis do popover. Mantido simples de propósito: não é um router. */
type View = { kind: 'runs' } | { kind: 'settings' } | { kind: 'details'; runId: string }

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>({ kind: 'runs' })

  useEffect(() => {
    let cancelled = false

    window.runbar.getState().then((initial) => {
      if (!cancelled) {
        setState(initial)
      }
    })

    // onStateChanged devolve a função de unsubscribe — precisa ser chamada no
    // cleanup, senão o listener sobrevive a remounts (StrictMode duplica isso).
    const unsubscribe = window.runbar.onStateChanged((next) => {
      setState(next)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Se o run em detalhe sai da lista — descartado, ou o modo mudou — a tela
  // ficaria presa num run que não existe mais. Volta para a listagem.
  const detailRunMissing =
    view.kind === 'details' && state !== null && !state.runs.some((r) => r.runId === view.runId)

  useEffect(() => {
    if (detailRunMissing) setView({ kind: 'runs' })
  }, [detailRunMissing])

  if (!state) {
    // Ainda não recebemos o primeiro snapshot — evita piscar um estado vazio.
    return (
      <div className="app app--loading">
        <div className="loading-indicator" aria-label="Carregando" />
      </div>
    )
  }

  const { runs, connection, settings } = state

  return (
    <div className="app">
      <Header
        connection={connection}
        settings={settings}
        onToggleSettings={() =>
          setView(view.kind === 'settings' ? { kind: 'runs' } : { kind: 'settings' })
        }
        settingsOpen={view.kind === 'settings'}
      />

      <main className="app-content">
        {view.kind === 'settings' ? (
          <SettingsPanel settings={settings} onBack={() => setView({ kind: 'runs' })} />
        ) : view.kind === 'details' ? (
          <RunDetailsPanel runId={view.runId} onBack={() => setView({ kind: 'runs' })} />
        ) : connection.kind === 'error' ? (
          <ErrorState error={connection.error} />
        ) : runs.length === 0 ? (
          <EmptyState />
        ) : (
          <RunList runs={runs} onSelectRun={(runId) => setView({ kind: 'details', runId })} />
        )}
      </main>

      <Footer runCount={runs.length} />
    </div>
  )
}
