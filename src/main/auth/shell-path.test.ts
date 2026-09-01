import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findExecutable } from './shell-path.js'

/**
 * O bug que motivou este módulo: aberto pela GUI, o app recebe
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin — sem /opt/homebrew/bin, onde o `az`
 * mora. O mesmo app rodado pelo terminal funcionava, o que tornava a falha
 * confusa ("az login" já estava feito).
 *
 * Os testes montam o próprio PATH num diretório temporário em vez de procurar
 * binários reais: afirmar sobre `/bin/sh` amarrava o teste ao layout do
 * sistema (e não existe no Windows, onde o separador do PATH e as extensões
 * de executável também são outros).
 */

const IS_WINDOWS = process.platform === 'win32'
/** No Windows o `az` é um `az.cmd`; em Unix, um arquivo sem extensão. */
const AZ_FILE = IS_WINDOWS ? 'az.cmd' : 'az'

const root = mkdtempSync(join(tmpdir(), 'azmd-path-'))

/** Cria um diretório com os arquivos pedidos e devolve o caminho dele. */
function dirWith(name: string, ...files: string[]): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const file of files) writeFileSync(join(dir, file), '')
  return dir
}

function path(...dirs: string[]): string {
  return dirs.join(delimiter)
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findExecutable', () => {
  it('acha um binário que existe no PATH informado', () => {
    const dir = dirWith('has-az', AZ_FILE)
    expect(findExecutable('az', path(dir))).toBe(join(dir, AZ_FILE))
  })

  /* A ordem do PATH decide o empate: o primeiro diretório que contém o
   * binário vence, como no shell. */
  it('respeita a ordem do PATH quando o binário existe em mais de um lugar', () => {
    const first = dirWith('first', AZ_FILE)
    const second = dirWith('second', AZ_FILE)
    expect(findExecutable('az', path(first, second))).toBe(join(first, AZ_FILE))
    expect(findExecutable('az', path(second, first))).toBe(join(second, AZ_FILE))
  })

  it('não acha o que não está em nenhum dos diretórios', () => {
    const dir = dirWith('empty-dir')
    expect(findExecutable('binario-que-nao-existe', path(dir))).toBeUndefined()
  })

  it('ignora entradas vazias no PATH', () => {
    const dir = dirWith('gaps', AZ_FILE)
    const withGaps = `${delimiter}${dir}${delimiter}${delimiter}`
    expect(findExecutable('az', withGaps)).toBe(join(dir, AZ_FILE))
  })

  it('devolve undefined para PATH vazio', () => {
    expect(findExecutable('az', '')).toBeUndefined()
  })

  /*
   * O caso que fazia o modo Azure CLI falhar no Windows mesmo com a CLI
   * instalada: procurar um arquivo chamado `az` num diretório onde só existe
   * `az.cmd`. Quem resolve o nome é o PATHEXT, igual ao `cmd`.
   */
  it.runIf(IS_WINDOWS)('resolve o nome pelo PATHEXT no Windows', () => {
    const dir = dirWith('pathext', 'az.cmd')
    expect(findExecutable('az', path(dir))).toBe(join(dir, 'az.cmd'))
  })

  it.runIf(IS_WINDOWS)('aceita um nome que já traz a extensão', () => {
    const dir = dirWith('explicit-ext', 'azd.exe')
    expect(findExecutable('azd.exe', path(dir))).toBe(join(dir, 'azd.exe'))
  })
})
