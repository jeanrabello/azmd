import { shell } from 'electron'
import { isAllowedPortalUrl } from './portal-url.js'

/**
 * Único ponto do app autorizado a abrir URL externa.
 *
 * `shell.openExternal` entrega a URL ao sistema, então uma URL construída a
 * partir de dado remoto (nome de workflow, resource ID vindos do ARM) não pode
 * ir direto. A allowlist de host é a barreira — ver plano, seção 9.
 */
export async function openPortalUrl(url: string): Promise<void> {
  if (!isAllowedPortalUrl(url)) {
    console.warn('[runbar] URL bloqueada pela allowlist:', url)
    throw new Error('URL não permitida.')
  }
  await shell.openExternal(url)
}
