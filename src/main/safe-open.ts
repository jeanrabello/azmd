import { shell } from 'electron'
import { isAllowedDeviceLoginUrl, isAllowedPortalUrl } from './portal-url.js'

/**
 * Único ponto do app autorizado a abrir URL externa.
 *
 * `shell.openExternal` entrega a URL ao sistema, então uma URL construída a
 * partir de dado remoto (nome de workflow, resource ID vindos do ARM) não pode
 * ir direto. A allowlist de host é a barreira — ver plano, seção 9.
 */
export async function openPortalUrl(url: string): Promise<void> {
  if (!isAllowedPortalUrl(url)) {
    console.warn('[azmd] URL bloqueada pela allowlist:', url)
    throw new Error('URL não permitida.')
  }
  await shell.openExternal(url)
}

/**
 * Abre a página de verificação do device code.
 *
 * Função separada de `openPortalUrl`, com allowlist separada, de propósito: são
 * duas superfícies de confiança distintas e o portal não deveria ganhar hosts
 * novos só porque o login precisa de um. Ver DEVICE_LOGIN_ALLOWED_HOSTS.
 */
export async function openDeviceLoginUrl(url: string): Promise<void> {
  if (!isAllowedDeviceLoginUrl(url)) {
    console.warn('[azmd] URL de login bloqueada pela allowlist:', url)
    throw new Error('URL de login não permitida.')
  }
  await shell.openExternal(url)
}
