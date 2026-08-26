/**
 * Formatação de tempo relativo em português, para timestamps vindos do main
 * (sempre ISO 8601). Curto de propósito: isso aparece em linhas de lista e no
 * header, onde espaço é escasso.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Converte um ISO string em texto relativo tipo "há 5min". Nunca lança —
 * datas inválidas (string vazia, formato quebrado) caem em "data desconhecida"
 * em vez de quebrar a UI, já que isso vem de fora (Azure/mock).
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) {
    return 'data desconhecida'
  }

  const diffMs = now.getTime() - then.getTime()

  // Relógio do sistema pode divergir um pouco do timestamp do servidor;
  // trata pequenas diferenças futuras como "agora" em vez de negativo.
  if (diffMs < MINUTE_MS) {
    return 'agora'
  }

  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS)
    return `há ${minutes}min`
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS)
    return `há ${hours}h`
  }

  const days = Math.floor(diffMs / DAY_MS)
  if (days === 1) {
    return 'ontem'
  }

  if (days < 7) {
    return `há ${days}d`
  }

  // Além de uma semana, texto relativo perde utilidade — mostra a data.
  return then.toLocaleDateString('pt-BR')
}
