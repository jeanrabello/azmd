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
 * Blade de um recurso qualquer no portal.
 *
 * Usada para abrir o App Service (Standard) ou o resource group
 * (Consumption) a partir da listagem de Logic Apps. Formato estável.
 */
export function buildResourceUrl(resourceId: string, tenantId?: string): string {
  return `${PORTAL_ORIGIN}/${directoryPrefix(tenantId)}/resource${resourceId}`
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
 * Standard: propositalmente cai na LISTA de runs do workflow, não no run.
 *
 * Verificado contra um tenant real: o recurso do workflow existe no ARM
 * (`Microsoft.Web/sites/workflows`), mas o run como sub-resource devolve 404
 * — no Standard o histórico só existe atrás do runtime do App Service, não
 * no plano de gerenciamento (ver azure/standard.ts).
 *
 * Como não dá para confirmar um deep link de run que o ARM não reconhece,
 * mandar para a lista de runs é a escolha honesta: sempre funciona, e o run
 * procurado está no topo. Um link inventado que abre 404 seria pior que um
 * clique a mais.
 *
 * Se algum dia o formato da blade for confirmado no portal, é só trocar aqui
 * e devolver `isFallback: false`.
 */
function buildStandardRunUrl(run: WorkflowRun, tenantId?: string): string {
  return buildRunsListUrl(run.workflowResourceId, tenantId)
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
    if (run.kind === 'standard') {
      // Marcado como fallback de propósito: a UI mostra o aviso de que o
      // link abre a lista, e o usuário não é pego de surpresa.
      return { url: buildStandardRunUrl(run, tenantId), isFallback: true }
    }
    return { url: buildConsumptionRunUrl(run, tenantId), isFallback: false }
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
