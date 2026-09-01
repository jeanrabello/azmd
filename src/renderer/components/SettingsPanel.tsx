import { useEffect, useState } from 'react'
import type {
  AuthConfigPatch,
  AuthFlowState,
  AuthMode,
  DataSourceMode,
  Settings,
  Theme,
} from '../../shared/types.js'
import { LOOKBACK_BOUNDS, POLL_INTERVAL_BOUNDS } from '../../shared/types.js'

interface SettingsPanelProps {
  readonly settings: Settings
  readonly onBack: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const THEME_LABELS: Readonly<Record<Theme, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const AUTH_MODE_LABELS: Readonly<Record<AuthMode, string>> = {
  deviceCode: 'My account',
  servicePrincipal: 'Service Principal',
  azureCli: 'Azure CLI',
}

export default function SettingsPanel({ settings, onBack }: SettingsPanelProps): React.JSX.Element {
  const auth = settings.auth

  // O fluxo de device code é assíncrono e dirigido pelo main; o renderer só
  // reflete o último estado que chegou.
  const [flow, setFlow] = useState<AuthFlowState>({ kind: 'idle' })
  const [codeCopied, setCodeCopied] = useState(false)
  /** O main recusou abrir a URL — a UI oferece o caminho manual. */
  const [openFailed, setOpenFailed] = useState(false)
  const [uriCopied, setUriCopied] = useState(false)

  // Campos do service principal ficam em estado local de propósito: os sliders
  // podem gravar a cada tecla, auth não — cada caractere digitado viraria uma
  // tentativa de login. Só o botão "Salvar" persiste.
  const [tenantId, setTenantId] = useState(auth.tenantId ?? '')
  const [clientId, setClientId] = useState(auth.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [saved, setSaved] = useState(false)
  /** Resultado do último teste de notificação. `undefined` = nunca testado. */
  const [testResult, setTestResult] = useState<'sent' | 'blocked' | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = window.azmd.onAuthFlowChanged((next) => {
      setFlow(next)
      // Todo estado efêmero do fluxo anterior morre aqui: um "copiado" ou um
      // aviso de falha vindos da tentativa passada mentiriam sobre a nova.
      setCodeCopied(false)
      setUriCopied(false)
      setOpenFailed(false)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  function patch(update: Partial<Settings>): void {
    window.azmd.updateSettings(update)
  }

  function handleTestNotification(): void {
    setTestResult(undefined)
    void window.azmd.testNotification().then((shown) => {
      setTestResult(shown ? 'sent' : 'blocked')
    })
  }

  function patchAuth(update: AuthConfigPatch): void {
    window.azmd.updateAuthConfig(update)
  }

  function handleAuthModeChange(mode: AuthMode): void {
    // Trocar de modo é uma escolha deliberada e única, não digitação — pode
    // gravar na hora, ao contrário dos campos do formulário abaixo.
    patchAuth({ mode })
    setFlow({ kind: 'idle' })
  }

  function handleSignIn(): void {
    setFlow({ kind: 'starting' })
    void window.azmd.authSignIn().then(setFlow)
  }

  function handleSignOut(): void {
    setFlow({ kind: 'idle' })
    void window.azmd.authSignOut()
  }

  function handleCopyCode(code: string): void {
    void navigator.clipboard.writeText(code).then(() => {
      setCodeCopied(true)
    })
  }

  /**
   * Copia o endereço da página de login.
   *
   * Só aparece quando o navegador não abriu: nesse caso o usuário precisa levar
   * a URL para outro lugar na mão, e selecionar texto num popover que fecha ao
   * perder o foco é justamente o que não funciona bem.
   */
  function handleCopyUri(uri: string): void {
    void navigator.clipboard.writeText(uri).then(() => {
      setUriCopied(true)
    })
  }

  function handleSaveServicePrincipal(): void {
    // Secret vazio significa "não mexer": o main guarda o que já tem e nunca
    // devolve o valor, então um campo em branco não pode apagar nada.
    patchAuth({
      mode: 'servicePrincipal',
      tenantId: tenantId.trim(),
      clientId: clientId.trim(),
      ...(clientSecret ? { clientSecret } : {}),
    })
    setClientSecret('')
    setSaved(true)
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
          ‹ Back
        </button>
      </div>

      {/* Auth vem primeiro porque é pré-requisito de todo o resto: sem
        * credencial válida nenhuma das outras opções tem efeito. */}
      <section className="settings-section">
        <h2 className="settings-section__title">Authentication</h2>
        <div
          className="mode-toggle mode-toggle--stacked"
          role="group"
          aria-label="Authentication mode"
        >
          {(Object.keys(AUTH_MODE_LABELS) as readonly AuthMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`mode-toggle__option ${auth.mode === mode ? 'mode-toggle__option--active' : ''}`}
              onClick={() => handleAuthModeChange(mode)}
              aria-pressed={auth.mode === mode}
            >
              {AUTH_MODE_LABELS[mode]}
            </button>
          ))}
        </div>

        {auth.mode === 'deviceCode' && (
          <div className="auth-block">
            {/* Ter conta não é ter sessão: o AuthenticationRecord sobrevive ao
              * restart, mas o refresh token vive só em memória. Por isso a ação
              * de entrar fica sempre disponível — sem ela, quem reabre o app com
              * token expirado veria a conta certa e nenhuma saída. */}
            {auth.account && (
              <div className="auth-account">
                <span className="auth-account__name">{auth.account.username}</span>
                <button
                  type="button"
                  className="link-button link-button--small"
                  onClick={handleSignOut}
                >
                  Sign out
                </button>
              </div>
            )}

            <button
              type="button"
              className={`auth-button ${auth.account ? '' : 'auth-button--primary'}`}
              onClick={handleSignIn}
              disabled={flow.kind === 'starting' || flow.kind === 'prompt'}
            >
              {flow.kind === 'starting'
                ? 'Opening login…'
                : auth.account
                  ? 'Sign in again'
                  : 'Sign in with my account'}
            </button>

            {/* O código é o elemento mais importante da tela enquanto o fluxo
              * está aberto: o usuário precisa lê-lo e digitá-lo em outro lugar. */}
            {flow.kind === 'prompt' && (
              <div className="auth-prompt">
                <p className="auth-prompt__label">Enter this code on the login page:</p>
                <p className="auth-prompt__code">{flow.userCode}</p>
                <div className="auth-prompt__actions">
                  <button
                    type="button"
                    className="auth-button"
                    onClick={() => handleCopyCode(flow.userCode)}
                  >
                    {codeCopied ? 'Code copied' : 'Copy code'}
                  </button>
                  <button
                    type="button"
                    className="auth-button"
                    onClick={() => {
                      /*
                       * O erro não pode ser engolido. A allowlist do main pode
                       * recusar a URL (o host do `verificationUri` vem do
                       * Entra e já mudou uma vez), e com `void` a rejeição
                       * virava um botão que não faz nada — sem pista nenhuma
                       * para quem clicou. Mostrar o aviso deixa a URL ao lado
                       * como caminho manual.
                       */
                      window.azmd
                        .openDeviceLoginUrl(flow.verificationUri)
                        // Deu certo numa segunda tentativa: o aviso e o botão
                        // de copiar somem, senão ficariam presos na tela
                        // contradizendo o que acabou de acontecer.
                        .then(() => setOpenFailed(false))
                        .catch(() => setOpenFailed(true))
                    }}
                  >
                    Open login page
                  </button>
                </div>
                {/* A URL fica visível e selecionável como alternativa: se o
                  * navegador não abrir, o usuário ainda consegue chegar lá. */}
                <div className="auth-prompt__uri-row">
                  <p className="auth-prompt__uri">{flow.verificationUri}</p>
                  {/* Só de ícone, e só quando abrir falhou: enquanto o botão
                    * "Abrir página de login" funciona, copiar a URL é ruído. */}
                  {openFailed && (
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => handleCopyUri(flow.verificationUri)}
                      title={uriCopied ? 'Address copied' : 'Copy address'}
                      aria-label={uriCopied ? 'Address copied' : 'Copy address'}
                    >
                      {/* aria-hidden: quem lê tela já recebe o aria-label do
                        * botão; anunciar o ícone de novo seria repetição. */}
                      {uriCopied ? (
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <path
                            d="M3.5 8.5l3 3 6-6.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <rect
                            x="5.75"
                            y="5.75"
                            width="7.5"
                            height="7.5"
                            rx="1.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                          />
                          <path
                            d="M10.25 3.75A1.5 1.5 0 008.75 2.25h-5A1.5 1.5 0 002.25 3.75v5a1.5 1.5 0 001.5 1.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
                {openFailed && (
                  <p className="auth-prompt__warning">
                    Could not open the browser. Copy the address and open it manually.
                  </p>
                )}
              </div>
            )}

            {flow.kind === 'error' && (
              <div className="auth-error">
                <p className="auth-error__message">{flow.message}</p>
                <button type="button" className="auth-button" onClick={handleSignIn}>
                  Try again
                </button>
              </div>
            )}

            <p className="settings-caption">
              Opens the Microsoft login in your browser. Does not require the Azure CLI installed.
            </p>
            <p className="settings-caption">
              The session is stored with system encryption and survives an app restart.
              Signing out erases everything on this machine.
            </p>
          </div>
        )}

        {auth.mode === 'servicePrincipal' && (
          <div className="auth-block">
            <label className="auth-field" htmlFor="auth-tenant-id">
              <span className="auth-field__label">Tenant ID</span>
              <input
                id="auth-tenant-id"
                className="auth-field__input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={tenantId}
                onChange={(e) => {
                  setTenantId(e.target.value)
                  setSaved(false)
                }}
              />
            </label>

            <label className="auth-field" htmlFor="auth-client-id">
              <span className="auth-field__label">Client ID</span>
              <input
                id="auth-client-id"
                className="auth-field__input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value)
                  setSaved(false)
                }}
              />
            </label>

            <label className="auth-field" htmlFor="auth-client-secret">
              <span className="auth-field__label">Client Secret</span>
              <input
                id="auth-client-secret"
                className="auth-field__input"
                type="password"
                autoComplete="off"
                placeholder={auth.hasClientSecret ? '••••••••  (saved)' : ''}
                value={clientSecret}
                onChange={(e) => {
                  setClientSecret(e.target.value)
                  setSaved(false)
                }}
              />
            </label>

            <div className="auth-prompt__actions">
              <button
                type="button"
                className="auth-button auth-button--primary"
                onClick={handleSaveServicePrincipal}
              >
                Save
              </button>
              {saved && <span className="auth-status">Saved</span>}
            </div>

            <p className="settings-caption">
              The application needs the Reader role on the monitored subscriptions. Azure secrets
              expire — if the app starts failing with 401, check its validity.
            </p>
          </div>
        )}

        {auth.mode === 'azureCli' && (
          <p className="settings-caption">
            Uses this machine's <code>az</code> session. Requires the Azure CLI installed and{' '}
            <code>az login</code> already done.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Data source</h2>
        <div className="mode-toggle" role="group" aria-label="Data source">
          <button
            type="button"
            className={`mode-toggle__option ${settings.mode === 'azure' ? 'mode-toggle__option--active' : ''}`}
            onClick={() => handleModeChange('azure')}
            aria-pressed={settings.mode === 'azure'}
          >
            Azure (real data)
          </button>
          <button
            type="button"
            className={`mode-toggle__option ${settings.mode === 'demo' ? 'mode-toggle__option--active' : ''}`}
            onClick={() => handleModeChange('demo')}
            aria-pressed={settings.mode === 'demo'}
          >
            Demo (sample data)
          </button>
        </div>
        <p className="settings-caption">
          {settings.mode === 'demo'
            ? 'Demo mode shows fictional failed runs so you can explore the app without a connected Azure subscription.'
            : 'Queries the Logic Apps in your configured Azure subscription directly.'}
        </p>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Sync</h2>

        <label className="settings-row" htmlFor="poll-interval">
          <span>Check interval</span>
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
          <span>Lookback window</span>
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
        <h2 className="settings-section__title">Appearance</h2>
        <div className="mode-toggle" role="group" aria-label="Theme">
          {(Object.keys(THEME_LABELS) as readonly Theme[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`mode-toggle__option ${settings.theme === option ? 'mode-toggle__option--active' : ''}`}
              onClick={() => patch({ theme: option })}
              aria-pressed={settings.theme === option}
            >
              {THEME_LABELS[option]}
            </button>
          ))}
        </div>
        <p className="settings-caption">
          {settings.theme === 'system'
            ? 'Follows your operating system.'
            : 'Also sets the tray icon, which some systems do not recolor automatically.'}
        </p>
      </section>

      <section className="settings-section">
        <h2 className="settings-section__title">Preferences</h2>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.notificationsEnabled}
            onChange={(e) => {
              // O resultado do último teste morre aqui: mantido, ele afirmaria
              // "enviada" sobre uma configuração que acabou de mudar.
              setTestResult(undefined)
              patch({ notificationsEnabled: e.target.checked })
            }}
          />
          <span>Notifications</span>
        </label>

        <button
          type="button"
          className="auth-button settings-test-button"
          onClick={handleTestNotification}
          disabled={!settings.notificationsEnabled}
        >
          Send test notification
        </button>
        {testResult === 'sent' ? (
          <p className="settings-hint">Sent. If nothing appeared, check your system permissions.</p>
        ) : undefined}
        {testResult === 'blocked' ? (
          <p className="settings-hint">The system did not let the notification through.</p>
        ) : undefined}

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => patch({ launchAtLogin: e.target.checked })}
          />
          <span>Launch at login</span>
        </label>
      </section>
    </div>
  )
}
