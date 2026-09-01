import { app, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { AppController } from './app-controller.js'
import { Notifier } from './notifier.js'
import { TrayController } from './tray.js'
import { openDeviceLoginUrl, openPortalUrl } from './safe-open.js'
import { ensureCliPath } from './auth/shell-path.js'
import { applyThemeSource } from './theme.js'
import { SettingsStore } from './settings-store.js'
import {
  IPC,
  type AppState,
  type AuthConfigPatch,
  type AuthFlowState,
  type Settings,
} from '../shared/types.js'

/**
 * Bootstrap do main process.
 *
 * Responsabilidades, nesta ordem: garantir instância única, esconder do Dock,
 * montar tray + controller + notifier, registrar o IPC e amarrar o estado às
 * duas superfícies que o exibem (tray e renderer).
 */

/*
 * Identidade do app para o Windows (AppUserModelID).
 *
 * O Action Center só mostra um banner de app cujo AUMID ele reconheça. Sem
 * isto as notificações são descartadas em silêncio no `npm run dev` — o
 * processo se identifica como `electron.app.Electron` — e no app instalado o
 * banner sai sem o nome/ícone certos. Precisa casar com o `appId` do
 * electron-builder e vir antes de qualquer `new Notification`.
 * No macOS a chamada é no-op.
 */
app.setAppUserModelId('com.jeanrabello.azmd')

// Duas instâncias competiriam pelo mesmo ícone e duplicariam notificações.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let controller: AppController | undefined
let tray: TrayController | undefined
let notifier: Notifier | undefined

function resolveRendererTarget(): { url: string | undefined; file: string } {
  // electron-vite injeta esta variável no dev para habilitar HMR.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  return {
    url: devServerUrl,
    file: join(app.getAppPath(), 'out', 'renderer', 'index.html'),
  }
}

/**
 * O login item é do sistema, não do nosso settings.json.
 *
 * Em build não assinado o macOS recusa o registro, e um throw aqui derrubaria
 * o boot por causa de uma preferência secundária. Também evitamos chamar
 * quando o estado desejado já é o atual — é o caso comum e poupa o erro.
 */
function syncLoginItem(desired: boolean): void {
  try {
    if (app.getLoginItemSettings().openAtLogin === desired) return
    app.setLoginItemSettings({ openAtLogin: desired })
  } catch (error) {
    console.warn('[azmd] não foi possível ajustar o início automático:', error)
  }
}

/**
 * Conserta o PATH para o modo Azure CLI, e só para ele.
 *
 * Aberto pela GUI no macOS, o app recebe só /usr/bin:/bin:/usr/sbin:/sbin —
 * sem /opt/homebrew/bin, onde o `az` costuma estar. Sem este reparo o modo CLI
 * falha com "Azure CLI could not be found" mesmo com `az login` feito. No
 * Windows o PATH da GUI já é o mesmo do terminal, e o reparo só acrescenta os
 * diretórios conhecidos de instalação da CLI.
 *
 * Condicional ao modo porque em Device Code e Service Principal o `az` é
 * irrelevante: avisar que ele falta seria apontar para um problema que o
 * usuário não tem e desviar do real. Idempotente por desenho (ver
 * auth/shell-path.ts), então chamar de novo quando o modo muda é seguro.
 */
async function ensureCliPathForMode(mode: Settings['auth']['mode']): Promise<void> {
  if (mode !== 'azureCli') return

  const cliPath = await ensureCliPath()
  if (!cliPath.azFound) {
    console.warn(
      '[azmd] `az` não encontrado no PATH. O modo Azure CLI vai falhar até que a ' +
        'Azure CLI esteja instalada e autenticada (`az login`).',
    )
  }
}

function broadcastAuthFlow(state: AuthFlowState): void {
  const contents = tray?.window?.webContents
  if (contents && !contents.isDestroyed() && !contents.isLoading()) {
    contents.send(IPC.authFlowChanged, state)
  }
}

function broadcastState(state: AppState): void {
  tray?.updateFromState(state)
  const contents = tray?.window?.webContents
  // Enviar durante o carregamento perde o evento; o renderer chama getState()
  // no mount, então esse caso já está coberto.
  if (contents && !contents.isDestroyed() && !contents.isLoading()) {
    contents.send(IPC.stateChanged, state)
  }
}

function registerIpc(ctrl: AppController, trayCtrl: TrayController): void {
  ipcMain.handle(IPC.getState, () => ctrl.getState())
  ipcMain.handle(IPC.getSettings, () => ctrl.getSettings())
  ipcMain.handle(IPC.refreshNow, () => ctrl.refreshNow())

  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<Settings>) => {
    const updated = ctrl.updateSettings(patch)
    syncLoginItem(updated.launchAtLogin)
    notifier?.setEnabled(updated.notificationsEnabled)
    // Antes do broadcast: `themeSource` muda `shouldUseDarkColors`, que é o que
    // o controller lê para resolver o tema. Aplicar depois emitiria um estado
    // com o tema antigo e a UI piscaria no valor errado por um frame.
    applyThemeSource(updated.theme)
    trayCtrl.updateFromState(ctrl.getState())
    return updated
  })

  ipcMain.handle(IPC.testNotification, () => notifier?.notifyTest() ?? false)

  ipcMain.handle(IPC.openRunInPortal, async (_event, runId: string) => {
    const run = ctrl.findRun(runId)
    if (!run) return
    await openPortalUrl(run.portalUrl)
  })

  ipcMain.handle(IPC.openWorkflowInPortal, async (_event, runId: string) => {
    const run = ctrl.findRun(runId)
    if (!run) return
    await openPortalUrl(run.workflowPortalUrl)
  })

  ipcMain.handle(IPC.getRunDetails, (_event, runId: string) => ctrl.getRunDetails(runId))

  ipcMain.handle(IPC.setLogicAppWatched, (_event, logicAppId: string, watched: boolean) => {
    ctrl.setLogicAppWatched(logicAppId, watched)
  })

  ipcMain.handle(IPC.setWorkflowWatched, (_event, resourceId: string, watched: boolean) => {
    ctrl.setWorkflowWatched(resourceId, watched)
  })

  ipcMain.handle(IPC.watchAll, () => {
    ctrl.watchAll()
  })

  ipcMain.handle(IPC.openLogicAppInPortal, async (_event, logicAppId: string) => {
    const url = ctrl.logicAppPortalUrl(logicAppId)
    if (url) await openPortalUrl(url)
  })

  ipcMain.handle(IPC.openWorkflowResourceInPortal, async (_event, resourceId: string) => {
    const url = ctrl.workflowPortalUrl(resourceId)
    if (url) await openPortalUrl(url)
  })

  ipcMain.handle(IPC.dismissRun, (_event, runId: string) => {
    ctrl.dismissRun(runId)
  })

  ipcMain.handle(IPC.dismissAll, () => {
    ctrl.dismissAll()
  })

  ipcMain.handle(IPC.updateAuthConfig, async (_event, patch: AuthConfigPatch) => {
    const auth = ctrl.updateAuthConfig(patch)
    // Trocar PARA o modo CLI em runtime precisa do mesmo reparo de PATH que o
    // boot faz — sem isto, quem muda de Device Code para CLI sem reiniciar cai
    // no "az não encontrado" que o reparo existe justamente para evitar.
    await ensureCliPathForMode(auth.mode)
    return auth
  })

  ipcMain.handle(IPC.authSignIn, () => ctrl.signIn())

  ipcMain.handle(IPC.authSignOut, () => ctrl.signOut())

  /*
   * Abre a página onde o usuário digita o código do device flow.
   *
   * Separado dos handlers de portal porque a validação é outra — ver
   * DEVICE_LOGIN_ALLOWED_HOSTS em portal-url.ts. A URL vem do
   * `@azure/identity` e atravessa o renderer, que não pode abrir URL externa
   * por conta própria; por isso ela é revalidada aqui, do lado de cá da ponte,
   * e não onde foi exibida.
   */
  ipcMain.handle(IPC.openDeviceLoginUrl, async (_event, url: string) => {
    await openDeviceLoginUrl(url)
  })

  ipcMain.handle(IPC.quit, () => {
    trayCtrl.window?.hide()
    app.quit()
  })
}

void app.whenReady().then(async () => {
  /*
   * O reparo de PATH vem antes de qualquer credencial existir, porque é o
   * `createAzureCredential` do controller que vai procurar o `az`.
   *
   * Lemos as settings por um store próprio em vez de esperar o controller:
   * inverter a ordem faria a credencial ser montada com o PATH ainda enxuto.
   * É uma leitura de arquivo pequena, feita uma vez no boot.
   */
  await ensureCliPathForMode(new SettingsStore().get().auth.mode)

  // Agente de menu bar: sem ícone no Dock. O Info.plist também traz
  // LSUIElement, mas isto cobre o `npm run dev`, que roda sem o plist.
  app.dock?.hide()

  const target = resolveRendererTarget()
  tray = new TrayController({
    preloadPath: join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
    rendererUrl: target.url,
    rendererFile: target.file,
  })
  tray.init()

  notifier = new Notifier({
    onActivate: (run) => {
      void openPortalUrl(run.portalUrl).catch((error: unknown) => {
        console.error('[azmd] falha ao abrir o portal:', error)
      })
    },
    onActivateSummary: () => tray?.show(),
  })

  controller = new AppController({
    onStateChanged: broadcastState,
    onNewFailures: (runs) => notifier?.notifyFailures(runs),
    onAuthFlowChanged: broadcastAuthFlow,
  })

  notifier.setEnabled(controller.getSettings().notificationsEnabled)
  syncLoginItem(controller.getSettings().launchAtLogin)
  applyThemeSource(controller.getSettings().theme)

  registerIpc(controller, tray)

  // Trocar claro/escuro deve repintar o popover e o ícone imediatamente. Só
  // dispara quando a preferência é 'system'; com tema fixo o `themeSource` já
  // impede o evento de mudar o resultado.
  nativeTheme.on('updated', () => {
    if (!controller) return
    const state = controller.getState()
    broadcastState(state)
    tray?.updateFromState(state)
  })

  controller.start()
})

// Um app de menu bar continua vivo sem janelas — é o ponto dele.
app.on('window-all-closed', () => {
  // Intencionalmente vazio.
})

app.on('second-instance', () => {
  tray?.show()
})

app.on('before-quit', () => {
  controller?.dispose()
  tray?.destroy()
})
