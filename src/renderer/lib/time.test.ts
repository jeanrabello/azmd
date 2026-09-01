import { describe, expect, it } from 'vitest'
import { formatSyncAge, formatRelativeTime } from './time.js'

const BASE = new Date('2026-08-26T12:00:00.000Z')
const ago = (ms: number): string => new Date(BASE.getTime() - ms).toISOString()

/**
 * O bug que motivou isto: com polling de 60s e "agora" cobrindo tudo abaixo
 * de um minuto, o header ficava eternamente em "atualizado agora" — correto,
 * mas incapaz de distinguir dado fresco de polling travado.
 */
describe('formatSyncAge', () => {
  it('mostra segundos no primeiro minuto', () => {
    expect(formatSyncAge(ago(12_000), BASE)).toBe('12s ago')
    expect(formatSyncAge(ago(45_000), BASE)).toBe('45s ago')
  })

  it('só diz "agora" nos primeiros segundos', () => {
    expect(formatSyncAge(ago(0), BASE)).toBe('now')
    expect(formatSyncAge(ago(4_000), BASE)).toBe('now')
    expect(formatSyncAge(ago(6_000), BASE)).not.toBe('now')
  })

  it('passa para minutos e horas depois de 1min', () => {
    expect(formatSyncAge(ago(90_000), BASE)).toBe('1min ago')
    expect(formatSyncAge(ago(3 * 3600_000), BASE)).toBe('3h ago')
  })

  it('tolera relógio adiantado sem virar tempo negativo', () => {
    expect(formatSyncAge(new Date(BASE.getTime() + 3_000).toISOString(), BASE)).toBe('now')
  })

  it('não quebra com data inválida', () => {
    expect(formatSyncAge('', BASE)).toBe('unknown date')
  })
})

describe('formatRelativeTime segue arredondando', () => {
  it('mantém "agora" abaixo de um minuto — é o certo em linhas de lista', () => {
    expect(formatRelativeTime(ago(30_000), BASE)).toBe('now')
  })
})
