import { describe, expect, it } from 'vitest'
import {
  buildConsumptionRunsListUrl,
  buildPortalLink,
  buildRunsListUrl,
  buildStandardRunHistoryUrl,
  isAllowedPortalUrl,
} from './portal-url.js'
import { regionDisplayName } from './azure/regions.js'
import type { WorkflowLinkContext, WorkflowRun } from '../shared/types.js'

const CONSUMPTION_RUN: WorkflowRun = {
  runName: '08585123456789',
  runId: '/subscriptions/s1/.../runs/08585123456789',
  workflowResourceId:
    '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf',
  workflowName: 'wf',
  kind: 'consumption',
  status: 'Failed',
  startTime: '2026-08-26T10:00:00.000Z',
}

const CONSUMPTION_CTX: WorkflowLinkContext = {
  resourceId: CONSUMPTION_RUN.workflowResourceId,
  kind: 'consumption',
  location: 'brazilsouth',
}

/**
 * URL real copiada do portal, para o workflow Standard wf-composeEmails.
 * É a referência: o builder tem que reproduzi-la caractere a caractere.
 */
const REAL_STANDARD_URL =
  'https://portal.azure.com/#view/Microsoft_Azure_EMA/WorkflowMenuBlade/~/runHistory' +
  '/resourceId/%2Fsubscriptions%2Fdd4b9b4c-6ab5-4fa2-bcbd-59c08df49850' +
  '%2FresourceGroups%2Frg-LRSDataLink-shared%2Fproviders%2FMicrosoft.Web' +
  '%2Fsites%2Fla-LRSWebsite%2Fworkflows%2Fwf-composeEmails' +
  '/location/Central%20US/isReadOnly~/false/kind/Stateful' +
  '/defaultBlade/designer/isCodeful~/false'

const STANDARD_CTX: WorkflowLinkContext = {
  resourceId:
    '/subscriptions/dd4b9b4c-6ab5-4fa2-bcbd-59c08df49850/resourceGroups/rg-LRSDataLink-shared' +
    '/providers/Microsoft.Web/sites/la-LRSWebsite/workflows/wf-composeEmails',
  kind: 'standard',
  location: 'centralus',
  statefulness: 'Stateful',
}

describe('histórico de runs — Standard', () => {
  it('reproduz exatamente a URL copiada do portal', () => {
    expect(buildStandardRunHistoryUrl(STANDARD_CTX)).toBe(REAL_STANDARD_URL)
  })

  it('encoda o resourceId como um único segmento', () => {
    const url = buildStandardRunHistoryUrl(STANDARD_CTX)
    // As barras do resource ID viram %2F; se vazarem cruas, o portal
    // interpreta como rota e a blade não abre.
    expect(url).toContain('%2Fsubscriptions%2F')
    expect(url).not.toContain('/resourceId//subscriptions/')
  })

  it('usa o nome de exibição da região, não o slug', () => {
    expect(buildStandardRunHistoryUrl(STANDARD_CTX)).toContain('/location/Central%20US')
    expect(buildStandardRunHistoryUrl(STANDARD_CTX)).not.toContain('/location/centralus')
  })

  it('respeita Stateless quando é o caso', () => {
    const url = buildStandardRunHistoryUrl({ ...STANDARD_CTX, statefulness: 'Stateless' })
    expect(url).toContain('/kind/Stateless')
  })

  it('assume Stateful quando a statefulness é desconhecida', () => {
    const { statefulness: _omit, ...withoutKind } = STANDARD_CTX
    expect(buildStandardRunHistoryUrl(withoutKind)).toContain('/kind/Stateful')
  })

  it('região desconhecida não quebra a URL', () => {
    const url = buildStandardRunHistoryUrl({ ...STANDARD_CTX, location: 'marte-central' })
    expect(url).toContain('/location/marte-central')
    expect(isAllowedPortalUrl(url)).toBe(true)
  })
})

describe('regionDisplayName', () => {
  it('traduz os slugs conhecidos', () => {
    expect(regionDisplayName('centralus')).toBe('Central US')
    expect(regionDisplayName('brazilsouth')).toBe('Brazil South')
    expect(regionDisplayName('japaneast')).toBe('Japan East')
  })

  it('é indiferente a maiúsculas', () => {
    expect(regionDisplayName('CentralUS')).toBe('Central US')
  })

  it('devolve o slug quando a região é nova/desconhecida', () => {
    expect(regionDisplayName('regiao-que-nao-existe')).toBe('regiao-que-nao-existe')
  })
})

describe('histórico de runs — Consumption', () => {
  it('usa a blade genérica de recurso', () => {
    const url = buildConsumptionRunsListUrl(CONSUMPTION_RUN.workflowResourceId, 'tenant-123')
    expect(url).toBe(
      `https://portal.azure.com/#@tenant-123/resource${CONSUMPTION_RUN.workflowResourceId}/runs`,
    )
  })

  it('buildRunsListUrl escolhe o formato pelo kind', () => {
    expect(buildRunsListUrl(STANDARD_CTX)).toContain('WorkflowMenuBlade')
    expect(buildRunsListUrl(CONSUMPTION_CTX, 't')).toContain('/resource/subscriptions/')
  })
})

describe('buildPortalLink', () => {
  it('Consumption aponta para o run específico', () => {
    const link = buildPortalLink(CONSUMPTION_RUN, CONSUMPTION_CTX, 'tenant-123')
    expect(link.isFallback).toBe(false)
    expect(link.url).toContain('/rundetails')
  })

  it('Standard aponta para o histórico e se declara fallback', () => {
    const run: WorkflowRun = { ...CONSUMPTION_RUN, kind: 'standard' }
    const link = buildPortalLink(run, STANDARD_CTX, 'tenant-123')
    expect(link.isFallback).toBe(true)
    expect(link.url).toContain('WorkflowMenuBlade')
  })

  it('cai no histórico quando falta o nome do run', () => {
    const link = buildPortalLink({ ...CONSUMPTION_RUN, runName: '' }, CONSUMPTION_CTX)
    expect(link.isFallback).toBe(true)
  })

  it('gera sempre uma URL permitida pela allowlist', () => {
    for (const [run, ctx] of [
      [CONSUMPTION_RUN, CONSUMPTION_CTX],
      [{ ...CONSUMPTION_RUN, kind: 'standard' as const }, STANDARD_CTX],
    ] as const) {
      expect(isAllowedPortalUrl(buildPortalLink(run, ctx, 't').url)).toBe(true)
    }
  })
})

describe('isAllowedPortalUrl', () => {
  it('aceita os hosts do portal', () => {
    expect(isAllowedPortalUrl('https://portal.azure.com/#/resource/x/runs')).toBe(true)
    expect(isAllowedPortalUrl('https://ms.portal.azure.com/#/resource/x/runs')).toBe(true)
  })

  it('rejeita host de terceiro, inclusive com o portal como prefixo enganoso', () => {
    expect(isAllowedPortalUrl('https://portal.azure.com.evil.test/x')).toBe(false)
    expect(isAllowedPortalUrl('https://evil.test/#@t/resource/x/runs')).toBe(false)
  })

  it('rejeita esquemas não-https', () => {
    expect(isAllowedPortalUrl('http://portal.azure.com/x')).toBe(false)
    expect(isAllowedPortalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedPortalUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejeita entrada que não é URL', () => {
    expect(isAllowedPortalUrl('não é uma url')).toBe(false)
    expect(isAllowedPortalUrl('')).toBe(false)
  })
})
