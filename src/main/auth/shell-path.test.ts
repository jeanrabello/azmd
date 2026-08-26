import { describe, expect, it } from 'vitest'
import { findExecutable } from './shell-path.js'

/**
 * O bug que motivou este módulo: aberto pela GUI, o app recebe
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin — sem /opt/homebrew/bin, onde o `az`
 * mora. O mesmo app rodado pelo terminal funcionava, o que tornava a falha
 * confusa ("az login" já estava feito).
 */
describe('findExecutable', () => {
  it('acha um binário que existe no PATH informado', () => {
    // /bin/sh existe em qualquer macOS/Linux.
    expect(findExecutable('sh', '/usr/bin:/bin')).toBe('/bin/sh')
  })

  it('não acha o que não está em nenhum dos diretórios', () => {
    expect(findExecutable('binario-que-nao-existe', '/usr/bin:/bin')).toBeUndefined()
  })

  it('ignora entradas vazias no PATH', () => {
    expect(findExecutable('sh', ':/bin::')).toBe('/bin/sh')
  })

  it('devolve undefined para PATH vazio', () => {
    expect(findExecutable('sh', '')).toBeUndefined()
  })
})
