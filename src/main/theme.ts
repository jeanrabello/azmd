import { nativeTheme } from 'electron'
import type { Theme } from '../shared/types.js'

/**
 * Resolve a preferência de tema para o que de fato vai ser pintado.
 *
 * POR QUE ISTO EXISTE NUM MÓDULO SÓ
 * Dois consumidores precisam da mesma resposta: o popover (via `resolvedTheme`
 * no AppState) e o ícone da bandeja (que escolhe entre o glifo claro e o
 * escuro). Se cada um resolvesse por conta própria, um sistema em modo escuro
 * com o app em `system` poderia acabar com UI escura e ícone escuro — invisível
 * na barra. Resolver aqui é o que mantém os dois de acordo.
 *
 * POR QUE `nativeTheme` E NÃO `prefers-color-scheme`
 * A media query responde pelo Chromium do renderer; o `nativeTheme` responde
 * pelo Electron, que é quem também governa a vibrancy da janela e é a única
 * fonte disponível no main, onde o ícone é escolhido.
 */
export function resolveTheme(preference: Theme): 'light' | 'dark' {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * Aplica a preferência ao Electron.
 *
 * `themeSource` é o que faz a janela repintar a vibrancy e o que mantém
 * `shouldUseDarkColors` coerente com a escolha do usuário — sem isto, forçar
 * 'light' mudaria o CSS mas deixaria a moldura nativa no tema do sistema.
 */
export function applyThemeSource(preference: Theme): void {
  nativeTheme.themeSource = preference
}
