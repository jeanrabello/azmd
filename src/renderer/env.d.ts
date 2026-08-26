import type { RunbarAPI } from '../shared/types.js'

// A ponte exposta pelo preload via contextBridge. O renderer nunca acessa
// IPC diretamente — só através desta superfície tipada.
declare global {
  interface Window {
    readonly runbar: RunbarAPI
  }
}

export {}
