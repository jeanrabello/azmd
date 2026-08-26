import { LogicManagementClient } from '@azure/arm-logic'
import type { TokenCredential } from '@azure/identity'
import type { Scope, WorkflowRef, WorkflowRun } from '../../shared/types.js'
import type { LogicAppAdapter } from './adapter.js'
import { makeRunId, normalizeStatus } from './adapter.js'
import { extractRunError } from './run-error.js'

/**
 * Logic Apps Consumption — recursos `Microsoft.Logic/workflows`.
 *
 * Esta API suporta `$filter` no servidor, então dá para pedir só o que
 * interessa (falhas depois do cursor) e economizar quota.
 */
export class ConsumptionAdapter implements LogicAppAdapter {
  readonly id = 'consumption'

  readonly #credential: TokenCredential
  /** Um client por subscription — o SDK amarra a subscription no construtor. */
  readonly #clients = new Map<string, LogicManagementClient>()

  constructor(credential: TokenCredential) {
    this.#credential = credential
  }

  #clientFor(subscriptionId: string): LogicManagementClient {
    let client = this.#clients.get(subscriptionId)
    if (!client) {
      client = new LogicManagementClient(this.#credential, subscriptionId)
      this.#clients.set(subscriptionId, client)
    }
    return client
  }

  /**
   * Listagem direta por subscription. Na prática a descoberta usa o Resource
   * Graph (ver discovery.ts); este método existe para o caso de escopo já
   * conhecido e para manter o adapter utilizável isoladamente.
   */
  async listWorkflows(scope: Scope): Promise<WorkflowRef[]> {
    const refs: WorkflowRef[] = []

    for (const subscriptionId of scope.subscriptionIds) {
      const client = this.#clientFor(subscriptionId)
      for await (const wf of client.workflows.listBySubscription()) {
        if (!wf.id || !wf.name) continue
        const resourceGroup = resourceGroupFromId(wf.id)
        if (!resourceGroup) continue
        if (scope.resourceGroups.length > 0 && !scope.resourceGroups.includes(resourceGroup)) {
          continue
        }
        refs.push({
          resourceId: wf.id,
          name: wf.name,
          kind: 'consumption',
          subscriptionId,
          resourceGroup,
          location: wf.location ?? 'unknown',
        })
      }
    }
    return refs
  }

  async listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    const client = this.#clientFor(workflow.subscriptionId)
    const runs: WorkflowRun[] = []

    // O ARM aceita filtro por startTime no servidor. Não filtramos por status
    // aqui: o poller decide o que é falha, e ver os sucessos permite avançar
    // o cursor mesmo quando nada falhou.
    const filter = `startTime ge ${since.toISOString()}`

    const iterator = client.workflowRuns.list(workflow.resourceGroup, workflow.name, {
      filter,
    })

    for await (const run of iterator) {
      if (!run.name || !run.startTime) continue
      runs.push({
        runName: run.name,
        runId: makeRunId(workflow.resourceId, run.name),
        workflowResourceId: workflow.resourceId,
        workflowName: workflow.name,
        kind: 'consumption',
        status: normalizeStatus(run.status),
        startTime: new Date(run.startTime).toISOString(),
        ...(run.endTime ? { endTime: new Date(run.endTime).toISOString() } : {}),
        ...(() => {
          const error = extractRunError(run.error, run.code)
          return error ? { error } : {}
        })(),
        ...(run.correlation?.clientTrackingId
          ? { correlationId: run.correlation.clientTrackingId }
          : {}),
      })
    }
    return runs
  }
}

/** Extrai o resource group de um ARM resource ID. */
export function resourceGroupFromId(resourceId: string): string | undefined {
  const match = /\/resourceGroups\/([^/]+)/i.exec(resourceId)
  return match?.[1]
}
