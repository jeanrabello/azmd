import { describe, expect, it } from 'vitest'
import { sanitizeAuth, sanitizeSettings } from './settings-store.js'
import {
  DEFAULT_AUTH_CONFIG,
  DEFAULT_SETTINGS,
  POLL_INTERVAL_BOUNDS,
  type AuthConfig,
} from '../shared/types.js'

/**
 * O sanitize é a fronteira de confiança: recebe JSON de disco e patches do
 * renderer. Se ele deixar passar lixo, o resto do main quebra longe daqui.
 */
describe('sanitizeSettings', () => {
  it('devolve os padrões para entrada inválida', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('texto')).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('limita o intervalo de polling aos limites', () => {
    expect(sanitizeSettings({ pollIntervalSeconds: 1 }).pollIntervalSeconds).toBe(
      POLL_INTERVAL_BOUNDS.min,
    )
    expect(sanitizeSettings({ pollIntervalSeconds: 99999 }).pollIntervalSeconds).toBe(
      POLL_INTERVAL_BOUNDS.max,
    )
    expect(sanitizeSettings({ pollIntervalSeconds: Number.NaN }).pollIntervalSeconds).toBe(
      POLL_INTERVAL_BOUNDS.min,
    )
  })

  it('aceita apenas modos conhecidos', () => {
    expect(sanitizeSettings({ mode: 'azure' }).mode).toBe('azure')
    expect(sanitizeSettings({ mode: 'demo' }).mode).toBe('demo')
    expect(sanitizeSettings({ mode: 'hackeado' }).mode).toBe(DEFAULT_SETTINGS.mode)
  })

  it('descarta itens não-string dentro do escopo', () => {
    const settings = sanitizeSettings({
      scope: { subscriptionIds: ['ok', 42, null], resourceGroups: 'não é array' },
    })
    expect(settings.scope.subscriptionIds).toEqual(['ok'])
    expect(settings.scope.resourceGroups).toEqual([])
  })

  it('omite tenantId vazio em vez de gravar string vazia', () => {
    expect(sanitizeSettings({ tenantId: '' }).tenantId).toBeUndefined()
    expect(sanitizeSettings({ tenantId: 'abc' }).tenantId).toBe('abc')
  })

  it('assume o auth padrão quando o settings.json é legado', () => {
    // settings.json gravado antes de existir autenticação configurável não tem
    // o bloco `auth`. Precisa carregar, não explodir.
    expect(sanitizeSettings({ mode: 'azure', pollIntervalSeconds: 60 }).auth).toEqual(
      DEFAULT_AUTH_CONFIG,
    )
  })
})

/**
 * O `auth` é a parte do settings com risco diferente do resto: um campo que
 * escape aqui não vira só configuração errada, vira segredo em texto plano no
 * disco do usuário.
 */
describe('sanitizeAuth', () => {
  const base: AuthConfig = DEFAULT_AUTH_CONFIG

  it('aceita apenas os três modos conhecidos', () => {
    expect(sanitizeAuth({ mode: 'deviceCode' }, base).mode).toBe('deviceCode')
    expect(sanitizeAuth({ mode: 'servicePrincipal' }, base).mode).toBe('servicePrincipal')
    expect(sanitizeAuth({ mode: 'azureCli' }, base).mode).toBe('azureCli')
    expect(sanitizeAuth({ mode: 'inventado' }, base).mode).toBe(base.mode)
    expect(sanitizeAuth({ mode: 42 }, base).mode).toBe(base.mode)
  })

  it('descarta um clientSecret que apareça na entrada', () => {
    const result = sanitizeAuth(
      { mode: 'servicePrincipal', clientId: 'app-1', clientSecret: 'super-secreto' },
      base,
    )
    // Nem como campo, nem escondido em qualquer canto do objeto serializado:
    // é isso que garante que o secret não chega ao settings.json.
    expect(result).not.toHaveProperty('clientSecret')
    expect(JSON.stringify(result)).not.toContain('super-secreto')
  })

  it('ignora hasClientSecret da entrada e preserva o do base', () => {
    // Quem sabe se há secret é o Keychain, não o JSON.
    expect(sanitizeAuth({ hasClientSecret: true }, base).hasClientSecret).toBe(false)
    expect(
      sanitizeAuth({ hasClientSecret: false }, { ...base, hasClientSecret: true })
        .hasClientSecret,
    ).toBe(true)
  })

  it('herda tenantId e clientId do base quando vazios ou inválidos', () => {
    const withIds: AuthConfig = { ...base, tenantId: 't1', clientId: 'c1' }
    expect(sanitizeAuth({ tenantId: '', clientId: 42 }, withIds)).toMatchObject({
      tenantId: 't1',
      clientId: 'c1',
    })
    expect(sanitizeAuth({ tenantId: 't2' }, withIds).tenantId).toBe('t2')
  })

  it('omite a conta quando falta username ou tenantId', () => {
    expect(sanitizeAuth({ account: { username: 'a@b.com' } }, base).account).toBeUndefined()
    expect(sanitizeAuth({ account: { tenantId: 't1' } }, base).account).toBeUndefined()
    expect(sanitizeAuth({ account: 'a@b.com' }, base).account).toBeUndefined()
    expect(
      sanitizeAuth({ account: { username: 'a@b.com', tenantId: 't1' } }, base).account,
    ).toEqual({ username: 'a@b.com', tenantId: 't1' })
  })

  it('devolve o base inteiro para entrada que não é objeto', () => {
    expect(sanitizeAuth(null, base)).toBe(base)
    expect(sanitizeAuth('deviceCode', base)).toBe(base)
    expect(sanitizeAuth(undefined, base)).toBe(base)
  })
})
