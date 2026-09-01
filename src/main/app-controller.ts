import { powerMonitor } from 'electron'
import type { TokenCredential } from '@azure/identity'
import type { LogicAppAdapter } from './azure/adapter.js'
import { createAzureAdapters } from './azure/discovered.js'
import { DemoAdapter, DEMO_TENANT_ID } from './azure/demo.js'
import {
  createAzureCredential,
  probeCredential,
  signInWithDeviceCode,
  type CredentialInput,
} from './auth/credential.js'
import { clearTokenCache } from './auth/token-cache-store.js'
import { resolveTheme } from './theme.js'
import { AuthRecordStore } from './auth/auth-record-store.js'
import { SecretStore } from './auth/secret-store.js'
import { Poller, classifyError } from './poller.js'
import { buildPortalLink, buildResourceUrl, buildRunsListUrl } from './portal-url.js'
import { buildHierarchy, groupFor, isWorkflowWatched } from './grouping.js'
import { sanitizeAuth, SettingsStore } from './settings-store.js'
import { RECENT_RUNS_LIMIT } from '../shared/types.js'
import type {
  AppState,
  AuthConfig,
  AuthConfigPatch,
  AuthFlowState,
  WorkflowLinkContext,
  ConnectionState,
  FailedRun,
  LogicAppSummary,
  RunDetails,
  Settings,
  WorkflowRef,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowSummary,
} from '../shared/types.js'

/**
 * Orquestrador do main process.
 *
 * Ele é dono do estado e do ciclo de vida do polling; tray, IPC e notificação
 * são consumidores. Toda mudança de estado passa por `#emit`, o que garante
 * que o renderer e o ícone da tray nunca divirjam.
 */

export interface AppControllerOptions {
  readonly onStateChanged: (state: AppState) => void
  readonly onNewFailures: (runs: readonly FailedRun[]) => void
  /**
   * Andamento do login por device code.
   *
   * Existe separado de `onStateChanged` porque o fluxo é efêmero e não pertence
   * ao `AppState`: o código de verificação vale por minutos, só interessa
   * enquanto a tela de login está aberta, e guardá-lo no snapshot faria a tray
   * e o renderer reprocessarem estado que não muda nada do que eles exibem.
   */
  readonly onAuthFlowChanged: (state: AuthFlowState) => void
}

export class AppController {
  readonly #settings: SettingsStore
  readonly #secrets = new SecretStore()
  readonly #authRecords = new AuthRecordStore()
  /**
   * Credencial viva, reutilizada entre ciclos.
   *
   * No device code ela é a ÚNICA portadora do token (o cache do MSAL é em
   * memória, por instância), então trocá-la invalida a sessão. Zerada só quando
   * a identidade muda — ver `#credential` e `#rebuildPipeline`.
   */
  #liveCredential: TokenCredential | undefined
  readonly #onStateChanged: AppControllerOptions['onStateChanged']
  readonly #onNewFailures: AppControllerOptions['onNewFailures']
  readonly #onAuthFlowChanged: AppControllerOptions['onAuthFlowChanged']

  #poller: Poller
  #runs: readonly FailedRun[] = []
  #logicApps: readonly LogicAppSummary[] = []
  #workflowSummaries: readonly WorkflowSummary[] = []
  /** Inventário do último ciclo, para resolver ações vindas do renderer. */
  #discovered: readonly WorkflowRef[] = []
  #connection: ConnectionState = { kind: 'idle' }
  #timer: NodeJS.Timeout | undefined
  /** Impede ciclos concorrentes — um refresh manual durante o automático. */
  #cycleInFlight = false
  /** Tenant descoberto na autenticação; melhora as URLs do portal. */
  #resolvedTenantId: string | undefined
  #isFirstCycle = true
  #disposed = false
  /**
   * Momento da última sincronização BEM-SUCEDIDA.
   *
   * Sobrevive a ciclos com erro de propósito: quando a conexão cai, saber
   * "os dados são de 8 min atrás" é justamente o que diz se ainda dá para
   * confiar no que está na tela.
   */
  #lastSuccessfulSyncAt: string | undefined

  constructor(options: AppControllerOptions) {
    this.#settings = new SettingsStore()
    this.#onStateChanged = options.onStateChanged
    this.#onNewFailures = options.onNewFailures
    this.#onAuthFlowChanged = options.onAuthFlowChanged

    this.#reconcileClientSecretFlag()

    // Passa por `#rebuildPipeline` em vez de montar o Poller aqui porque a
    // credencial pode não ser construível no boot — quem fechou o app no meio
    // da configuração do service principal reabre com config incompleta, e
    // isso tem que virar erro exibido, não crash na inicialização.
    this.#poller = new Poller([], { lookbackHours: this.#settings.get().lookbackHours })
    this.#rebuildPipeline(this.#settings.get())
    // No boot o estado inicial é `idle`, não `connecting`: é `refreshNow` que
    // anuncia a conexão quando de fato começa. Só sobrescrevemos se o rebuild
    // não achou um erro para reportar.
    if (this.#connection.kind === 'connecting') this.#connection = { kind: 'idle' }
  }

  /**
   * Alinha `hasClientSecret` com o Keychain no boot.
   *
   * Os dois vivem em lugares diferentes e podem divergir: o settings.json é
   * copiado junto do backup ou do home do usuário, o item do Keychain não. Sem
   * esta reconciliação a UI diria "secret configurado" com o Keychain vazio, e
   * o usuário ficaria olhando um campo preenchido tentando entender o 401.
   *
   * Só grava quando de fato divergem, para não escrever no disco a cada boot.
   */
  #reconcileClientSecretFlag(): void {
    const auth = this.#settings.get().auth
    const hasClientSecret = this.#secrets.get() !== undefined
    if (auth.hasClientSecret !== hasClientSecret) {
      this.#settings.updateAuth({ ...auth, hasClientSecret })
    }
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  start(): void {
    this.#watchPower()
    void this.refreshNow()
    this.#scheduleNext()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
  }

  /**
   * Pausa o polling durante o sleep e faz catch-up ao acordar.
   * Sem isso, o Mac acorda com um timer vencido e um burst de chamadas.
   */
  #watchPower(): void {
    powerMonitor.on('suspend', () => {
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = undefined
    })
    powerMonitor.on('resume', () => {
      void this.refreshNow()
      this.#scheduleNext()
    })
  }

  #scheduleNext(): void {
    if (this.#disposed) return
    if (this.#timer) clearTimeout(this.#timer)
    const intervalMs = this.#settings.get().pollIntervalSeconds * 1000
    this.#timer = setTimeout(() => {
      void this.refreshNow().finally(() => this.#scheduleNext())
    }, intervalMs)
  }

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  getState(): AppState {
    const settings = this.#settings.get()
    return {
      runs: this.#runs,
      logicApps: this.#logicApps,
      workflows: this.#workflowSummaries,
      connection: this.#connection,
      settings,
      resolvedTheme: resolveTheme(settings.theme),
    }
  }

  #emit(): void {
    this.#onStateChanged(this.getState())
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  async refreshNow(): Promise<void> {
    if (this.#cycleInFlight || this.#disposed) return
    this.#cycleInFlight = true

    if (this.#connection.kind === 'idle') {
      this.#connection = { kind: 'connecting' }
      this.#emit()
    }

    const settings = this.#settings.get()

    try {
      if (settings.mode === 'azure' && !this.#resolvedTenantId) {
        // O probe é a única chance de distinguir "nunca entrou" de "falhou":
        // depois dele o ARM só devolve 401, que é a mesma coisa dos dois lados.
        if (!(await this.#resolveTenant())) {
          // `idle` e não `error`: falta um login, não falhou nada. Junto vai um
          // `authFlowChanged` idle, que é o que diz à tela de Configurações que
          // há um "Entrar" a oferecer — só a bolinha ociosa deixaria o usuário
          // sem pista do que fazer.
          this.#connection = { kind: 'idle' }
          this.#emitAuthFlow({ kind: 'idle' })
          return
        }
      }

      const result = await this.#poller.runCycle(settings.scope, {
        // Filtra antes da chamada: workflow ignorado não vira request ao ARM.
        shouldPoll: (workflow) => isWorkflowWatched(workflow, settings.watch),
      })
      const tenantId = settings.tenantId ?? this.#resolvedTenantId
      // Antes de mapear os runs: #toFailedRun resolve o Logic App a partir do
      // inventário, e com o de ontem o nome sairia vazio ou errado.
      this.#discovered = result.discoveredWorkflows
      this.#runs = result.allFailures.map((run) => this.#toFailedRun(run, tenantId))

      const hierarchy = buildHierarchy({
        workflows: result.discoveredWorkflows,
        failedRuns: result.allFailures,
        watch: settings.watch,
        portalUrlFor: (workflow) => buildRunsListUrl(workflow, tenantId),
      })
      this.#logicApps = hierarchy.logicApps
      this.#workflowSummaries = hierarchy.workflows

      // Um ciclo pode falhar em alguns workflows e ter sucesso em outros.
      // Só reportamos erro quando nada foi coletado — caso contrário mostrar
      // "erro" com dados frescos na tela confunde mais do que informa.
      const totalFailure = result.errors.length > 0 && result.workflowsPolled === 0
      const firstError = result.errors[0]

      if (totalFailure && firstError) {
        this.#connection = {
          kind: 'error',
          error: firstError.error,
          ...(this.#lastSuccessfulSyncAt ? { lastSyncedAt: this.#lastSuccessfulSyncAt } : {}),
        }
      } else if (result.discoveredWorkflows.length === 0 && result.errors.length > 0) {
        // Descoberta vazia COM erro: não é "tudo certo, nada existe" — é falha
        // de acesso. Sem isto o app mostrava ponto verde e lista vazia, que
        // parece bug e esconde o motivo real.
        this.#connection = {
          kind: 'error',
          error:
            firstError?.error ?? {
              kind: 'unknown',
              message: 'Não foi possível listar os Logic Apps.',
            },
          ...(this.#lastSuccessfulSyncAt ? { lastSyncedAt: this.#lastSuccessfulSyncAt } : {}),
        }
      } else {
        this.#lastSuccessfulSyncAt = new Date().toISOString()
        this.#connection = {
          kind: 'ok',
          lastSyncedAt: this.#lastSuccessfulSyncAt,
          workflowsMonitored: result.workflowsPolled,
        }
      }

      // O primeiro ciclo apenas absorve o histórico: notificar tudo que já
      // existia no boot seria ruído, não sinal.
      if (this.#isFirstCycle) {
        this.#poller.primeSeen(result.newFailures)
        this.#isFirstCycle = false
      } else if (result.newFailures.length > 0 && settings.notificationsEnabled) {
        this.#onNewFailures(result.newFailures.map((run) => this.#toFailedRun(run, tenantId)))
      }
    } catch (cause) {
      this.#connection = {
        kind: 'error',
        error: classifyError(cause),
        ...(this.#lastSuccessfulSyncAt ? { lastSyncedAt: this.#lastSuccessfulSyncAt } : {}),
      }
    } finally {
      this.#cycleInFlight = false
      this.#emit()
    }
  }

  /**
   * Descobre o tenant a partir do token, e diz se vale seguir com o ciclo.
   *
   * Faz duas coisas porque o probe é a única fonte das duas informações. O
   * tenant é cosmético: sem ele o portal ainda abre, só pode cair no diretório
   * errado para quem tem vários — então falha ao obtê-lo não interrompe nada e
   * `true` é a resposta em quase todo caso, inclusive quando o probe falha por
   * motivo comum (rede, 403) ou lança `AuthConfigError`. Nesses casos o erro
   * real aparece no ciclo, onde a UI sabe apresentá-lo.
   *
   * A exceção é `needsSignIn`, e é o único motivo de este método retornar algo:
   * "ninguém entrou ainda" não é falha. É o retorno esperado no primeiro boot
   * em modo deviceCode, e seguir para o ARM só produziria um 401 — que a essa
   * altura é indistinguível de sessão expirada, e viraria "Sua sessão expirou"
   * para quem nunca teve sessão nenhuma. Falso alarme na primeira abertura do
   * app é a pior hora possível para um monitor perder credibilidade.
   */
  async #resolveTenant(): Promise<boolean> {
    try {
      // `#credential()` e não uma instância nova: no device code o token está
      // no cache em memória da credencial do login, e um probe com instância
      // fresca reportaria `needsSignIn` mesmo com sessão válida.
      const probe = await probeCredential(this.#credential())
      if (probe.ok) {
        this.#resolvedTenantId = probe.tenantId
        return true
      }
      return probe.needsSignIn !== true
    } catch {
      // Tolerante por desenho: ver comentário acima.
      return true
    }
  }

  /**
   * Contexto necessário para montar o link do portal.
   *
   * Vem do inventário porque `WorkflowRun` não carrega região nem
   * statefulness — e a WorkflowMenuBlade do Standard exige os dois.
   */
  #linkContext(workflowResourceId: string, kind: WorkflowRun['kind']): WorkflowLinkContext {
    const workflow = this.#discovered.find((w) => w.resourceId === workflowResourceId)
    return {
      resourceId: workflowResourceId,
      kind: workflow?.kind ?? kind,
      location: workflow?.location ?? 'unknown',
      ...(workflow?.statefulness ? { statefulness: workflow.statefulness } : {}),
    }
  }

  /** Anexa os deep links resolvidos; o renderer nunca monta URL. */
  #toFailedRun(run: WorkflowRun, tenantId: string | undefined): FailedRun {
    const context = this.#linkContext(run.workflowResourceId, run.kind)
    const link = buildPortalLink(run, context, tenantId)
    const workflow = this.#discovered.find((w) => w.resourceId === run.workflowResourceId)
    const group = workflow ? groupFor(workflow) : undefined

    return {
      ...run,
      portalUrl: link.url,
      portalUrlIsFallback: link.isFallback,
      workflowPortalUrl: buildRunsListUrl(context, tenantId),
      logicAppId: group?.id ?? '',
      logicAppName: group?.name ?? '',
    }
  }

  /**
   * Monta os detalhes de um run para a tela de detalhes.
   *
   * Não faz chamada nova ao Azure: o histórico sai do que o poller já coletou.
   * Retorna undefined se o run não está mais na lista (foi descartado, ou o
   * modo mudou).
   */
  getRunDetails(runId: string): RunDetails | undefined {
    const run = this.findRun(runId)
    if (!run) return undefined

    const tenantId = this.#settings.get().tenantId ?? this.#resolvedTenantId
    const recentRuns: WorkflowRunSummary[] = this.#poller
      .getRecentRuns(run.workflowResourceId, RECENT_RUNS_LIMIT)
      .map((entry) => ({
        runId: entry.runId,
        runName: entry.runName,
        status: entry.status,
        startTime: entry.startTime,
        ...(entry.endTime ? { endTime: entry.endTime } : {}),
        portalUrl: buildPortalLink(entry, this.#linkContext(entry.workflowResourceId, entry.kind), tenantId).url,
        isCurrent: entry.runId === run.runId,
      }))

    const durationMs = run.endTime
      ? Date.parse(run.endTime) - Date.parse(run.startTime)
      : undefined

    return {
      run,
      recentRuns,
      ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Ações vindas do renderer
  // -------------------------------------------------------------------------

  getSettings(): Settings {
    return this.#settings.get()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const before = this.#settings.get()
    const after = this.#settings.update(patch)

    if (after.mode !== before.mode) {
      // Trocar de fonte invalida cursores e o que já foi visto.
      this.#rebuildPipeline(after)
    }

    if (after.lookbackHours !== before.lookbackHours) {
      this.#poller.setLookbackHours(after.lookbackHours)
    }

    if (after.pollIntervalSeconds !== before.pollIntervalSeconds) {
      this.#scheduleNext()
    }

    this.#emit()
    if (after.mode !== before.mode) void this.refreshNow()
    return after
  }

  /**
   * Descarta tudo que foi coletado e remonta os adapters.
   *
   * Chamado quando a *fonte* ou a *identidade* muda. Nos dois casos o
   * inventário anterior deixa de ser confiável: em modo demo ele é fictício, e
   * com credencial nova o RBAC é outro — workflows visíveis antes podem não
   * existir para quem entrou agora. Manter a lista mostraria falhas de recursos
   * que o usuário atual talvez nem possa enxergar.
   */
  #rebuildPipeline(settings: Settings): void {
    // `#buildAdapters` monta a credencial e por isso pode lançar
    // `AuthConfigError` — config de service principal pela metade, por exemplo.
    // Salvar uma config incompleta é legítimo (a UI salva campo por campo), e
    // não pode derrubar o método de quem salvou: sem adapter o poller roda em
    // vazio, o ciclo reporta o erro e a UI o mostra no lugar certo.
    let adapters: LogicAppAdapter[] = []
    let buildError: unknown
    try {
      adapters = this.#buildAdapters(settings)
    } catch (cause) {
      buildError = cause
    }

    this.#poller = new Poller(adapters, {
      lookbackHours: settings.lookbackHours,
      authMode: settings.auth.mode,
    })
    this.#runs = []
    this.#logicApps = []
    this.#workflowSummaries = []
    this.#discovered = []
    this.#lastSuccessfulSyncAt = undefined
    this.#isFirstCycle = true
    this.#resolvedTenantId = settings.mode === 'demo' ? DEMO_TENANT_ID : undefined
    this.#connection = buildError
      ? { kind: 'error', error: classifyError(buildError, settings.auth.mode) }
      : { kind: 'connecting' }
  }

  // -------------------------------------------------------------------------
  // Autenticação
  // -------------------------------------------------------------------------

  /**
   * Salva a config de auth vinda do renderer.
   *
   * O trabalho central aqui é a bifurcação do patch: o `clientSecret` vai para
   * o Keychain e todo o resto para o settings.json. É o que mantém a promessa
   * do tipo `AuthConfig` — o segredo entra por este método e não sai por
   * nenhum, porque o retorno é um `AuthConfig`, que por construção não o tem.
   */
  updateAuthConfig(patch: AuthConfigPatch): AuthConfig {
    const before = this.#settings.get().auth

    // Passa pelo sanitize mesmo vindo do main: o patch nasce no renderer, que é
    // código não-confiável por princípio, e é aqui que ele deixa de ser
    // `unknown`. O sanitize também descarta o clientSecret, que tratamos
    // separado abaixo — de novo, para que ele nunca chegue ao settings.json.
    const merged = sanitizeAuth({ ...before, ...patch }, before)

    // `undefined` = não mexer no que está guardado; `''` = apagar. A distinção
    // importa porque a UI manda o formulário inteiro a cada salvamento: sem
    // ela, um campo de senha exibido vazio (como todo campo de senha é)
    // apagaria o secret a cada visita à tela de Configurações.
    //
    // `set` lança quando não há armazenamento seguro (ver secret-store.ts), e
    // esse erro tem que chegar ao usuário — silenciá-lo faria a UI mostrar
    // "secret salvo" sem nada salvo. Guardamos a falha em vez de deixá-la
    // propagar na hora para persistir primeiro a parte não-secreta do patch: o
    // modo e o Client ID que ele escolheu são válidos e perdê-los junto do
    // secret o obrigaria a preencher tudo de novo sem entender por quê.
    let secretError: unknown
    if (patch.clientSecret !== undefined) {
      try {
        if (patch.clientSecret === '') this.#secrets.clear()
        else this.#secrets.set(patch.clientSecret)
      } catch (cause) {
        secretError = cause
      }
    }

    // Recalculado do store, nunca derivado do patch: é o Keychain que sabe, e
    // um `set` pode ter falhado.
    const after: AuthConfig = { ...merged, hasClientSecret: this.#secrets.get() !== undefined }
    const settings = this.#settings.updateAuth(after)

    // Trocar de modo ou de credencial muda quem somos para o Azure, então o que
    // já foi descoberto pode não ser mais visível — o pipeline recomeça.
    if (this.#identityChanged(before, after)) {
      // Quem somos para o Azure mudou, então a credencial em memória é de outra
      // identidade: descartá-la força `#credential` a montar a correta.
      this.#liveCredential = undefined
      if (settings.mode === 'azure') this.#rebuildPipeline(settings)
      else this.#poller.setAuthMode(after.mode)
      this.#emit()
      void this.refreshNow()
    } else {
      this.#emit()
    }

    // Só agora: o estado já está consistente e emitido, então a UI reflete o
    // que de fato ficou salvo antes de receber o erro do secret.
    if (secretError) throw secretError

    return after
  }

  /**
   * Decide se a mudança afeta *quem* o app é para o Azure.
   *
   * Só isso justifica jogar o inventário fora. Mudar a conta salva (`account`)
   * não conta: ela é resultado do login, não entrada dele.
   */
  #identityChanged(before: AuthConfig, after: AuthConfig): boolean {
    return (
      before.mode !== after.mode ||
      before.tenantId !== after.tenantId ||
      before.clientId !== after.clientId ||
      before.hasClientSecret !== after.hasClientSecret
    )
  }

  /**
   * Login interativo por device code.
   *
   * Resolve com o estado final para quem chamou pelo IPC, e ao mesmo tempo
   * emite os estados intermediários por `onAuthFlowChanged` — é assim que o
   * código de verificação chega à UI antes de o `await` terminar, já que o
   * fluxo fica bloqueado esperando o usuário concluir no navegador.
   */
  async signIn(): Promise<AuthFlowState> {
    this.#emitAuthFlow({ kind: 'starting' })

    try {
      const { record, account, credential } = await signInWithDeviceCode(
        this.#credentialInput({
          onPrompt: (info) => {
            this.#emitAuthFlow({
              kind: 'prompt',
              userCode: info.userCode,
              verificationUri: info.verificationUri,
              message: info.message,
            })
          },
        }),
      )

      this.#authRecords.set(record)

      /*
       * A credencial que acabou de autenticar é a que carrega o token, no cache
       * em memória dela. Guardá-la aqui é o que faz a consulta seguinte
       * funcionar: montar outra daria um cache vazio e, com
       * `disableAutomaticAuthentication`, um erro "Automatic authentication has
       * been disabled" logo após um login bem-sucedido.
       */
      this.#liveCredential = credential

      const auth = this.#settings.get().auth
      const settings = this.#settings.updateAuth({ ...auth, account })

      const state: AuthFlowState = { kind: 'success', account }
      this.#emitAuthFlow(state)

      // A credencial é nova, então o inventário anterior — coletado sem
      // credencial válida, ou com outra conta — não vale mais.
      if (settings.mode === 'azure') this.#rebuildPipeline(settings)

      // DEPOIS do rebuild, que zera o tenant resolvido: o da conta é melhor que
      // qualquer probe, porque veio do próprio login. Atribuir antes seria
      // descartá-lo e obrigar o ciclo seguinte a redescobrir o que já sabemos.
      this.#resolvedTenantId = account.tenantId
      this.#emit()
      void this.refreshNow()

      return state
    } catch (cause) {
      // `classifyError` já sabe redigir por modo, inclusive o AuthConfigError.
      // Reaproveitá-lo evita duas redações divergentes para a mesma falha.
      const state: AuthFlowState = {
        kind: 'error',
        message: classifyError(cause, this.#settings.get().auth.mode).message,
      }
      this.#emitAuthFlow(state)
      return state
    }
  }

  /**
   * Esquece a conta e apaga o secret.
   *
   * Apaga as duas coisas mesmo que só uma esteja em uso: "sair" tem que
   * significar que não sobrou credencial nossa na máquina, sem depender de o
   * usuário lembrar em qual modo estava quando configurou o quê.
   */
  signOut(): AuthConfig {
    this.#authRecords.clear()
    this.#secrets.clear()
    // O cache de tokens é o que de fato mantém a sessão viva entre execuções.
    // Apagar só o record deixaria o refresh token no disco, e a próxima
    // abertura do app reautenticaria sozinha quem pediu para sair.
    clearTokenCache()

    /*
     * Descartar a credencial viva é parte do "sair", não detalhe de
     * implementação: no device code é ela que guarda o token em memória. Apagar
     * só o record do disco deixaria esta instância capaz de renovar e seguir
     * consultando — "sair" sem efeito até reiniciar o app.
     */
    this.#liveCredential = undefined

    const before = this.#settings.get().auth
    // Sem spread condicional aqui: o objetivo é justamente *não* ter `account`.
    const after: AuthConfig = { mode: before.mode, hasClientSecret: false }
    const settings = this.#settings.updateAuth(after)

    // Remonta o pipeline para que os adapters larguem a credencial antiga —
    // sem isso o Poller seguiria com a credencial em memória, ainda capaz de
    // renovar token, e "sair" não teria surtido efeito nenhum até o restart.
    this.#rebuildPipeline(settings)

    // Termina em `idle`, não em `connecting` nem `error`: sair é uma ação do
    // usuário, não uma falha, e não há mais nada a conectar. Marcar erro faria
    // a tray acender alerta por algo que ele acabou de pedir.
    this.#connection = { kind: 'idle' }

    this.#emitAuthFlow({ kind: 'idle' })
    this.#emit()
    return after
  }

  #emitAuthFlow(state: AuthFlowState): void {
    this.#onAuthFlowChanged(state)
  }

  /**
   * Liga/desliga um Logic App inteiro.
   *
   * Rebuilda a hierarquia na hora com o inventário que já temos, para a UI
   * responder ao clique sem esperar o próximo ciclo de polling.
   */
  setLogicAppWatched(logicAppId: string, watched: boolean): void {
    const current = this.#settings.get().watch
    const ignored = new Set(current.ignoredLogicAppIds)
    if (watched) ignored.delete(logicAppId)
    else ignored.add(logicAppId)

    this.#applyWatch({ ...current, ignoredLogicAppIds: [...ignored] })
  }

  setWorkflowWatched(workflowResourceId: string, watched: boolean): void {
    const current = this.#settings.get().watch
    const ignored = new Set(current.ignoredWorkflowResourceIds)
    if (watched) ignored.delete(workflowResourceId)
    else ignored.add(workflowResourceId)

    this.#applyWatch({ ...current, ignoredWorkflowResourceIds: [...ignored] })
  }

  /**
   * Limpa toda a seleção de ignorados.
   *
   * Uma ação só em vez de N chamadas: reativar dezenas de apps um a um
   * dispararia um refresh por clique e gravaria o settings.json toda vez.
   */
  watchAll(): void {
    this.#applyWatch({ ignoredLogicAppIds: [], ignoredWorkflowResourceIds: [] })
  }

  #applyWatch(watch: Settings['watch']): void {
    // Antes do update: é a comparação com o estado anterior que diz quem foi
    // REATIVADO, e não apenas quem está monitorado agora.
    const before = this.#settings.get().watch
    const wasWatched = new Set(
      this.#discovered
        .filter((workflow) => isWorkflowWatched(workflow, before))
        .map((workflow) => workflow.resourceId),
    )

    const settings = this.#settings.update({ watch })
    const tenantId = settings.tenantId ?? this.#resolvedTenantId

    // Runs de workflows recém-ignorados somem da lista imediatamente.
    const watchedIds = new Set(
      this.#discovered
        .filter((workflow) => isWorkflowWatched(workflow, settings.watch))
        .map((workflow) => workflow.resourceId),
    )
    this.#runs = this.#runs.filter((run) => watchedIds.has(run.workflowResourceId))

    /*
     * Voltar a acompanhar significa querer saber o que aconteceu no intervalo.
     *
     * Sem isto, as falhas ocorridas durante o silêncio chegariam mudas: o
     * dedupe por `seenRuns` ainda as trata como conhecidas e o ciclo não as
     * conta como novas. Esquecê-las aqui é o que devolve a notificação — o
     * `Notifier` agrega acima de 3, então reativar algo com muitas falhas dá
     * uma notificação só, não uma avalanche.
     */
    const reactivated = [...watchedIds].filter((resourceId) => !wasWatched.has(resourceId))
    if (reactivated.length > 0) this.#poller.forgetSeenFor(reactivated)

    const hierarchy = buildHierarchy({
      workflows: this.#discovered,
      failedRuns: this.#runs,
      watch: settings.watch,
      portalUrlFor: (workflow) => buildRunsListUrl(workflow, tenantId),
    })
    this.#logicApps = hierarchy.logicApps
    this.#workflowSummaries = hierarchy.workflows
    this.#emit()

    // Reativar exige buscar o que não foi coletado enquanto estava ignorado.
    if (watchedIds.size > 0) void this.refreshNow()
  }

  /** URL do App Service (Standard) ou do resource group (Consumption). */
  logicAppPortalUrl(logicAppId: string): string | undefined {
    const summary = this.#logicApps.find((app) => app.group.id === logicAppId)
    if (!summary) return undefined
    const settings = this.#settings.get()
    const tenantId = settings.tenantId ?? this.#resolvedTenantId

    const { group } = summary
    const resourceId =
      group.siteResourceId ??
      `/subscriptions/${group.subscriptionId}/resourceGroups/${group.resourceGroup}`
    return buildResourceUrl(resourceId, tenantId)
  }

  workflowPortalUrl(workflowResourceId: string): string | undefined {
    return this.#workflowSummaries.find((w) => w.resourceId === workflowResourceId)?.portalUrl
  }

  findRun(runId: string): FailedRun | undefined {
    return this.#runs.find((run) => run.runId === runId)
  }

  dismissRun(runId: string): void {
    this.#poller.dismiss(runId)
    this.#runs = this.#runs.filter((run) => run.runId !== runId)
    this.#emit()
  }

  dismissAll(): void {
    this.#poller.dismissAll(this.#runs.map((run) => run.runId))
    this.#runs = []
    this.#emit()
  }

  /**
   * Escolhe os adapters conforme o modo.
   *
   * Este método é o toggle real <-> demo por inteiro. Nada além dele muda
   * quando o modo troca — poller, notificação, UI e IPC seguem idênticos,
   * porque todos falam com `LogicAppAdapter`, não com o Azure.
   */
  #buildAdapters(settings: Settings): LogicAppAdapter[] {
    if (settings.mode === 'demo') {
      this.#resolvedTenantId = DEMO_TENANT_ID
      return [new DemoAdapter()]
    }
    return createAzureAdapters(this.#credential())
  }

  /**
   * A credencial usada para consultar o Azure.
   *
   * POR QUE ISTO É CACHEADO, E NÃO CONSTRUÍDO A CADA USO
   *
   * No modo device code o token vive no cache em memória da instância que fez
   * o login — não há cache em disco. Montar uma credencial nova para consultar
   * dava um cache vazio, e como `disableAutomaticAuthentication` proíbe pedir
   * código fora do login explícito, a consulta falhava com "Automatic
   * authentication has been disabled" imediatamente após entrar. Por isso a
   * instância autenticada por `signIn` é guardada em `#liveCredential` e
   * reutilizada aqui.
   *
   * Nos outros modos a credencial é reconstruível à vontade (o service
   * principal renova sozinho pelo secret; o Azure CLI delega ao `az`), mas
   * cachear serve igual: evita recriar a cada ciclo de polling.
   */
  #credential(): TokenCredential {
    this.#liveCredential ??= createAzureCredential(this.#credentialInput())
    return this.#liveCredential
  }

  /**
   * Junta as três fontes de que a credencial depende.
   *
   * A config vem do settings.json (sem segredo), o secret vem do Keychain e o
   * record do device code vem do seu próprio arquivo. Montar isso num só lugar
   * é o que garante que nenhum caminho esqueça uma das partes — esquecer o
   * record, por exemplo, faria o device code pedir login a cada ciclo.
   *
   * `onPrompt` fica de fora: só o login interativo o fornece. Uma credencial
   * criada para polling não deve poder abrir fluxo de login — o poller roda em
   * background e o usuário não estaria olhando.
   */
  #credentialInput(overrides: Partial<CredentialInput> = {}): CredentialInput {
    const clientSecret = this.#secrets.get()
    const authRecord = this.#authRecords.get()
    return {
      config: this.#settings.get().auth,
      ...(clientSecret ? { clientSecret } : {}),
      ...(authRecord ? { authRecord } : {}),
      ...overrides,
    }
  }
}
