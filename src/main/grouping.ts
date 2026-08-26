import {
  makeLogicAppId,
  type HealthStatus,
  type LogicAppGroup,
  type LogicAppSummary,
  type WatchSelection,
  type WorkflowRef,
  type WorkflowRun,
  type WorkflowSummary,
} from '../shared/types.js'

/**
 * Agrupa workflows em Logic Apps e calcula a saúde de cada nível.
 *
 * Fica separado do controller porque é lógica pura — entra inventário e runs,
 * sai a árvore que a UI desenha. Sem Electron, sem rede, testável direto.
 */

/** Extrai o resource ID do site a partir do resource ID de um workflow Standard. */
export function siteResourceIdFromWorkflow(workflowResourceId: string): string | undefined {
  // .../Microsoft.Web/sites/{site}/workflows/{workflow}
  const match = /^(.*\/providers\/Microsoft\.Web\/sites\/[^/]+)\/workflows\//i.exec(
    workflowResourceId,
  )
  return match?.[1]
}

/** Deriva o grupo ao qual um workflow pertence. */
export function groupFor(workflow: WorkflowRef): LogicAppGroup {
  if (workflow.kind === 'standard') {
    const siteResourceId = siteResourceIdFromWorkflow(workflow.resourceId)
    const name = workflow.siteName ?? 'Logic App'
    return {
      id: makeLogicAppId({
        kind: 'standard',
        subscriptionId: workflow.subscriptionId,
        resourceGroup: workflow.resourceGroup,
        ...(siteResourceId ? { siteResourceId } : {}),
      }),
      name,
      kind: 'standard',
      subscriptionId: workflow.subscriptionId,
      resourceGroup: workflow.resourceGroup,
      ...(workflow.siteName ? { siteName: workflow.siteName } : {}),
      ...(siteResourceId ? { siteResourceId } : {}),
    }
  }

  // Consumption não tem recurso pai; o resource group é o agrupamento que faz
  // sentido — é como o portal organiza e como ambientes costumam ser separados.
  return {
    id: makeLogicAppId({
      kind: 'consumption',
      subscriptionId: workflow.subscriptionId,
      resourceGroup: workflow.resourceGroup,
    }),
    name: workflow.resourceGroup,
    kind: 'consumption',
    subscriptionId: workflow.subscriptionId,
    resourceGroup: workflow.resourceGroup,
  }
}

export function isLogicAppWatched(logicAppId: string, watch: WatchSelection): boolean {
  return !watch.ignoredLogicAppIds.includes(logicAppId)
}

/** Um workflow é observado se ele e o grupo dele estão observados. */
export function isWorkflowWatched(
  workflow: WorkflowRef,
  watch: WatchSelection,
  logicAppId = groupFor(workflow).id,
): boolean {
  if (!isLogicAppWatched(logicAppId, watch)) return false
  return !watch.ignoredWorkflowResourceIds.includes(workflow.resourceId)
}

export interface BuildHierarchyInput {
  readonly workflows: readonly WorkflowRef[]
  /** Runs falhos visíveis, usados para calcular saúde e contadores. */
  readonly failedRuns: readonly WorkflowRun[]
  readonly watch: WatchSelection
  /** Monta o link do portal para a lista de runs de um workflow. */
  readonly portalUrlFor: (workflow: WorkflowRef) => string
}

export interface Hierarchy {
  readonly logicApps: LogicAppSummary[]
  readonly workflows: WorkflowSummary[]
}

/**
 * Monta a árvore Logic App -> workflow com contadores e saúde.
 *
 * Um grupo ignorado continua aparecendo, marcado como 'unwatched' — sumir da
 * lista deixaria o usuário sem caminho de volta para reativá-lo.
 */
export function buildHierarchy(input: BuildHierarchyInput): Hierarchy {
  const { workflows, failedRuns, watch, portalUrlFor } = input

  const failuresByWorkflow = new Map<string, WorkflowRun[]>()
  for (const run of failedRuns) {
    const list = failuresByWorkflow.get(run.workflowResourceId) ?? []
    list.push(run)
    failuresByWorkflow.set(run.workflowResourceId, list)
  }

  const groups = new Map<string, LogicAppGroup>()
  const workflowSummaries: WorkflowSummary[] = []

  for (const workflow of workflows) {
    const group = groupFor(workflow)
    groups.set(group.id, group)

    const failures = failuresByWorkflow.get(workflow.resourceId) ?? []
    const watched = isWorkflowWatched(workflow, watch, group.id)
    const lastFailureAt = latestStart(failures)

    workflowSummaries.push({
      resourceId: workflow.resourceId,
      name: workflow.name,
      kind: workflow.kind,
      logicAppId: group.id,
      health: healthOf(watched, failures.length),
      failedRunCount: failures.length,
      ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      watched,
      portalUrl: portalUrlFor(workflow),
    })
  }

  const logicApps: LogicAppSummary[] = [...groups.values()].map((group) => {
    const children = workflowSummaries.filter((w) => w.logicAppId === group.id)
    const watched = isLogicAppWatched(group.id, watch)
    // Só contamos falhas de workflows observados: um workflow silenciado não
    // deve manter o grupo inteiro marcado como vermelho.
    const watchedChildren = children.filter((w) => w.watched)
    const failedRunCount = watchedChildren.reduce((sum, w) => sum + w.failedRunCount, 0)
    const failingWorkflowCount = watchedChildren.filter((w) => w.failedRunCount > 0).length
    const lastFailureAt = watchedChildren
      .map((w) => w.lastFailureAt)
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1)

    return {
      group,
      health: healthOf(watched, failedRunCount),
      failingWorkflowCount,
      totalWorkflowCount: children.length,
      failedRunCount,
      ...(lastFailureAt ? { lastFailureAt } : {}),
      watched,
    }
  })

  // Falhando primeiro, depois saudáveis, ignorados por último; alfabético
  // dentro de cada faixa. Quem tem problema precisa estar no topo.
  logicApps.sort((a, b) => healthRank(a) - healthRank(b) || a.group.name.localeCompare(b.group.name))
  workflowSummaries.sort(
    (a, b) => healthRank(a) - healthRank(b) || a.name.localeCompare(b.name),
  )

  return { logicApps, workflows: workflowSummaries }
}

function healthOf(watched: boolean, failureCount: number): HealthStatus {
  if (!watched) return 'unwatched'
  return failureCount > 0 ? 'failing' : 'healthy'
}

function healthRank(item: { readonly health: HealthStatus }): number {
  switch (item.health) {
    case 'failing':
      return 0
    case 'healthy':
      return 1
    case 'unwatched':
      return 2
  }
}

function latestStart(runs: readonly WorkflowRun[]): string | undefined {
  return runs.map((r) => r.startTime).sort().at(-1)
}
