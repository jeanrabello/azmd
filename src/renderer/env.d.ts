import type { AzmdAPI } from '../shared/types.js'

// A ponte exposta pelo preload via contextBridge. O renderer nunca acessa
// IPC diretamente — só através desta superfície tipada.
declare global {
  interface Window {
    readonly azmd: AzmdAPI
  }
}

export {}
