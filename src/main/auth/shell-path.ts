import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IS_WINDOWS = process.platform === 'win32'

/**
 * Recupera o PATH real quando o app é aberto pela GUI.
 *
 * O PROBLEMA (macOS, e em menor grau Linux)
 * Um app aberto pelo Finder/Dock não herda o ambiente do shell: o macOS lhe dá
 * apenas `/usr/bin:/bin:/usr/sbin:/sbin`. O `az` mora em `/opt/homebrew/bin`
 * (ou `/usr/local/bin` em Intel), que vem do perfil do shell — então o
 * `AzureCliCredential` falha com "Azure CLI could not be found", enquanto o
 * mesmo app rodado pelo terminal funciona. Medido: PATH do terminal tem 30+
 * entradas; o da GUI, quatro.
 *
 * NO WINDOWS o PATH vem do registro e é idêntico para GUI e terminal, então
 * não há nada a recuperar — mas o instalador da Azure CLI só acrescenta o
 * `wbin` ao PATH do usuário, que sessões abertas antes da instalação não
 * enxergam. Por isso a camada 1 vale nas duas plataformas; a camada 2, não.
 *
 * A SOLUÇÃO, em duas camadas
 *  1. Diretórios conhecidos onde as CLIs se instalam — cobre o caso comum sem
 *     custo nenhum e sem depender de subprocesso.
 *  2. Se ainda assim o `az` não aparecer, perguntar ao shell de login qual é o
 *     PATH dele. É mais lento (roda o perfil do usuário), por isso fica como
 *     segunda tentativa e com timeout curto. Só Unix.
 *
 * Nada disso executa o `az`; só descobre onde ele está.
 */

/** Onde as CLIs do Azure costumam ficar, em ordem de probabilidade. */
function candidateDirs(): string[] {
  const home = homedir()

  if (IS_WINDOWS) {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    return [
      // Instalador MSI oficial (o de 64 bits ainda escreve em Program Files (x86)).
      join(programFilesX86, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin'),
      join(programFiles, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin'),
      // Instalação por usuário (winget/MSI per-user).
      join(localAppData, 'Programs', 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin'),
      // Azure Developer CLI.
      join(programFiles, 'Azure Dev CLI'),
      join(localAppData, 'Programs', 'Azure Dev CLI'),
      // `pip install --user azure-cli`.
      join(home, '.azure', 'bin'),
    ]
  }

  return [
    '/opt/homebrew/bin', // Homebrew em Apple Silicon
    '/usr/local/bin', // Homebrew em Intel, instaladores .pkg
    '/opt/homebrew/sbin',
    `${home}/.azure/bin`,
    `${home}/.local/bin`,
    `${home}/bin`,
    '/usr/local/microsoft/azd', // Azure Developer CLI
  ]
}

function pathEntries(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).filter((entry) => entry.length > 0)
}

/**
 * Nomes de arquivo que valem como "o executável `name`".
 *
 * No Windows o `az` é um `az.cmd`, não um arquivo sem extensão: procurar pelo
 * nome cru nunca acharia nada. Quem decide o que conta como executável é o
 * PATHEXT — o mesmo critério que o `cmd` usa para resolver o comando.
 */
function executableNames(name: string): string[] {
  if (!IS_WINDOWS || extname(name).length > 0) return [name]
  const exts = pathExtEntries()
  return exts.map((ext) => `${name}${ext.toLowerCase()}`)
}

function pathExtEntries(): string[] {
  const raw = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD'
  const entries = raw.split(';').filter((ext) => ext.length > 0)
  return entries.length > 0 ? entries : ['.COM', '.EXE', '.BAT', '.CMD']
}

/** Procura um executável nos diretórios do PATH informado. */
export function findExecutable(name: string, pathValue: string): string | undefined {
  const names = executableNames(name)
  for (const dir of pathEntries(pathValue)) {
    for (const candidate of names) {
      const full = join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * Pergunta ao shell de login qual é o PATH dele.
 *
 * `-l` faz o shell carregar o perfil do usuário, que é onde Homebrew, nvm e
 * afins entram no PATH. Usamos `-c 'printf %s $PATH'` para não depender de
 * `echo`, cujo comportamento varia entre shells.
 */
async function pathFromLoginShell(): Promise<string | undefined> {
  // No Windows não há perfil de shell a consultar: o PATH do processo já é o
  // do registro, e abrir um `cmd`/PowerShell não acrescentaria nada.
  if (IS_WINDOWS) return undefined

  const shell = process.env['SHELL']
  if (!shell) return undefined

  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
      timeout: 5_000,
      // O perfil pode imprimir coisas; só nos interessa o stdout do printf.
      encoding: 'utf8',
    })
    const value = stdout.trim()
    return value.length > 0 ? value : undefined
  } catch {
    // Shell exótico, perfil que trava, timeout: seguimos com os candidatos.
    return undefined
  }
}

function mergePath(...parts: (string | undefined)[]): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const part of parts) {
    for (const dir of pathEntries(part)) {
      // No Windows o PATH é case-insensitive; deduplicar por comparação exata
      // deixaria `C:\Windows` e `c:\windows` entrarem os dois.
      const key = IS_WINDOWS ? dir.toLowerCase() : dir
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(dir)
      }
    }
  }
  return merged.join(delimiter)
}

export interface PathRepairResult {
  /** true se o `az` está acessível ao final. */
  readonly azFound: boolean
  /** Caminho do `az`, quando encontrado. */
  readonly azPath?: string
  /** true se precisamos consultar o shell de login. */
  readonly usedLoginShell: boolean
}

/**
 * Garante que `process.env.PATH` inclua os diretórios das CLIs do Azure.
 *
 * Idempotente: chamar de novo não duplica entradas. Deve rodar ANTES de
 * qualquer credencial ser construída.
 */
export async function ensureCliPath(): Promise<PathRepairResult> {
  const original = process.env['PATH'] ?? ''

  // 1) Caminhos conhecidos — barato e resolve a maioria dos casos.
  const withCandidates = mergePath(original, candidateDirs().join(delimiter))
  process.env['PATH'] = withCandidates

  let azPath = findExecutable('az', withCandidates)
  if (azPath) return { azFound: true, azPath, usedLoginShell: false }

  // 2) Só então pagamos o custo de abrir um shell de login.
  const shellPath = await pathFromLoginShell()
  if (shellPath) {
    const merged = mergePath(withCandidates, shellPath)
    process.env['PATH'] = merged
    azPath = findExecutable('az', merged)
  }

  return azPath
    ? { azFound: true, azPath, usedLoginShell: true }
    : { azFound: false, usedLoginShell: shellPath !== undefined }
}
