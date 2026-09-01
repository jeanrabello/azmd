import { BrowserWindow, Tray, nativeImage, screen, app } from 'electron'
import { join } from 'node:path'
import type { AppState } from '../shared/types.js'

/**
 * Ícone da menu bar + popover ancorado.
 *
 * Usamos Tray + BrowserWindow em vez da lib `menubar` porque ela está defasada
 * em relação ao Electron atual e o que ela resolve — posicionar e esconder no
 * blur — cabe em poucas dezenas de linhas com controle total.
 *
 * O ícone é Template Image: monocromático com alpha, deixando o macOS inverter
 * conforme a barra clara/escura. O plano trata isso como requisito, não
 * polimento — é o detalhe que mais denuncia um app não-nativo.
 */

const POPOVER_WIDTH = 380
const POPOVER_HEIGHT = 520
/** Folga entre a barra e o topo do popover. */
const WINDOW_GAP = 6

export interface TrayControllerOptions {
  readonly preloadPath: string
  readonly rendererUrl: string | undefined
  readonly rendererFile: string
}

export class TrayController {
  #tray: Tray | undefined
  #window: BrowserWindow | undefined
  readonly #options: TrayControllerOptions

  constructor(options: TrayControllerOptions) {
    this.#options = options
  }

  init(): void {
    this.#tray = new Tray(this.#buildIcon('idle'))
    this.#tray.setToolTip('azmd')
    this.#tray.on('click', () => this.toggle())
    // Botão direito também abre: é o gesto esperado numa menu bar.
    this.#tray.on('right-click', () => this.toggle())
    this.#window = this.#createWindow()
  }

  get window(): BrowserWindow | undefined {
    return this.#window
  }

  #createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      fullscreenable: false,
      // Vibrancy é o que dá a translucidez do sistema. Requer que o CSS não
      // pinte um fundo opaco por cima — ver src/renderer/styles/app.css.
      vibrancy: 'popover',
      visualEffectState: 'active',
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // Fechar ao perder o foco é o comportamento nativo de um popover.
    window.on('blur', () => {
      if (!window.webContents.isDevToolsOpened()) window.hide()
    })

    if (this.#options.rendererUrl) {
      void window.loadURL(this.#options.rendererUrl)
    } else {
      void window.loadFile(this.#options.rendererFile)
    }
    return window
  }

  toggle(): void {
    const window = this.#window
    if (!window) return
    if (window.isVisible()) {
      window.hide()
      return
    }
    this.show()
  }

  show(): void {
    const window = this.#window
    const tray = this.#tray
    if (!window || !tray) return
    this.#positionUnderTray(window, tray)
    window.show()
    window.focus()
  }

  /** Centraliza sob o ícone, sem deixar sair da tela em monitores laterais. */
  #positionUnderTray(window: BrowserWindow, tray: Tray): void {
    const trayBounds = tray.getBounds()
    const windowBounds = window.getBounds()
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })

    const desiredX = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2)
    const minX = display.workArea.x
    const maxX = display.workArea.x + display.workArea.width - windowBounds.width
    const x = Math.min(Math.max(desiredX, minX), maxX)
    const y = Math.round(trayBounds.y + trayBounds.height + WINDOW_GAP)

    window.setPosition(x, y, false)
  }

  /** Reflete o estado no ícone e no tooltip. */
  updateFromState(state: AppState): void {
    const tray = this.#tray
    if (!tray) return

    const failureCount = state.runs.length
    const status: IconStatus =
      state.connection.kind === 'error' ? 'error' : failureCount > 0 ? 'alert' : 'idle'

    tray.setImage(this.#buildIcon(status))
    tray.setToolTip(describeState(state))
    // O badge de título mantém a contagem visível sem abrir o popover. Só
    // existe no macOS: `setTitle` é no-op no Windows, onde a contagem fica
    // apenas no tooltip acima.
    if (process.platform === 'darwin') {
      tray.setTitle(failureCount > 0 ? String(failureCount) : '')
    }
  }

  #buildIcon(status: IconStatus): Electron.NativeImage {
    const file = `iconTemplate${status === 'idle' ? '' : `-${status}`}.png`
    const image = nativeImage.createFromPath(join(this.#iconDir(), file))
    if (image.isEmpty()) return this.#fallbackIcon()
    // Template image é convenção do macOS: o sistema recolore o ícone conforme
    // o tema da barra. No Windows não existe equivalente, e marcar a imagem
    // como template deixaria o ícone invisível na bandeja — o PNG é
    // monocromático com alpha, então sem a recoloração não sobra nada visível.
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  }

  #iconDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'icons')
      : join(app.getAppPath(), 'resources', 'icons')
  }

  /** Evita subir sem ícone nenhum caso o asset falte no bundle. */
  #fallbackIcon(): Electron.NativeImage {
    const image = nativeImage.createEmpty()
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  }

  destroy(): void {
    this.#tray?.destroy()
    this.#window?.destroy()
  }
}

type IconStatus = 'idle' | 'alert' | 'error'

function describeState(state: AppState): string {
  if (state.connection.kind === 'error') return `azmd — ${state.connection.error.message}`

  const runCount = state.runs.length
  if (runCount === 0) return 'azmd — no failures'

  // Com muitos Logic Apps, "12 falhas" não diz se é um app quebrado ou o
  // ambiente inteiro. O número de apps afetados responde isso de relance.
  const failingApps = state.logicApps.filter((app) => app.health === 'failing').length
  const runs = `${runCount} ${runCount === 1 ? 'failure' : 'failures'}`
  if (failingApps <= 1) return `azmd — ${runs}`
  return `azmd — ${runs} across ${failingApps} Logic Apps`
}
