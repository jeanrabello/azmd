import { useEffect, useState } from 'react'
import type { ConnectionState, Settings } from '../../shared/types.js'
import { formatRelativeTime } from '../lib/time.js'

interface HeaderProps {
  readonly connection: ConnectionState
  readonly settings: Settings
  readonly settingsOpen: boolean
  readonly onToggleSettings: () => void
}

/** Cor semântica do dot de status — não usa vermelho/verde de marca, e sim os
 * equivalentes nativos (systemGreen/systemRed/systemYellow/gray). */
function statusModifier(connection: ConnectionState): string {
  switch (connection.kind) {
    case 'ok':
      return 'status-dot--ok'
    case 'connecting':
      return 'status-dot--connecting'
    case 'error':
      return 'status-dot--error'
    case 'idle':
      return 'status-dot--idle'
  }
}

function statusLabel(connection: ConnectionState): string {
  switch (connection.kind) {
    case 'ok':
      return 'Conectado'
    case 'connecting':
      return 'Conectando…'
    case 'error':
      return 'Erro de conexão'
    case 'idle':
      return 'Ocioso'
  }
}

export default function Header({
  connection,
  settings,
  settingsOpen,
  onToggleSettings,
}: HeaderProps): React.JSX.Element {
  // Força um re-render por minuto para o texto relativo não ficar parado.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const lastSyncedAt = connection.kind === 'ok' || connection.kind === 'error' ? connection.lastSyncedAt : undefined

  const [refreshing, setRefreshing] = useState(false)

  function handleRefresh(): void {
    setRefreshing(true)
    window.runbar
      .refreshNow()
      .finally(() => setRefreshing(false))
  }

  return (
    <header className="app-header">
      <div className="app-header__title-row">
        <span
          className={`status-dot ${statusModifier(connection)}`}
          role="status"
          aria-label={statusLabel(connection)}
          title={statusLabel(connection)}
        />
        <h1 className="app-header__title">Runbar</h1>
        {settings.mode === 'demo' && (
          <span className="demo-badge" title="Exibindo dados de exemplo, não dados reais do Azure">
            DEMO
          </span>
        )}
      </div>

      <div className="app-header__actions">
        <span className="app-header__updated">
          {lastSyncedAt ? `atualizado ${formatRelativeTime(lastSyncedAt)}` : 'sem sincronização ainda'}
        </span>

        <button
          type="button"
          className="icon-button"
          onClick={handleRefresh}
          disabled={refreshing || connection.kind === 'connecting'}
          aria-label="Atualizar agora"
          title="Atualizar agora"
        >
          <RefreshIcon spinning={refreshing || connection.kind === 'connecting'} />
        </button>

        <button
          type="button"
          className={`icon-button ${settingsOpen ? 'icon-button--active' : ''}`}
          onClick={onToggleSettings}
          aria-label="Configurações"
          aria-pressed={settingsOpen}
          title="Configurações"
        >
          <GearIcon />
        </button>
      </div>
    </header>
  )
}

function RefreshIcon({ spinning }: { readonly spinning: boolean }): React.JSX.Element {
  return (
    <svg
      className={spinning ? 'spin' : ''}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.65-3.93M13.5 2v3.5H10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M12.9 8.9v-1.8l1.2-.9-.9-1.6-1.4.5c-.35-.32-.75-.58-1.2-.76L10.3 2.6H8.7l-.3 1.75c-.45.18-.85.44-1.2.76l-1.4-.5-.9 1.6 1.2.9v1.8l-1.2.9.9 1.6 1.4-.5c.35.32.75.58 1.2.76l.3 1.75h1.6l.3-1.75c.45-.18.85-.44 1.2-.76l1.4.5.9-1.6-1.2-.9Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  )
}
