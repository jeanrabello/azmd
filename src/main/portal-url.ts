import type { WorkflowRun } from '../shared/types.js'

/**
 * Construção de deep links para o portal do Azure.
 *
 * ⚠️ AVISO DE MANUTENÇÃO
 * O formato da blade de um run *específico* não é uma API pública e já mudou
 * entre versões do portal. O plano (seção 13) pede validação manual: abrir um
 * run falho no portal, copiar a URL real e conferir contra os templates abaixo.
 *
 * Por isso, todo o conhecimento frágil está concentrado nas duas constantes
 * `*_RUN_TEMPLATE`. Se o formato mudar, o conserto é editar aqui e nada mais.
 * `buildRunsListUrl` usa o formato estável e serve de fallback: é sempre melhor
 * cair na lista de runs do que num 404.
 */

const PORTAL_ORIGIN = 'https://portal.azure.com'

/** Hosts que `shell.openExternal` pode abrir. Ver src/main/safe-open.ts. */
export const PORTAL_ALLOWED_HOSTS: readonly string[] = [
  'portal.azure.com',
  'ms.portal.azure.com',
]

export interface PortalLink {
  readonly url: string
  /** true quando caímos na lista de runs em vez do run específico. */
  readonly isFallback: boolean
}

/**
 * Prefixo com o tenant. O portal aceita URLs sem tenant, mas quem tem várias
 * contas cai no diretório errado — então incluímos quando conhecido.
 */
function directoryPrefix(tenantId: string | undefined): string {
  return tenantId ? `#@${tenantId}` : '#'
}

/**
 * Lista de runs de um workflow. Formato estável e documentado.
 * Usado como fallback e como destino para Standard quando o run não resolve.
 */
export function buildRunsListUrl(workflowResourceId: string, tenantId?: string): string {
  return `${PORTAL_ORIGIN}/${directoryPrefix(tenantId)}/resource${workflowResourceId}/runs`
}

/**
 * Consumption: o run é uma sub-resource do próprio workflow, então o resource
 * ID do run é `{workflowId}/runs/{runName}` e a blade responde a ele.
 *
 * VALIDAR: confirmar contra uma URL real copiada do portal.
 */
function buildConsumptionRunUrl(run: WorkflowRun, tenantId?: string): string {
  const runResourceId = `${run.workflowResourceId}/runs/${run.runName}`
  return `${PORTAL_ORIGIN}/${directoryPrefix(tenantId)}/resource${runResourceId}/rundetails`
}

/**
 * Standard: o workflow vive dentro de um App Service, e a blade de run usa
 * um caminho diferente. Este é o formato com menor confiança do arquivo.
 *
 * VALIDAR: confirmar contra uma URL real copiada do portal.
 */
function buildStandardRunUrl(run: WorkflowRun, tenantId?: string): string {
  const runResourceId = `${run.workflowResourceId}/runs/${run.runName}`
  return `${PORTAL_ORIGIN}/${directoryPrefix(tenantId)}/resource${runResourceId}/rundetails`
}

/**
 * Melhor link disponível para um run, com o fallback já embutido.
 *
 * Nunca lança: se algo estiver faltando para montar o link específico,
 * retorna a lista de runs marcada como fallback.
 */
export function buildPortalLink(run: WorkflowRun, tenantId?: string): PortalLink {
  const listUrl = buildRunsListUrl(run.workflowResourceId, tenantId)

  if (!run.runName || !run.workflowResourceId) {
    return { url: listUrl, isFallback: true }
  }

  try {
    const url =
      run.kind === 'consumption'
        ? buildConsumptionRunUrl(run, tenantId)
        : buildStandardRunUrl(run, tenantId)
    return { url, isFallback: false }
  } catch {
    return { url: listUrl, isFallback: true }
  }
}

/** Valida uma URL contra a allowlist antes de entregar ao shell. */
export function isAllowedPortalUrl(candidate: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return PORTAL_ALLOWED_HOSTS.includes(parsed.hostname)
}
