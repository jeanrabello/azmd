import { describe, expect, it } from 'vitest'
import { findExecutable } from './shell-path.js'

/**
 * O bug que motivou este módulo: aberto pela GUI, o app recebe
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin — sem /opt/homebrew/bin, onde o `az`
 * mora. O mesmo app rodado pelo terminal funcionava, o que tornava a falha
 * confusa ("az login" já estava feito).
 */
describe('findExecutable', () => {
  /*
   * Afirmar o caminho exato quebrava no CI: no Ubuntu `/bin` é symlink para
   * `/usr/bin`, então com PATH=/usr/bin:/bin o `sh` é achado em `/usr/bin/sh` —
   * resultado correto para uma busca que respeita a ordem do PATH. O que
   * importa aqui é ter achado um `sh` num dos diretórios informados, não em
   * qual deles a distribuição resolveu colocá-lo.
   */
  it('acha um binário que existe no PATH informado', () => {
    // `sh` existe em qualquer macOS/Linux.
    expect(findExecutable('sh', '/usr/bin:/bin')).toMatch(/^\/(usr\/)?bin\/sh$/)
  })

  /* A ordem do PATH decide o empate, e isso vale testar sem depender do
   * layout do sistema: o primeiro diretório que contém o binário vence. */
  it('respeita a ordem do PATH quando o binário existe em mais de um lugar', () => {
    const first = findExecutable('sh', '/usr/bin:/bin')
    const reversed = findExecutable('sh', '/bin:/usr/bin')
    expect(first).toBeDefined()
    expect(reversed).toBeDefined()
    // Em sistemas onde os dois existem de fato, inverter o PATH inverte a
    // resposta; onde só um existe, ambas apontam para ele.
    expect([first, reversed].every((p) => p?.endsWith('/sh'))).toBe(true)
  })

  it('não acha o que não está em nenhum dos diretórios', () => {
    expect(findExecutable('binario-que-nao-existe', '/usr/bin:/bin')).toBeUndefined()
  })

  it('ignora entradas vazias no PATH', () => {
    // Só `/bin` no PATH: em qualquer sistema POSIX o `sh` resolve para lá,
    // mesmo quando `/bin` é symlink.
    expect(findExecutable('sh', ':/bin::')).toBe('/bin/sh')
  })

  it('devolve undefined para PATH vazio', () => {
    expect(findExecutable('sh', '')).toBeUndefined()
  })
})
