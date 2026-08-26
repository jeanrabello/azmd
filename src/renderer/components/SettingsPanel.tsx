import type { DataSourceMode, Settings } from '../../shared/types.js'
import { LOOKBACK_BOUNDS, POLL_INTERVAL_BOUNDS } from '../../shared/types.js'

interface SettingsPanelProps {
  readonly settings: Settings
  readonly onBack: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export default function SettingsPanel({ settings, onBack }: SettingsPanelProps): React.JSX.Element {
  function patch(update: Partial<Settings>): void {
    window.runbar.updateSettings(update)
  }

  function handleModeChange(mode: DataSourceMode): void {
    patch({ mode })
  }

  function handlePollChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const value = clamp(Number(event.target.value), POLL_INTERVAL_BOUNDS.min, POLL_INTERVAL_BOUNDS.max)
    patch({ pollIntervalSeconds: value })
  }

  function handleLookbackChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const value = clamp(Number(event.target.value), LOOKBACK_BOUNDS.min, LOOKBACK_BOUNDS.max)
    patch({ lookbackHours: value })
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <button type="button" className="link-button" onClick={onBack}>
          ‹ Voltar
        </button>
      </div>

      <section className="settings-section">
        <h2 className="settings-section__title">Fonte de dados</h2>
        <div className="mode-toggle" role="group" aria-label="Fonte de dados">
          <button
            type="button"
            className={`mode-toggle__option ${settings.mode === 'azure' ? 'mode-toggle__option--active' : ''}`}
            onClick={() => handleModeChange('azure')}
            aria-pressed={settings.mode === 'azure'}
          >
            Azure (dados reais)
          </button>
          <button
            type="button"
            className={`mode-toggle__option ${settings.mode === 'demo' ? 'mode-toggle__option--active' : ''}`}
            onClick={() => handleModeChange('demo')}
            aria-pressed={settings.mode === 'demo'}
          >
            Demo (dados de exemplo)
          </button>
        </div>
        <p className="settings-caption">
          {settings.mode === 'demo'
            ? 'O modo demo exibe runs falhos fictícios para você explorar o app sem uma assinatura do Azure conectada.'
            : 'Consulta diretamente os Logic Apps da sua assinatura Azure configurada.'}
        </p>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Sincronização</h2>

        <label className="settings-row" htmlFor="poll-interval">
          <span>Intervalo de checagem</span>
          <span className="settings-row__value">{settings.pollIntervalSeconds}s</span>
        </label>
        <input
          id="poll-interval"
          type="range"
          min={POLL_INTERVAL_BOUNDS.min}
          max={POLL_INTERVAL_BOUNDS.max}
          value={settings.pollIntervalSeconds}
          onChange={handlePollChange}
        />

        <label className="settings-row" htmlFor="lookback-hours">
          <span>Janela de retrospecto</span>
          <span className="settings-row__value">{settings.lookbackHours}h</span>
        </label>
        <input
          id="lookback-hours"
          type="range"
          min={LOOKBACK_BOUNDS.min}
          max={LOOKBACK_BOUNDS.max}
          value={settings.lookbackHours}
          onChange={handleLookbackChange}
        />
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Preferências</h2>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.notificationsEnabled}
            onChange={(e) => patch({ notificationsEnabled: e.target.checked })}
          />
          <span>Notificações</span>
        </label>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => patch({ launchAtLogin: e.target.checked })}
          />
          <span>Iniciar com o login</span>
        </label>
      </section>
    </div>
  )
}
