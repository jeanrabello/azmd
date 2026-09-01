import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TokenCachePersistenceOptions } from '@azure/identity'

/**
 * Cache de tokens do MSAL, persistido e cifrado.
 *
 * O QUE ISTO CONSERTA
 * Sem cache em disco, o refresh token do device code vivia só na memória do
 * processo. O `AuthenticationRecord` (ver auth-record-store.ts) sobrevivia ao
 * restart e reidentificava a conta — a UI mostrava o usuário logado — mas não
 * carrega token nenhum. Resultado observado em 2026-09-01: ao reabrir o app,
 * ele pedia um device code novo e o polling ficava parado sem erro visível,
 * com zero Logic Apps. "Logado" na tela, sem sessão de verdade.
 *
 * POR QUE NÃO `@azure/identity-cache-persistence`
 * É o caminho oficial, mas depende de módulo nativo (keytar): rebuild a cada
 * versão do Electron e mais um binário para assinar e notarizar. O
 * `@azure/identity` não exige o pacote dele especificamente — exige *algum*
 * provider registrado por `useIdentityPlugin`, e o contrato é o `ICachePlugin`
 * do MSAL: duas funções, `beforeCacheAccess` e `afterCacheAccess`. Implementá-lo
 * sobre o `safeStorage`, que o app já usa para o clientSecret, dá a mesma
 * persistência sem nada nativo a mais.
 *
 * O QUE ESTE ARQUIVO GUARDA — E POR QUE É CIFRADO
 * Ao contrário do `auth-record.json`, aqui há material sigiloso de verdade:
 * access token e refresh token. Quem tiver o conteúdo em claro consegue agir
 * como o usuário no ARM até o refresh expirar. Por isso a mesma regra dura do
 * secret-store vale: sem encriptação disponível, NÃO grava. Persistir tokens em
 * texto plano para "funcionar em qualquer máquina" trocaria um relogin ocasional
 * por um vazamento permanente.
 */

/** Um arquivo por cache: o identity mantém um para CAE e outro para não-CAE. */
function cachePath(name: string): string {
  // O nome vem do @azure/identity (base + sufixo .nocae/.cae). Sanitizamos
  // porque ele acaba num caminho de arquivo: um nome com `/` ou `..` viraria
  // escrita fora do userData.
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(app.getPath('userData'), `msal-cache-${safe}.bin`)
}

function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    // Chamar antes de o app estar pronto lança. Tratamos como indisponível.
    return false
  }
}

/**
 * Lê o cache cifrado. `undefined` em qualquer falha, de propósito.
 *
 * Todos os modos de falha são recuperáveis com um novo login: arquivo ausente
 * no primeiro uso, Keychain negando acesso, chave rotacionada por reinstalação
 * do app, ou blob de uma versão anterior. Nenhum justifica derrubar o boot —
 * cair no device code é a degradação correta.
 */
function readCache(name: string): string | undefined {
  try {
    const encrypted = readFileSync(cachePath(name))
    const plain = safeStorage.decryptString(encrypted)
    return plain.length > 0 ? plain : undefined
  } catch {
    return undefined
  }
}

function writeCache(name: string, contents: string): void {
  if (!isEncryptionAvailable()) {
    // Sem Keychain o app continua funcionando — só não lembra a sessão entre
    // execuções. Avisar uma vez é melhor que falhar o login que deu certo.
    console.warn(
      '[azmd] armazenamento seguro indisponível: a sessão não será lembrada após reiniciar.',
    )
    return
  }
  const target = cachePath(name)
  try {
    mkdirSync(dirname(target), { recursive: true })
    // Atômica, mesmo padrão do settings-store e do secret-store: um crash no
    // meio da escrita deixaria um blob truncado, indistinguível na leitura de
    // "Keychain recusou" — e o usuário perderia a sessão sem entender por quê.
    const temp = `${target}.tmp`
    writeFileSync(temp, safeStorage.encryptString(contents))
    renameSync(temp, target)
  } catch (error) {
    // Falhar aqui custa um relogin no próximo boot; não vale quebrar o fluxo
    // de autenticação que acabou de dar certo.
    console.error('[azmd] falha ao gravar o cache de tokens:', error)
  }
}

/**
 * Provider no formato que o `@azure/identity` espera de um plugin de cache.
 *
 * Assinatura ditada por `msalPlugins.ts`: recebe as opções (de onde só o `name`
 * importa aqui) e devolve o `ICachePlugin`. O identity chama isto duas vezes,
 * uma por variante de cache, com nomes distintos — daí o nome fazer parte do
 * caminho do arquivo.
 */
function persistenceProvider(options?: TokenCachePersistenceOptions & { name?: string }): {
  beforeCacheAccess: (context: {
    tokenCache: { deserialize: (data: string) => void }
  }) => Promise<void>
  afterCacheAccess: (context: {
    cacheHasChanged: boolean
    tokenCache: { serialize: () => string }
  }) => Promise<void>
} {
  const name = options?.name ?? 'azmd'
  return {
    async beforeCacheAccess(context) {
      const contents = readCache(name)
      if (contents === undefined) return
      try {
        context.tokenCache.deserialize(contents)
      } catch (error) {
        // Cache de formato incompatível (upgrade do MSAL, por exemplo).
        // Descartar e pedir login é recuperável; propagar não seria.
        console.warn('[azmd] cache de tokens ilegível, será refeito:', error)
      }
    },

    async afterCacheAccess(context) {
      // Só grava quando o MSAL diz que mudou: sem isso, todo ciclo de polling
      // reescreveria o arquivo e tocaria o Keychain sem motivo.
      if (!context.cacheHasChanged) return
      writeCache(name, context.tokenCache.serialize())
    },
  }
}

/**
 * Plugin para `useIdentityPlugin`. Registrar é o que habilita o
 * `tokenCachePersistenceOptions` em credential.ts — sem isto o
 * `@azure/identity` lança pedindo o pacote oficial.
 */
export const azmdCachePersistencePlugin = (context: unknown): void => {
  const ctx = context as {
    cachePluginControl?: { setPersistence: (provider: unknown) => void }
  }
  ctx.cachePluginControl?.setPersistence(persistenceProvider)
}

/**
 * Apaga os caches. Parte do sign-out: sem isso o refresh token continuaria no
 * disco e a próxima abertura do app reautenticaria sozinha alguém que pediu
 * para sair.
 */
export function clearTokenCache(): void {
  // Os dois sufixos que o @azure/identity usa, mais o nome base por segurança
  // caso a convenção mude numa atualização.
  for (const suffix of ['', '.nocae', '.cae']) {
    try {
      rmSync(cachePath(`${TOKEN_CACHE_NAME}${suffix}`), { force: true })
    } catch (error) {
      console.error('[azmd] falha ao apagar o cache de tokens:', error)
    }
  }
}

/** Nome base do cache. Compartilhado com credential.ts para não divergirem. */
export const TOKEN_CACHE_NAME = 'azmd-tokens'
