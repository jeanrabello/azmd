import { describe, expect, it } from 'vitest'
import { sanitizeSettings } from './settings-store.js'
import { DEFAULT_SETTINGS, POLL_INTERVAL_BOUNDS } from '../shared/types.js'

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
})
