import { app, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { AppController } from './app-controller.js'
import { Notifier } from './notifier.js'
import { TrayController } from './tray.js'
import { openPortalUrl } from './safe-open.js'
import { IPC, type AppState, type Settings } from '../shared/types.js'

/**
 * Bootstrap do main process.
 *
 * Responsabilidades, nesta ordem: garantir instância única, esconder do Dock,
 * montar tray + controller + notifier, registrar o IPC e amarrar o estado às
 * duas superfícies que o exibem (tray e renderer).
 */

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
    console.warn('[runbar] não foi possível ajustar o início automático:', error)
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
    return updated
  })

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

  ipcMain.handle(IPC.quit, () => {
    trayCtrl.window?.hide()
    app.quit()
  })
}

void app.whenReady().then(() => {
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
        console.error('[runbar] falha ao abrir o portal:', error)
      })
    },
    onActivateSummary: () => tray?.show(),
  })

  controller = new AppController({
    onStateChanged: broadcastState,
    onNewFailures: (runs) => notifier?.notifyFailures(runs),
  })

  notifier.setEnabled(controller.getSettings().notificationsEnabled)
  syncLoginItem(controller.getSettings().launchAtLogin)

  registerIpc(controller, tray)

  // Trocar claro/escuro deve repintar o popover imediatamente.
  nativeTheme.on('updated', () => {
    if (controller) broadcastState(controller.getState())
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
