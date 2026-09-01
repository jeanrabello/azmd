import {
  AuthenticationRequiredError,
  ChainedTokenCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
} from '@azure/identity'
import { describe, expect, it, vi } from 'vitest'
import { AuthConfigError, createAzureCredential, probeCredential, signInWithDeviceCode } from './credential.js'
import type { AuthConfig } from '../../shared/types.js'
import type { AccessToken, TokenCredential } from '@azure/core-auth'

/**
 * Esta é a única função do app que decide *qual* credencial usar; todo o resto
 * só conhece `TokenCredential`. Um erro aqui aparece como 401 misterioso muito
 * longe daqui, então o que se testa é a escolha e as mensagens de config.
 *
 * Nada aqui fala com a rede: `createAzureCredential` só constrói objetos, e o
 * `probeCredential` recebe credenciais falsas.
 */

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { mode: 'deviceCode', hasClientSecret: false, ...overrides }
}

/** JWT falso: só o payload importa, porque não validamos assinatura. */
function fakeJwt(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `cabecalho.${encoded}.assinatura`
}

function credentialThat(behavior: () => Promise<AccessToken | null>): TokenCredential {
  return { getToken: behavior }
}

describe('createAzureCredential', () => {
  it('usa ClientSecretCredential em servicePrincipal completo', () => {
    const credential = createAzureCredential({
      config: config({ mode: 'servicePrincipal', tenantId: 't', clientId: 'c', hasClientSecret: true }),
      clientSecret: 's',
    })
    expect(credential).toBeInstanceOf(ClientSecretCredential)
  })

  it('usa DeviceCodeCredential em deviceCode', () => {
    expect(createAzureCredential({ config: config() })).toBeInstanceOf(DeviceCodeCredential)
  })

  it('preserva a cadeia em azureCli', () => {
    expect(createAzureCredential({ config: config({ mode: 'azureCli' }) })).toBeInstanceOf(
      ChainedTokenCredential,
    )
  })

  // Cada campo isolado: a mensagem tem que dizer *qual* falta, senão o usuário
  // fica olhando três campos preenchidos sem saber qual está errado.
  const spBase = { mode: 'servicePrincipal' as const, hasClientSecret: true }

  it('acusa Tenant ID faltando', () => {
    expect(() =>
      createAzureCredential({ config: config({ ...spBase, clientId: 'c' }), clientSecret: 's' }),
    ).toThrow(/Tenant ID/)
  })

  it('acusa Client ID faltando', () => {
    expect(() =>
      createAzureCredential({ config: config({ ...spBase, tenantId: 't' }), clientSecret: 's' }),
    ).toThrow(/Client ID/)
  })

  it('acusa Client Secret faltando', () => {
    expect(() =>
      createAzureCredential({ config: config({ ...spBase, tenantId: 't', clientId: 'c' }) }),
    ).toThrow(/Client Secret/)
  })

  it('lança AuthConfigError, distinguível de erro de rede', () => {
    let caught: unknown
    try {
      createAzureCredential({ config: config({ mode: 'servicePrincipal', hasClientSecret: false }) })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AuthConfigError)
    expect((caught as AuthConfigError).kind).toBe('authConfig')
  })

  it('lista todos os campos faltantes de uma vez', () => {
    expect(() =>
      createAzureCredential({ config: config({ mode: 'servicePrincipal', hasClientSecret: false }) }),
    ).toThrow(/Tenant ID, Client ID, Client Secret/)
  })
})

describe('probeCredential', () => {
  it('extrai o tenantId do claim tid', async () => {
    const result = await probeCredential(
      credentialThat(async () => ({
        token: fakeJwt({ tid: 'tenant-abc' }),
        expiresOnTimestamp: Date.now() + 60_000,
      })),
    )
    expect(result).toEqual({ ok: true, tenantId: 'tenant-abc' })
  })

  it('segue ok sem tenantId quando o token é opaco', async () => {
    const result = await probeCredential(
      credentialThat(async () => ({ token: 'nao-e-jwt', expiresOnTimestamp: 0 })),
    )
    expect(result).toEqual({ ok: true })
  })

  it('trata token nulo como falha', async () => {
    const result = await probeCredential(credentialThat(async () => null))
    expect(result.ok).toBe(false)
  })

  it('marca needsSignIn quando falta autenticação interativa', async () => {
    const result = await probeCredential(
      credentialThat(async () => {
        throw new AuthenticationRequiredError({ scopes: ['https://management.azure.com/.default'] })
      }),
    )
    expect(result).toMatchObject({ ok: false, needsSignIn: true })
  })

  it('reconhece o erro pelo name, quando a classe não é a mesma instância', async () => {
    const result = await probeCredential(
      credentialThat(async () => {
        const error = new Error('silent auth falhou')
        error.name = 'AuthenticationRequiredError'
        throw error
      }),
    )
    expect(result).toMatchObject({ ok: false, needsSignIn: true })
  })

  it('reconhece o erro embrulhado por uma AggregateAuthenticationError', async () => {
    const result = await probeCredential(
      credentialThat(async () => {
        const inner = new Error('interactive authentication is needed')
        inner.name = 'AuthenticationRequiredError'
        throw Object.assign(new Error('todas as credenciais falharam'), { errors: [inner] })
      }),
    )
    expect(result).toMatchObject({ ok: false, needsSignIn: true })
  })

  it('não marca needsSignIn em erro comum: 403 não é "precisa logar"', async () => {
    const result = await probeCredential(
      credentialThat(async () => {
        throw new Error('AuthorizationFailed: sem permissão na subscription')
      }),
    )
    expect(result).toEqual({ ok: false, error: expect.any(Error) })
    expect((result as { needsSignIn?: boolean }).needsSignIn).toBeUndefined()
  })

  it('não abre fluxo interativo: só chama getToken', async () => {
    const getToken = vi.fn(async () => null)
    await probeCredential({ getToken } as unknown as TokenCredential)
    expect(getToken).toHaveBeenCalledOnce()
  })
})

describe('signInWithDeviceCode', () => {
  it('recusa modos não interativos', async () => {
    await expect(
      signInWithDeviceCode({ config: config({ mode: 'azureCli' }) }),
    ).rejects.toBeInstanceOf(AuthConfigError)
    await expect(
      signInWithDeviceCode({ config: config({ mode: 'servicePrincipal', hasClientSecret: true }) }),
    ).rejects.toBeInstanceOf(AuthConfigError)
  })

  it('monta a conta a partir do record devolvido', async () => {
    const record = {
      authority: 'login.microsoftonline.com',
      homeAccountId: 'home',
      clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
      tenantId: 'tenant-1',
      username: 'jean@exemplo.com',
    }
    const authenticate = vi
      .spyOn(DeviceCodeCredential.prototype, 'authenticate')
      .mockResolvedValue(record)

    const result = await signInWithDeviceCode({ config: config() })

    expect(result.record).toEqual(record)
    expect(result.account).toEqual({ username: 'jean@exemplo.com', tenantId: 'tenant-1' })
    // `authenticate` e não `getToken`: é o único que ignora
    // disableAutomaticAuthentication e portanto pode emitir o código.
    expect(authenticate).toHaveBeenCalledWith('https://management.azure.com/.default')
    authenticate.mockRestore()
  })

  /*
   * REGRESSÃO: "Automatic authentication has been disabled" logo após o login.
   *
   * O token do device code vive no cache em memória da instância que chamou
   * `authenticate()`. A primeira versão devolvia só o record e descartava a
   * credencial; quem consultava montava outra, com cache vazio, e como
   * `disableAutomaticAuthentication` proíbe emitir código fora do login, a
   * consulta falhava. Devolver a instância é o que fecha esse buraco — este
   * teste existe para ninguém "limpar" o retorno de novo.
   */
  it('devolve a credencial autenticada, não só o record', async () => {
    const record = {
      authority: 'login.microsoftonline.com',
      homeAccountId: 'home',
      clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
      tenantId: 'tenant-1',
      username: 'jean@exemplo.com',
    }
    const authenticate = vi
      .spyOn(DeviceCodeCredential.prototype, 'authenticate')
      .mockResolvedValue(record)

    const result = await signInWithDeviceCode({ config: config() })

    // Tem que ser a MESMA instância que autenticou — é ela que guarda o token.
    expect(result.credential).toBeInstanceOf(DeviceCodeCredential)
    expect(authenticate.mock.instances[0]).toBe(result.credential)

    authenticate.mockRestore()
  })

  it('falha com mensagem clara quando ninguém concluiu o login', async () => {
    const authenticate = vi
      .spyOn(DeviceCodeCredential.prototype, 'authenticate')
      .mockResolvedValue(undefined)

    await expect(signInWithDeviceCode({ config: config() })).rejects.toThrow(/não foi concluído/i)
    authenticate.mockRestore()
  })
})
