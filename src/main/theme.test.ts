import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * O `electron` não existe no runtime do vitest. Mockamos só o `nativeTheme`,
 * que é a única dependência do módulo — o resto da lógica é testado de verdade.
 */
const state = { shouldUseDarkColors: false, themeSource: 'system' as string }

vi.mock('electron', () => ({
  nativeTheme: {
    get shouldUseDarkColors() {
      return state.shouldUseDarkColors
    },
    get themeSource() {
      return state.themeSource
    },
    set themeSource(value: string) {
      state.themeSource = value
    },
  },
}))

const { applyThemeSource, resolveTheme } = await import('./theme.js')

afterEach(() => {
  state.shouldUseDarkColors = false
  state.themeSource = 'system'
})

describe('resolveTheme', () => {
  /*
   * A escolha explícita tem que ganhar do sistema — é o ponto de existir a
   * preferência. Sem isto, "Light" num Windows escuro não teria efeito e o
   * ícone continuaria invisível, que é o bug que motivou o recurso.
   */
  it('respeita a escolha explícita, contrariando o sistema', () => {
    state.shouldUseDarkColors = true
    expect(resolveTheme('light')).toBe('light')

    state.shouldUseDarkColors = false
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('segue o sistema quando a preferência é system', () => {
    state.shouldUseDarkColors = true
    expect(resolveTheme('system')).toBe('dark')

    state.shouldUseDarkColors = false
    expect(resolveTheme('system')).toBe('light')
  })

  /* Nunca devolve 'system': quem consome precisa de uma cor para pintar. */
  it('resolve sempre para light ou dark', () => {
    for (const preference of ['system', 'light', 'dark'] as const) {
      expect(['light', 'dark']).toContain(resolveTheme(preference))
    }
  })
})

describe('applyThemeSource', () => {
  it('repassa a preferência ao Electron', () => {
    applyThemeSource('dark')
    expect(state.themeSource).toBe('dark')

    applyThemeSource('system')
    expect(state.themeSource).toBe('system')
  })
})
