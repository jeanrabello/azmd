/**
 * Formatação de tempo relativo em português, para timestamps vindos do main
 * (sempre ISO 8601). Curto de propósito: isso aparece em linhas de lista e no
 * header, onde espaço é escasso.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Idade de uma sincronização, com granularidade de segundos.
 *
 * Diferente de `formatRelativeTime`, que arredonda tudo abaixo de um minuto
 * para "agora": aqui o intervalo de polling costuma ser menor que isso, então
 * "agora" ficaria congelado na tela e não diria se o dado está fresco ou se o
 * polling travou. "há 12s" responde essa pergunta; "agora", não.
 */
export function formatSyncAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'unknown date'

  const diffMs = now.getTime() - then.getTime()
  // Pequena divergência de relógio não deve virar tempo negativo.
  if (diffMs < 5_000) return 'now'
  if (diffMs < MINUTE_MS) return `${Math.floor(diffMs / 1000)}s ago`

  return formatRelativeTime(iso, now)
}

/**
 * Converte um ISO string em texto relativo tipo "há 5min". Nunca lança —
 * datas inválidas (string vazia, formato quebrado) caem em "data desconhecida"
 * em vez de quebrar a UI, já que isso vem de fora (Azure/mock).
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) {
    return 'unknown date'
  }

  const diffMs = now.getTime() - then.getTime()

  // Relógio do sistema pode divergir um pouco do timestamp do servidor;
  // trata pequenas diferenças futuras como "agora" em vez de negativo.
  if (diffMs < MINUTE_MS) {
    return 'now'
  }

  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS)
    return `${minutes}min ago`
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS)
    return `${hours}h ago`
  }

  const days = Math.floor(diffMs / DAY_MS)
  if (days === 1) {
    return 'yesterday'
  }

  if (days < 7) {
    return `${days}d ago`
  }

  // Além de uma semana, texto relativo perde utilidade — mostra a data.
  return then.toLocaleDateString('en-US')
}
