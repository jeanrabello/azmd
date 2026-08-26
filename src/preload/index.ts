import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppState,
  type RunDetails,
  type RunbarAPI,
  type Settings,
} from '../shared/types.js'

/**
 * Ponte entre main e renderer.
 *
 * O contrato exposto é fechado e mínimo: nenhum handle do Electron, nenhum
 * módulo do Node, nenhuma credencial. O renderer só consegue fazer o que está
 * listado em `RunbarAPI` — se não está aqui, não existe do lado de lá.
 */
const api: RunbarAPI = {
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
  dismissRun: (runId) => ipcRenderer.invoke(IPC.dismissRun, runId) as Promise<void>,
  dismissAll: () => ipcRenderer.invoke(IPC.dismissAll) as Promise<void>,
  quit: () => ipcRenderer.invoke(IPC.quit) as Promise<void>,
}

contextBridge.exposeInMainWorld('runbar', api)
