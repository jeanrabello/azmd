import { useEffect, useState } from 'react'
import type { ConnectionState, Settings } from '../../shared/types.js'
import { formatSyncAge } from '../lib/time.js'

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
      return 'Connected'
    case 'connecting':
      return 'Connecting…'
    case 'error':
      return 'Connection error'
    case 'idle':
      return 'Idle'
  }
}

export default function Header({
  connection,
  settings,
  settingsOpen,
  onToggleSettings,
}: HeaderProps): React.JSX.Element {
  const lastSyncedAt =
    connection.kind === 'ok' || connection.kind === 'error' ? connection.lastSyncedAt : undefined

  /*
   * Tick de 1s enquanto a idade é contada em segundos, 30s depois disso.
   *
   * O intervalo de polling pode ser menor que um minuto, então um tick de
   * 60s deixaria o texto travado — era isso que fazia a tela dizer sempre
   * "atualizado agora". Passado o primeiro minuto, a granularidade cai para
   * minutos e não há motivo para acordar a cada segundo.
   */
  const [, setTick] = useState(0)
  const ageMs = lastSyncedAt ? Date.now() - Date.parse(lastSyncedAt) : 0
  const tickMs = ageMs < 60_000 ? 1_000 : 30_000
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), tickMs)
    return () => clearInterval(id)
  }, [tickMs])

  const [refreshing, setRefreshing] = useState(false)

  function handleRefresh(): void {
    setRefreshing(true)
    window.azmd
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
        <h1 className="app-header__title">azmd</h1>
        {settings.mode === 'demo' && (
          <span className="demo-badge" title="Showing sample data, not real Azure data">
            DEMO
          </span>
        )}
      </div>

      <div className="app-header__actions">
        <span className="app-header__updated">
          {lastSyncedAt
            ? `${connection.kind === 'error' ? 'data from' : 'updated'} ${formatSyncAge(lastSyncedAt)}`
            : 'not synced yet'}
        </span>

        <button
          type="button"
          className="icon-button"
          onClick={handleRefresh}
          disabled={refreshing || connection.kind === 'connecting'}
          aria-label="Refresh now"
          title="Refresh now"
        >
          <RefreshIcon spinning={refreshing || connection.kind === 'connecting'} />
        </button>

        <button
          type="button"
          className={`icon-button ${settingsOpen ? 'icon-button--active' : ''}`}
          onClick={onToggleSettings}
          aria-label="Settings"
          aria-pressed={settingsOpen}
          title="Settings"
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
