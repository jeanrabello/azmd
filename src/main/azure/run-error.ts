import type { RunError } from '../../shared/types.js'

/**
 * Extração da mensagem de erro de um run.
 *
 * Existe porque o SDK tipa `WorkflowRun.error` como `any` e o formato varia
 * na prática. Já foram observados, para o mesmo campo:
 *
 *   { code, message }
 *   { error: { code, message } }            // aninhado um nível
 *   { code, message, details: [ {...} ] }   // detalhe útil só no array
 *   "string solta"
 *   undefined                               // e o motivo está em run.code
 *
 * Ler só `error.message` — como fazíamos — devolve `undefined` em vários
 * desses casos, e a UI acabava mostrando "Falha sem mensagem detalhada" para
 * um run que na verdade tinha motivo. Aqui tentamos os formatos conhecidos em
 * ordem e, em último caso, preservamos o payload cru para a tela de detalhes.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Serializa o payload cru para exibição, sem estourar a UI. */
function serializeRaw(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined
  try {
    const text = typeof error === 'string' ? error : JSON.stringify(error, null, 2)
    if (!text || text === '{}' || text === '""') return undefined
    const LIMIT = 4000
    return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…(truncado)` : text
  } catch {
    return undefined
  }
}

/**
 * Normaliza o erro de um run.
 *
 * `runStatus` e `runCode` entram porque um run pode falhar sem payload de
 * erro nenhum — nesse caso o `code` do run (ex.: 'ActionFailed') é a única
 * informação disponível, e é melhor que um texto genérico.
 */
export function extractRunError(
  error: unknown,
  runCode?: string,
): RunError | undefined {
  const raw = serializeRaw(error)

  if (typeof error === 'string' && error.trim().length > 0) {
    return { message: error, ...(runCode ? { code: runCode } : {}), ...(raw ? { raw } : {}) }
  }

  const record = asRecord(error)
  // Alguns retornos embrulham o erro real em `error.error`.
  const inner = record ? (asRecord(record['error']) ?? record) : undefined

  let message: string | undefined
  let code: string | undefined

  if (inner) {
    message = stringField(inner, 'message')
    code = stringField(inner, 'code')

    // Quando a mensagem do topo é vazia, o motivo costuma estar no primeiro
    // item de `details`.
    if (!message) {
      const details = inner['details']
      const first = Array.isArray(details) ? asRecord(details[0]) : undefined
      if (first) {
        message = stringField(first, 'message')
        code ??= stringField(first, 'code')
      }
    }
  }

  code ??= runCode

  if (!message && !code && !raw) return undefined

  return {
    message: message ?? fallbackMessage(code),
    ...(code ? { code } : {}),
    ...(raw ? { raw } : {}),
  }
}

function fallbackMessage(code: string | undefined): string {
  return code
    ? `Run terminou com falha (${code}). O Azure não retornou uma mensagem.`
    : 'Run terminou com falha. O Azure não retornou uma mensagem.'
}
