import type { WorkflowLinkContext, WorkflowRun } from '../shared/types.js'
import { regionDisplayName } from './azure/regions.js'

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
 * Histórico de runs de um workflow Standard.
 *
 * Formato confirmado a partir de uma URL real copiada do portal — é a
 * WorkflowMenuBlade da extensão EMA, e NÃO o `#@tenant/resource{id}/runs`
 * que usávamos antes (esse não abre o histórico de um workflow Standard).
 *
 * Estrutura:
 *   #view/Microsoft_Azure_EMA/WorkflowMenuBlade/~/runHistory
 *     /resourceId/{resourceId totalmente URL-encoded}
 *     /location/{nome de exibição, ex.: "Central US"}
 *     /isReadOnly~/false /kind/{Stateful|Stateless}
 *     /defaultBlade/designer /isCodeful~/false
 *
 * O resourceId vai encodado como UM segmento (as barras viram %2F), por isso
 * `encodeURIComponent` e não template string crua.
 */
export function buildStandardRunHistoryUrl(workflow: WorkflowLinkContext): string {
  const resourceId = encodeURIComponent(workflow.resourceId)
  const location = encodeURIComponent(regionDisplayName(workflow.location))
  const kind = workflow.statefulness ?? 'Stateful'

  return (
    `${PORTAL_ORIGIN}/#view/Microsoft_Azure_EMA/WorkflowMenuBlade/~/runHistory` +
    `/resourceId/${resourceId}` +
    `/location/${location}` +
    `/isReadOnly~/false` +
    `/kind/${kind}` +
    `/defaultBlade/designer` +
    `/isCodeful~/false`
  )
}

/**
 * Lista de runs de um workflow Consumption.
 *
 * Aqui o workflow é um recurso de primeira classe, então a blade genérica de
 * recurso funciona. Formato estável.
 */
export function buildConsumptionRunsListUrl(
  workflowResourceId: string,
  tenantId?: string,
): string {
  return `${PORTAL_ORIGIN}/${directoryPrefix(tenantId)}/resource${workflowResourceId}/runs`
}

/**
 * Histórico de runs, escolhendo o formato conforme o sabor do Logic App.
 *
 * Os dois são caminhos completamente diferentes no portal — não é detalhe de
 * template, é outra extensão.
 */
export function buildRunsListUrl(
  workflow: WorkflowLinkContext,
  tenantId?: string,
): string {
  return workflow.kind === 'standard'
    ? buildStandardRunHistoryUrl(workflow)
    : buildConsumptionRunsListUrl(workflow.resourceId, tenantId)
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
 * Melhor link disponível para um run.
 *
 * Consumption tem blade por run (`/rundetails`), então o link é exato.
 * Standard não: o run não existe como recurso no ARM (404 verificado), e o
 * portal abre o histórico do workflow — o run procurado fica no topo da
 * lista. Por isso Standard sempre volta marcado como fallback, e a UI avisa.
 *
 * Nunca lança: sem dados para montar o link específico, cai no histórico.
 */
export function buildPortalLink(
  run: WorkflowRun,
  workflow: WorkflowLinkContext,
  tenantId?: string,
): PortalLink {
  const historyUrl = buildRunsListUrl(workflow, tenantId)

  if (!run.runName || !run.workflowResourceId) {
    return { url: historyUrl, isFallback: true }
  }

  try {
    if (run.kind === 'standard') return { url: historyUrl, isFallback: true }
    return { url: buildConsumptionRunUrl(run, tenantId), isFallback: false }
  } catch {
    return { url: historyUrl, isFallback: true }
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
