import type { TokenCredential } from '@azure/identity'
import type { Scope, WorkflowRef, WorkflowRun } from '../../shared/types.js'
import type { LogicAppAdapter } from './adapter.js'
import { makeRunId, normalizeStatus } from './adapter.js'
import { extractRunError } from './run-error.js'
import { resourceGroupFromId } from './consumption.js'

/**
 * Logic Apps Standard.
 *
 * ⚠️ Por que este adapter não usa o SDK `@azure/arm-appservice`
 *
 * O SDK expõe `webApps.listWorkflows` e `workflowRuns.list`, e a primeira
 * versão deste arquivo os usava. Contra um tenant real os dois se mostraram
 * inadequados:
 *
 *  1. O histórico de runs de um workflow Standard NÃO existe no plano de
 *     gerenciamento do ARM. Ele fica atrás do proxy `hostruntime`, que
 *     encaminha para o runtime do próprio App Service:
 *
 *       .../sites/{site}/hostruntime/runtime/webhooks/workflow/api/management
 *         /workflows/{workflow}/runs
 *
 *     Chamar `.../sites/{site}/workflows/{wf}/runs` devolve 404 — verificado.
 *
 *  2. Na listagem do ARM, `name` vem prefixado com o site
 *     (`"la-trux/wf-PostPayment"`), enquanto o `id` usa o nome puro
 *     (`.../workflows/wf-PostPayment`). Usar `name` para montar URL quebra.
 *     O runtime, por outro lado, devolve o nome já puro.
 *
 * Por isso falamos HTTP direto com o ARM aqui, usando o token da mesma
 * credencial. É menos elegante que o SDK, mas é a API que de fato existe.
 */

const ARM_ENDPOINT = 'https://management.azure.com'
const ARM_SCOPE = 'https://management.azure.com/.default'
/** Versão usada nas chamadas de runtime; validada contra um tenant real. */
const API_VERSION = '2023-12-01'
/** Teto de runs por workflow em um ciclo — evita puxar histórico inteiro. */
const RUNS_PAGE_SIZE = 30

/** Resposta do runtime ao listar workflows de um site. */
interface RuntimeWorkflow {
  readonly name?: string
  /** 'Stateful' ou 'Stateless' — vai no deep link da WorkflowMenuBlade. */
  readonly kind?: string
}

interface RuntimeRun {
  readonly name?: string
  readonly properties?: {
    readonly status?: string
    readonly startTime?: string
    readonly endTime?: string
    readonly code?: string
    readonly error?: unknown
    readonly correlation?: { readonly clientTrackingId?: string }
  }
}

export class StandardAdapter implements LogicAppAdapter {
  readonly id = 'standard'

  readonly #credential: TokenCredential
  #cachedToken: { value: string; expiresAt: number } | undefined
  /**
   * Região por resource ID de site.
   *
   * O runtime não devolve a região, mas o deep link do portal exige. Quem
   * descobre os sites (discovery.ts) a conhece e a registra aqui.
   */
  readonly #siteLocations = new Map<string, string>()

  constructor(credential: TokenCredential) {
    this.#credential = credential
  }

  /** Informa a região de um site, para os links do portal saírem corretos. */
  rememberSiteLocation(siteResourceId: string, location: string): void {
    this.#siteLocations.set(siteResourceId, location)
  }

  /** Token do ARM, reaproveitado até perto de expirar. */
  async #token(): Promise<string> {
    const cached = this.#cachedToken
    // 60s de folga: um token que expira no meio do voo vira 401 inexplicável.
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value

    const token = await this.#credential.getToken(ARM_SCOPE)
    if (!token) throw new Error('Não foi possível obter token do Azure.')
    this.#cachedToken = { value: token.token, expiresAt: token.expiresOnTimestamp }
    return token.token
  }

  async #get(path: string): Promise<unknown> {
    const response = await fetch(`${ARM_ENDPOINT}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        accept: 'application/json',
      },
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      // Preserva statusCode e o header: é o que classifyError e o backoff
      // do poller usam para distinguir auth, permissão e throttling.
      throw Object.assign(new Error(`ARM ${response.status}: ${body.slice(0, 300)}`), {
        statusCode: response.status,
        response: { headers: response.headers },
      })
    }
    return response.json()
  }

  /** Caminho base do runtime de um site. */
  #runtimeBase(workflow: Pick<WorkflowRef, 'subscriptionId' | 'resourceGroup'> & { site: string }): string {
    return (
      `/subscriptions/${workflow.subscriptionId}` +
      `/resourceGroups/${workflow.resourceGroup}` +
      `/providers/Microsoft.Web/sites/${workflow.site}` +
      `/hostruntime/runtime/webhooks/workflow/api/management`
    )
  }

  /**
   * Workflows dentro dos sites do escopo.
   *
   * A descoberta de sites em si vem do Resource Graph (ver discovery.ts);
   * este método expande um site já conhecido nos workflows que ele hospeda.
   */
  async listWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    const refs: WorkflowRef[] = []

    for (const siteResourceId of scope.workflowResourceIds) {
      const subscriptionId = subscriptionFromId(siteResourceId)
      const resourceGroup = resourceGroupFromId(siteResourceId)
      const site = siteNameFromId(siteResourceId)
      if (!subscriptionId || !resourceGroup || !site) continue
      // A região vem do site (via Resource Graph) — o runtime não a informa,
      // e o deep link do portal precisa dela.
      const location = this.#siteLocations.get(siteResourceId) ?? 'unknown'

      const base = this.#runtimeBase({ subscriptionId, resourceGroup, site })
      const payload = await this.#get(`${base}/workflows?api-version=${API_VERSION}`)

      // O runtime devolve um array cru, não um envelope { value: [...] }.
      const items: RuntimeWorkflow[] = Array.isArray(payload)
        ? (payload as RuntimeWorkflow[])
        : []

      for (const item of items) {
        if (!item.name) continue
        refs.push({
          resourceId: `${siteResourceId}/workflows/${item.name}`,
          name: item.name,
          kind: 'standard',
          subscriptionId,
          resourceGroup,
          location,
          siteName: site,
          ...(item.kind === 'Stateful' || item.kind === 'Stateless'
            ? { statefulness: item.kind }
            : {}),
        })
      }
    }
    return refs
  }

  async listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    if (!workflow.siteName) {
      throw new Error(
        `Workflow Standard "${workflow.name}" sem siteName — não dá para montar a chamada.`,
      )
    }

    const base = this.#runtimeBase({
      subscriptionId: workflow.subscriptionId,
      resourceGroup: workflow.resourceGroup,
      site: workflow.siteName,
    })

    // O runtime aceita $filter por status no servidor — verificado. Pedimos
    // só as falhas: é o que o app mostra, e reduz o payload drasticamente
    // num workflow que roda milhares de vezes por dia.
    const query =
      `api-version=${API_VERSION}` +
      `&$top=${RUNS_PAGE_SIZE}` +
      `&$filter=${encodeURIComponent("status eq 'Failed'")}`

    const payload = await this.#get(`${base}/workflows/${workflow.name}/runs?${query}`)
    const items = readRunList(payload)
    const sinceMs = since.getTime()
    const runs: WorkflowRun[] = []

    for (const item of items) {
      const props = item.properties
      if (!item.name || !props?.startTime) continue

      // O filtro de tempo é aplicado no cliente: o runtime aceita $filter por
      // status, mas combiná-lo com startTime não é confiável entre versões.
      const startedAt = new Date(props.startTime)
      if (Number.isNaN(startedAt.getTime()) || startedAt.getTime() < sinceMs) continue

      const error = extractRunError(props.error, props.code)

      runs.push({
        runName: item.name,
        runId: makeRunId(workflow.resourceId, item.name),
        workflowResourceId: workflow.resourceId,
        workflowName: workflow.name,
        kind: 'standard',
        status: normalizeStatus(props.status),
        startTime: startedAt.toISOString(),
        ...(props.endTime ? { endTime: new Date(props.endTime).toISOString() } : {}),
        ...(error ? { error } : {}),
        ...(props.correlation?.clientTrackingId
          ? { correlationId: props.correlation.clientTrackingId }
          : {}),
      })
    }
    return runs
  }
}

/** Runs vêm em `{ value: [...] }`; toleramos array cru por segurança. */
function readRunList(payload: unknown): RuntimeRun[] {
  if (Array.isArray(payload)) return payload as RuntimeRun[]
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as { value?: unknown }).value
    if (Array.isArray(value)) return value as RuntimeRun[]
  }
  return []
}

export function subscriptionFromId(resourceId: string): string | undefined {
  return /\/subscriptions\/([^/]+)/i.exec(resourceId)?.[1]
}

export function siteNameFromId(resourceId: string): string | undefined {
  return /\/providers\/Microsoft\.Web\/sites\/([^/]+)/i.exec(resourceId)?.[1]
}
