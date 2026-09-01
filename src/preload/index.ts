import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppState,
  type AuthConfig,
  type AuthFlowState,
  type RunDetails,
  type AzmdAPI,
  type Settings,
} from '../shared/types.js'

/**
 * Ponte entre main e renderer.
 *
 * O contrato exposto é fechado e mínimo: nenhum handle do Electron, nenhum
 * módulo do Node, nenhuma credencial. O renderer só consegue fazer o que está
 * listado em `AzmdAPI` — se não está aqui, não existe do lado de lá.
 *
 * A única exceção aparente é o `clientSecret` de `updateAuthConfig`, e ela é
 * de mão única: o segredo desce do formulário para o main e nunca volta —
 * nada nesta ponte devolve credencial ao renderer.
 */
const api: AzmdAPI = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<AppState>,

  /**
   * Retorna a função de cancelamento. É responsabilidade do chamador invocá-la
   * no cleanup do efeito; sem isso os listeners acumulam a cada remontagem.
   */
  onStateChanged: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => cb(state)
    ipcRenderer.on(IPC.stateChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.stateChanged, listener)
    }
  },

  openRunInPortal: (runId) => ipcRenderer.invoke(IPC.openRunInPortal, runId) as Promise<void>,
  openWorkflowInPortal: (runId) =>
    ipcRenderer.invoke(IPC.openWorkflowInPortal, runId) as Promise<void>,
  getRunDetails: (runId) =>
    ipcRenderer.invoke(IPC.getRunDetails, runId) as Promise<RunDetails | undefined>,
  refreshNow: () => ipcRenderer.invoke(IPC.refreshNow) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<Settings>,
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch) as Promise<Settings>,
  testNotification: () => ipcRenderer.invoke(IPC.testNotification) as Promise<boolean>,
  setLogicAppWatched: (logicAppId, watched) =>
    ipcRenderer.invoke(IPC.setLogicAppWatched, logicAppId, watched) as Promise<void>,
  setWorkflowWatched: (workflowResourceId, watched) =>
    ipcRenderer.invoke(IPC.setWorkflowWatched, workflowResourceId, watched) as Promise<void>,
  watchAll: () => ipcRenderer.invoke(IPC.watchAll) as Promise<void>,
  openLogicAppInPortal: (logicAppId) =>
    ipcRenderer.invoke(IPC.openLogicAppInPortal, logicAppId) as Promise<void>,
  openWorkflowResourceInPortal: (workflowResourceId) =>
    ipcRenderer.invoke(IPC.openWorkflowResourceInPortal, workflowResourceId) as Promise<void>,
  dismissRun: (runId) => ipcRenderer.invoke(IPC.dismissRun, runId) as Promise<void>,
  dismissAll: () => ipcRenderer.invoke(IPC.dismissAll) as Promise<void>,
  quit: () => ipcRenderer.invoke(IPC.quit) as Promise<void>,

  updateAuthConfig: (patch) =>
    ipcRenderer.invoke(IPC.updateAuthConfig, patch) as Promise<AuthConfig>,
  authSignIn: () => ipcRenderer.invoke(IPC.authSignIn) as Promise<AuthFlowState>,
  authSignOut: () => ipcRenderer.invoke(IPC.authSignOut) as Promise<AuthConfig>,

  /**
   * Mesmo contrato de `onStateChanged`: quem registra é responsável por chamar
   * a função devolvida no cleanup, senão os listeners acumulam a cada
   * remontagem do painel de configurações.
   */
  onAuthFlowChanged: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AuthFlowState): void => cb(state)
    ipcRenderer.on(IPC.authFlowChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.authFlowChanged, listener)
    }
  },

  openDeviceLoginUrl: (url) => ipcRenderer.invoke(IPC.openDeviceLoginUrl, url) as Promise<void>,
}

contextBridge.exposeInMainWorld('azmd', api)
