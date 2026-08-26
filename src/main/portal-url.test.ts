import { describe, expect, it } from 'vitest'
import { buildPortalLink, buildRunsListUrl, isAllowedPortalUrl } from './portal-url.js'
import type { WorkflowRun } from '../shared/types.js'

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

describe('buildPortalLink', () => {
  it('inclui o tenant quando conhecido, para não cair no diretório errado', () => {
    const link = buildPortalLink(CONSUMPTION_RUN, 'tenant-123')
    expect(link.url).toContain('#@tenant-123/resource')
    expect(link.isFallback).toBe(false)
  })

  it('funciona sem tenant', () => {
    const link = buildPortalLink(CONSUMPTION_RUN)
    expect(link.url.startsWith('https://portal.azure.com/#/resource')).toBe(true)
  })

  it('cai no fallback da lista quando falta o nome do run', () => {
    const link = buildPortalLink({ ...CONSUMPTION_RUN, runName: '' })
    expect(link.isFallback).toBe(true)
    expect(link.url.endsWith('/runs')).toBe(true)
  })

  it('gera sempre uma URL permitida pela allowlist', () => {
    for (const kind of ['consumption', 'standard'] as const) {
      const link = buildPortalLink({ ...CONSUMPTION_RUN, kind }, 'tenant-123')
      expect(isAllowedPortalUrl(link.url)).toBe(true)
    }
  })

  // Verificado contra um tenant real: no Standard o run não existe como
  // recurso no ARM (404), só atrás do runtime do App Service. Então apontamos
  // para a lista de runs e avisamos a UI, em vez de arriscar um link quebrado.
  it('Standard aponta para a lista de runs e se declara fallback', () => {
    const link = buildPortalLink({ ...CONSUMPTION_RUN, kind: 'standard' }, 'tenant-123')
    expect(link.isFallback).toBe(true)
    expect(link.url.endsWith('/runs')).toBe(true)
    expect(link.url).not.toContain('/rundetails')
  })
})

describe('buildRunsListUrl', () => {
  it('usa o formato estável documentado', () => {
    const url = buildRunsListUrl(CONSUMPTION_RUN.workflowResourceId, 'tenant-123')
    expect(url).toBe(
      `https://portal.azure.com/#@tenant-123/resource${CONSUMPTION_RUN.workflowResourceId}/runs`,
    )
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

  it('rejeita esquemas não-https, incluindo javascript e file', () => {
    expect(isAllowedPortalUrl('http://portal.azure.com/x')).toBe(false)
    expect(isAllowedPortalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedPortalUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejeita entrada que não é URL', () => {
    expect(isAllowedPortalUrl('não é uma url')).toBe(false)
    expect(isAllowedPortalUrl('')).toBe(false)
  })
})
