import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuthenticationRecord } from '@azure/identity'

/**
 * Persiste o `AuthenticationRecord` devolvido pelo device code.
 *
 * POR QUE JSON SIMPLES, SEM `safeStorage`
 * O record não é segredo: são cinco campos de identificação da conta —
 * `authority`, `homeAccountId`, `clientId`, `tenantId`, `username`. Nenhum
 * token, nenhum refresh token. Quem tiver o arquivo não consegue autenticar
 * com ele; consegue, no máximo, saber com qual conta o usuário entrou — e essa
 * informação já aparece na UI do próprio app. Cifrar acrescentaria um ponto de
 * falha (Keychain indisponível) para proteger o que não é sigiloso.
 *
 * PARA QUE ELE SERVE
 * Sem `@azure/identity-cache-persistence` (ver comentário em credential.ts), o
 * cache de tokens do MSAL vive em memória. O record é o que permite ao
 * `DeviceCodeCredential` saber *qual* conta procurar nesse cache e renovar o
 * token silenciosamente enquanto o processo vive. Depois de um restart ele
 * ainda identifica a conta na UI, mas o device code pode precisar ser refeito.
 */

function recordPath(): string {
  return join(app.getPath('userData'), 'auth-record.json')
}

/**
 * Valida o que veio do disco.
 *
 * O arquivo é JSON legível e editável à mão, e um record com campo faltando
 * faria o `@azure/identity` falhar longe daqui, com mensagem de MSAL. Melhor
 * tratar como "não há record" e cair no fluxo de login, que é recuperável.
 */
function sanitizeRecord(input: unknown): AuthenticationRecord | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  const fields = ['authority', 'homeAccountId', 'clientId', 'tenantId', 'username'] as const
  for (const field of fields) {
    const value = raw[field]
    if (typeof value !== 'string' || value.length === 0) return undefined
  }
  return {
    authority: raw['authority'] as string,
    homeAccountId: raw['homeAccountId'] as string,
    clientId: raw['clientId'] as string,
    tenantId: raw['tenantId'] as string,
    username: raw['username'] as string,
  }
}

export class AuthRecordStore {
  get(): AuthenticationRecord | undefined {
    try {
      return sanitizeRecord(JSON.parse(readFileSync(recordPath(), 'utf8')))
    } catch {
      // Primeiro boot ou JSON corrompido: o app segue e pede login.
      return undefined
    }
  }

  set(record: AuthenticationRecord): void {
    const target = recordPath()
    try {
      mkdirSync(dirname(target), { recursive: true })
      // Atômica: um record truncado seria descartado no próximo boot e o
      // usuário perderia a identificação da conta sem entender por quê.
      const temp = `${target}.tmp`
      writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8')
      renameSync(temp, target)
    } catch (error) {
      // Falhar aqui só custa um login extra no próximo boot; não vale quebrar
      // o sign-in que acabou de dar certo.
      console.error('[azmd] falha ao salvar o record de autenticação:', error)
    }
  }

  clear(): void {
    try {
      rmSync(recordPath(), { force: true })
    } catch (error) {
      console.error('[azmd] falha ao apagar o record de autenticação:', error)
    }
  }
}
