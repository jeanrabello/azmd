import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Mesmo padrão do secret-store.test.ts: o `electron` não existe no runtime do
 * vitest, então mockamos os dois membros usados. A lógica de arquivo e as
 * decisões de segurança são testadas de verdade, com um userData temporário; só
 * a cifra é de brinquedo.
 */
const state = {
  userData: '',
  encryptionAvailable: true,
  decryptFails: false,
}

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (buffer: Buffer) => {
      if (state.decryptFails) throw new Error('keychain recusou')
      return Buffer.from(buffer).reverse().toString('utf8')
    },
  },
}))

const { TOKEN_CACHE_NAME, azmdCachePersistencePlugin, clearTokenCache } = await import(
  './token-cache-store.js'
)

/** Extrai o `ICachePlugin` que o plugin registra, como o @azure/identity faria. */
function pluginFor(name: string): {
  beforeCacheAccess: (ctx: { tokenCache: { deserialize: (d: string) => void } }) => Promise<void>
  afterCacheAccess: (ctx: {
    cacheHasChanged: boolean
    tokenCache: { serialize: () => string }
  }) => Promise<void>
} {
  let provider: ((opts: { name: string }) => unknown) | undefined
  azmdCachePersistencePlugin({
    cachePluginControl: {
      setPersistence: (p: unknown) => {
        provider = p as (opts: { name: string }) => unknown
      },
    },
  })
  if (!provider) throw new Error('plugin não registrou provider')
  return provider({ name }) as ReturnType<typeof pluginFor>
}

const CACHE_FILE = `msal-cache-${TOKEN_CACHE_NAME}.bin`
/** Payload no formato que o MSAL serializa — o conteúdo exato não importa. */
const CACHE_JSON = '{"RefreshToken":{"x":{"secret":"rt-super-secreto"}}}'

describe('token-cache-store', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'azmd-tokencache-'))
    state.encryptionAvailable = true
    state.decryptFails = false
  })

  afterEach(() => {
    rmSync(state.userData, { recursive: true, force: true })
  })

  it('registra o provider via cachePluginControl', () => {
    const setPersistence = vi.fn()
    azmdCachePersistencePlugin({ cachePluginControl: { setPersistence } })
    expect(setPersistence).toHaveBeenCalledOnce()
    expect(typeof setPersistence.mock.calls[0]?.[0]).toBe('function')
  })

  it('faz round-trip do cache pelo par before/afterCacheAccess', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)

    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => CACHE_JSON },
    })

    const deserialize = vi.fn()
    await plugin.beforeCacheAccess({ tokenCache: { deserialize } })
    expect(deserialize).toHaveBeenCalledWith(CACHE_JSON)
  })

  /*
   * A razão de o cache ser cifrado: aqui há refresh token, ao contrário do
   * auth-record.json. Quem lesse o arquivo em claro agiria como o usuário no
   * ARM até o refresh expirar.
   */
  it('não deixa o refresh token em texto plano no disco', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => CACHE_JSON },
    })

    const raw = readFileSync(join(state.userData, CACHE_FILE), 'utf8')
    expect(raw).not.toContain('rt-super-secreto')
    expect(raw).not.toContain('RefreshToken')
  })

  it('não grava quando o MSAL diz que nada mudou', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    const serialize = vi.fn(() => CACHE_JSON)
    await plugin.afterCacheAccess({ cacheHasChanged: false, tokenCache: { serialize } })

    expect(serialize).not.toHaveBeenCalled()
    expect(existsSync(join(state.userData, CACHE_FILE))).toBe(false)
  })

  it('não deixa arquivo .tmp para trás', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => CACHE_JSON },
    })
    expect(existsSync(join(state.userData, `${CACHE_FILE}.tmp`))).toBe(false)
  })

  /*
   * REGRA DURA, herdada do secret-store: sem Keychain o app funciona, só não
   * lembra a sessão. Gravar token em texto plano "para funcionar" trocaria um
   * relogin ocasional por um vazamento permanente.
   */
  it('não grava nada quando não há encriptação disponível', async () => {
    state.encryptionAvailable = false
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => CACHE_JSON },
    })
    expect(existsSync(join(state.userData, CACHE_FILE))).toBe(false)
  })

  it('trata cache ausente como "sem sessão", sem lançar', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    const deserialize = vi.fn()
    await expect(plugin.beforeCacheAccess({ tokenCache: { deserialize } })).resolves.toBeUndefined()
    expect(deserialize).not.toHaveBeenCalled()
  })

  it('sobrevive ao Keychain recusando a leitura', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => CACHE_JSON },
    })

    state.decryptFails = true
    const deserialize = vi.fn()
    await expect(plugin.beforeCacheAccess({ tokenCache: { deserialize } })).resolves.toBeUndefined()
    expect(deserialize).not.toHaveBeenCalled()
  })

  /* Cache de formato incompatível (upgrade do MSAL) é descartável, não fatal. */
  it('não propaga erro quando o cache é ilegível para o MSAL', async () => {
    const plugin = pluginFor(TOKEN_CACHE_NAME)
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => 'lixo-que-o-msal-rejeita' },
    })

    const deserialize = vi.fn(() => {
      throw new Error('formato inválido')
    })
    await expect(plugin.beforeCacheAccess({ tokenCache: { deserialize } })).resolves.toBeUndefined()
  })

  /*
   * O nome vem do @azure/identity e acaba num caminho de arquivo: um nome com
   * `/` ou `..` escreveria fora do userData.
   */
  it('sanitiza o nome do cache para não escapar do userData', async () => {
    const plugin = pluginFor('../../fora')
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => CACHE_JSON },
    })
    expect(existsSync(join(state.userData, 'msal-cache-.._.._fora.bin'))).toBe(true)
  })

  /*
   * Parte do sign-out: sem isso o refresh token continuaria no disco e a
   * próxima abertura reautenticaria sozinha quem pediu para sair.
   */
  it('clearTokenCache apaga os arquivos de cache', async () => {
    for (const suffix of ['', '.nocae', '.cae']) {
      writeFileSync(join(state.userData, `msal-cache-${TOKEN_CACHE_NAME}${suffix}.bin`), 'x')
    }
    clearTokenCache()
    for (const suffix of ['', '.nocae', '.cae']) {
      expect(existsSync(join(state.userData, `msal-cache-${TOKEN_CACHE_NAME}${suffix}.bin`))).toBe(
        false,
      )
    }
  })

  it('clearTokenCache é idempotente', () => {
    expect(() => {
      clearTokenCache()
      clearTokenCache()
    }).not.toThrow()
  })
})
