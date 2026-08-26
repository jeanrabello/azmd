import { WebSiteManagementClient } from '@azure/arm-appservice'
import type { TokenCredential } from '@azure/identity'
import type { Scope, WorkflowRef, WorkflowRun } from '../../shared/types.js'
import type { LogicAppAdapter } from './adapter.js'
import { makeRunId, normalizeStatus } from './adapter.js'
import { extractRunError } from './run-error.js'
import { resourceGroupFromId } from './consumption.js'

/**
 * Logic Apps Standard — os workflows vivem dentro de um App Service
 * (`Microsoft.Web/sites` cujo `kind` contém `workflowapp`), por isso todo
 * método aqui depende de `siteName`, diferente do Consumption onde o
 * workflow é o próprio recurso.
 */
export class StandardAdapter implements LogicAppAdapter {
  readonly id = 'standard'

  readonly #credential: TokenCredential
  /** Um client por subscription — o SDK amarra a subscription no construtor. */
  readonly #clients = new Map<string, WebSiteManagementClient>()

  constructor(credential: TokenCredential) {
    this.#credential = credential
  }

  #clientFor(subscriptionId: string): WebSiteManagementClient {
    let client = this.#clients.get(subscriptionId)
    if (!client) {
      client = new WebSiteManagementClient(this.#credential, subscriptionId)
      this.#clients.set(subscriptionId, client)
    }
    return client
  }

  /**
   * Listagem direta por subscription. Assim como no Consumption, a descoberta
   * de verdade usa o Resource Graph (ver discovery.ts); este método existe
   * para escopo já conhecido e para manter o adapter utilizável isoladamente.
   */
  async listWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    const refs: WorkflowRef[] = []

    for (const subscriptionId of scope.subscriptionIds) {
      const client = this.#clientFor(subscriptionId)

      for await (const site of client.webApps.list()) {
        if (!site.id || !site.name) continue
        // Só sites Logic Apps Standard interessam — os demais são Function Apps,
        // Web Apps comuns etc., que compartilham o mesmo endpoint de listagem.
        if (!site.kind?.includes('workflowapp')) continue

        const resourceGroup = resourceGroupFromId(site.id)
        if (!resourceGroup) continue
        if (scope.resourceGroups.length > 0 && !scope.resourceGroups.includes(resourceGroup)) {
          continue
        }

        // Superfície do SDK para listar workflows dentro de um site ainda não
        // verificada contra um tenant real — se o método não existir ou mudar
        // de forma, pulamos o site em vez de quebrar a descoberta inteira.
        try {
          for await (const wf of client.webApps.listWorkflows(resourceGroup, site.name)) {
            if (!wf.id || !wf.name) continue
            refs.push({
              resourceId: `${site.id}/workflows/${wf.name}`,
              name: wf.name,
              kind: 'standard',
              subscriptionId,
              resourceGroup,
              location: site.location,
              siteName: site.name,
            })
          }
        } catch {
          // SDK surface incerta (ver comentário acima) — não derruba a
          // descoberta dos demais sites por causa de um site problemático.
          continue
        }
      }
    }
    return refs
  }

  async listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    if (!workflow.siteName) {
      throw new Error(
        `StandardAdapter.listRuns: workflow '${workflow.name}' requer siteName (é um workflow Standard, hospedado num App Service).`,
      )
    }

    const client = this.#clientFor(workflow.subscriptionId)
    const runs: WorkflowRun[] = []

    // Diferente do Consumption, a API de Standard não garante filtro
    // confiável de startTime no servidor — por isso buscamos tudo e filtramos
    // por `since` do lado do cliente. É a diferença documentada entre os dois
    // adapters (ver LogicAppAdapter.listRuns).
    const iterator = client.workflowRuns.list(
      workflow.resourceGroup,
      workflow.siteName,
      workflow.name,
    )

    for await (const run of iterator) {
      if (!run.name || !run.startTime) continue
      const startTime = new Date(run.startTime)
      if (startTime < since) continue

      const error = extractRunError(run.error, run.code)

      runs.push({
        runName: run.name,
        runId: makeRunId(workflow.resourceId, run.name),
        workflowResourceId: workflow.resourceId,
        workflowName: workflow.name,
        kind: 'standard',
        status: normalizeStatus(run.status),
        startTime: startTime.toISOString(),
        ...(run.endTime ? { endTime: new Date(run.endTime).toISOString() } : {}),
        ...(error
          ? { error }
          : {}),
        ...(run.correlation?.clientTrackingId
          ? { correlationId: run.correlation.clientTrackingId }
          : {}),
      })
    }
    return runs
  }
}

