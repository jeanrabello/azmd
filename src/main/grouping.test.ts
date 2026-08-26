import { describe, expect, it } from 'vitest'
import { buildHierarchy, groupFor, isWorkflowWatched, siteResourceIdFromWorkflow } from './grouping.js'
import { EMPTY_WATCH_SELECTION, type WorkflowRef, type WorkflowRun } from '../shared/types.js'

const SUB = '11111111-1111-1111-1111-111111111111'

function consumption(rg: string, name: string): WorkflowRef {
  return {
    resourceId: `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Logic/workflows/${name}`,
    name,
    kind: 'consumption',
    subscriptionId: SUB,
    resourceGroup: rg,
    location: 'brazilsouth',
  }
}

function standard(rg: string, site: string, name: string): WorkflowRef {
  return {
    resourceId: `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${site}/workflows/${name}`,
    name,
    kind: 'standard',
    subscriptionId: SUB,
    resourceGroup: rg,
    location: 'brazilsouth',
    siteName: site,
  }
}

function failure(workflow: WorkflowRef, startTime: string): WorkflowRun {
  return {
    runName: `run-${startTime}`,
    runId: `${workflow.resourceId}/runs/run-${startTime}`,
    workflowResourceId: workflow.resourceId,
    workflowName: workflow.name,
    kind: workflow.kind,
    status: 'Failed',
    startTime,
  }
}

const portalUrlFor = (w: WorkflowRef): string => `https://portal.azure.com/#/resource${w.resourceId}/runs`

describe('agrupamento', () => {
  it('agrupa Standard pelo App Service que hospeda os workflows', () => {
    const a = groupFor(standard('rg-plat', 'la-prd', 'wf-a'))
    const b = groupFor(standard('rg-plat', 'la-prd', 'wf-b'))
    expect(a.id).toBe(b.id)
    expect(a.name).toBe('la-prd')
  })

  it('separa App Services diferentes no mesmo resource group', () => {
    const a = groupFor(standard('rg-plat', 'la-prd', 'wf'))
    const b = groupFor(standard('rg-plat', 'la-dev', 'wf'))
    expect(a.id).not.toBe(b.id)
  })

  it('agrupa Consumption por resource group', () => {
    const a = groupFor(consumption('rg-fin', 'wf-a'))
    const b = groupFor(consumption('rg-fin', 'wf-b'))
    expect(a.id).toBe(b.id)
    expect(a.name).toBe('rg-fin')
  })

  it('nunca colide um site com um resource group de mesmo nome', () => {
    const site = groupFor(standard('x', 'x', 'wf'))
    const rg = groupFor(consumption('x', 'wf'))
    expect(site.id).not.toBe(rg.id)
  })

  it('extrai o resource ID do site a partir do workflow', () => {
    const id = siteResourceIdFromWorkflow(standard('rg', 'meu-site', 'wf').resourceId)
    expect(id?.endsWith('/Microsoft.Web/sites/meu-site')).toBe(true)
  })
})

describe('saúde e contadores', () => {
  const wfA = standard('rg-plat', 'la-prd', 'notifica')
  const wfB = standard('rg-plat', 'la-prd', 'exporta')
  const wfC = consumption('rg-fin', 'concilia')

  it('marca como failing o grupo que tem workflow falhando', () => {
    const { logicApps } = buildHierarchy({
      workflows: [wfA, wfB, wfC],
      failedRuns: [failure(wfA, '2026-08-26T10:00:00.000Z')],
      watch: EMPTY_WATCH_SELECTION,
      portalUrlFor,
    })
    const plat = logicApps.find((g) => g.group.name === 'la-prd')
    expect(plat?.health).toBe('failing')
    expect(plat?.failingWorkflowCount).toBe(1)
    expect(plat?.totalWorkflowCount).toBe(2)

    expect(logicApps.find((g) => g.group.name === 'rg-fin')?.health).toBe('healthy')
  })

  it('ordena falhando primeiro, ignorado por último', () => {
    const { logicApps } = buildHierarchy({
      workflows: [wfA, wfC],
      failedRuns: [failure(wfC, '2026-08-26T10:00:00.000Z')],
      watch: { ignoredLogicAppIds: [groupFor(wfA).id], ignoredWorkflowResourceIds: [] },
      portalUrlFor,
    })
    expect(logicApps.map((g) => g.health)).toEqual(['failing', 'unwatched'])
  })

  it('workflow ignorado não deixa o grupo vermelho', () => {
    const { logicApps } = buildHierarchy({
      workflows: [wfA, wfB],
      failedRuns: [failure(wfA, '2026-08-26T10:00:00.000Z')],
      watch: { ignoredLogicAppIds: [], ignoredWorkflowResourceIds: [wfA.resourceId] },
      portalUrlFor,
    })
    expect(logicApps[0]?.health).toBe('healthy')
    expect(logicApps[0]?.failedRunCount).toBe(0)
  })

  it('ignorar o grupo ignora os workflows dentro dele', () => {
    const watch = { ignoredLogicAppIds: [groupFor(wfA).id], ignoredWorkflowResourceIds: [] }
    expect(isWorkflowWatched(wfA, watch)).toBe(false)
    expect(isWorkflowWatched(wfB, watch)).toBe(false)
    expect(isWorkflowWatched(wfC, watch)).toBe(true)
  })

  it('grupo ignorado continua na lista, para poder ser reativado', () => {
    const { logicApps } = buildHierarchy({
      workflows: [wfA],
      failedRuns: [],
      watch: { ignoredLogicAppIds: [groupFor(wfA).id], ignoredWorkflowResourceIds: [] },
      portalUrlFor,
    })
    expect(logicApps).toHaveLength(1)
    expect(logicApps[0]?.watched).toBe(false)
  })

  it('reporta a falha mais recente do grupo', () => {
    const { logicApps } = buildHierarchy({
      workflows: [wfA, wfB],
      failedRuns: [
        failure(wfA, '2026-08-26T08:00:00.000Z'),
        failure(wfB, '2026-08-26T12:00:00.000Z'),
      ],
      watch: EMPTY_WATCH_SELECTION,
      portalUrlFor,
    })
    expect(logicApps[0]?.lastFailureAt).toBe('2026-08-26T12:00:00.000Z')
    expect(logicApps[0]?.failedRunCount).toBe(2)
  })
})
