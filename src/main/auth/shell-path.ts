import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Recupera o PATH real quando o app é aberto pela GUI.
 *
 * O PROBLEMA
 * Um app aberto pelo Finder/Dock não herda o ambiente do shell: o macOS lhe dá
 * apenas `/usr/bin:/bin:/usr/sbin:/sbin`. O `az` mora em `/opt/homebrew/bin`
 * (ou `/usr/local/bin` em Intel), que vem do perfil do shell — então o
 * `AzureCliCredential` falha com "Azure CLI could not be found", enquanto o
 * mesmo app rodado pelo terminal funciona. Medido: PATH do terminal tem 30+
 * entradas; o da GUI, quatro.
 *
 * A SOLUÇÃO, em duas camadas
 *  1. Diretórios conhecidos onde as CLIs se instalam — cobre o caso comum sem
 *     custo nenhum e sem depender de subprocesso.
 *  2. Se ainda assim o `az` não aparecer, perguntar ao shell de login qual é o
 *     PATH dele. É mais lento (roda o perfil do usuário), por isso fica como
 *     segunda tentativa e com timeout curto.
 *
 * Nada disso executa o `az`; só descobre onde ele está.
 */

/** Onde as CLIs do Azure costumam ficar, em ordem de probabilidade. */
function candidateDirs(): string[] {
  const home = homedir()
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
  return (value ?? '').split(':').filter((entry) => entry.length > 0)
}

/** Procura um executável nos diretórios do PATH informado. */
export function findExecutable(name: string, pathValue: string): string | undefined {
  for (const dir of pathEntries(pathValue)) {
    const candidate = `${dir}/${name}`
    if (existsSync(candidate)) return candidate
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
      if (!seen.has(dir)) {
        seen.add(dir)
        merged.push(dir)
      }
    }
  }
  return merged.join(':')
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
  const withCandidates = mergePath(original, candidateDirs().join(':'))
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
