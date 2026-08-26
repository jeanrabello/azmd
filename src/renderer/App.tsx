import { useEffect, useState } from 'react'
import type { AppState } from '../shared/types.js'
import Header from './components/Header'
import RunList from './components/RunList'
import EmptyState from './components/EmptyState'
import ErrorState from './components/ErrorState'
import SettingsPanel from './components/SettingsPanel'
import Footer from './components/Footer'

/** Vistas possíveis do popover. Mantido simples de propósito: não é um router. */
type View = 'runs' | 'settings'

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>('runs')

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
        onToggleSettings={() => setView(view === 'settings' ? 'runs' : 'settings')}
        settingsOpen={view === 'settings'}
      />

      <main className="app-content">
        {view === 'settings' ? (
          <SettingsPanel settings={settings} onBack={() => setView('runs')} />
        ) : connection.kind === 'error' ? (
          <ErrorState error={connection.error} />
        ) : runs.length === 0 ? (
          <EmptyState />
        ) : (
          <RunList runs={runs} />
        )}
      </main>

      <Footer runCount={runs.length} />
    </div>
  )
}
