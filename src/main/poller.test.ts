import { describe, expect, it } from 'vitest'
import { Poller, classifyError, retryAfterFromError } from './poller.js'
import type { LogicAppAdapter } from './azure/adapter.js'
import { EMPTY_SCOPE, type Scope, type WorkflowRef, type WorkflowRun } from '../shared/types.js'

/**
 * Os testes cobrem o que o plano identifica como risco: dedupe, cursor e
 * backoff. São exatamente as partes onde um bug é silencioso — o app parece
 * funcionar e só notifica errado.
 */

const WORKFLOW: WorkflowRef = {
  resourceId: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf',
  name: 'wf',
  kind: 'consumption',
  subscriptionId: 's1',
  resourceGroup: 'rg',
  location: 'brazilsouth',
}

function makeRun(runName: string, startTime: string, status: WorkflowRun['status']): WorkflowRun {
  return {
    runName,
    runId: `${WORKFLOW.resourceId}/runs/${runName}`,
    workflowResourceId: WORKFLOW.resourceId,
    workflowName: WORKFLOW.name,
    kind: 'consumption',
    status,
    startTime,
  }
}

/** Adapter controlável: registra o `since` recebido para verificar o cursor. */
class FakeAdapter implements LogicAppAdapter {
  readonly id = 'consumption'
  runs: WorkflowRun[] = []
  error: unknown
  readonly sinceCalls: Date[] = []
  listRunsCalls = 0

  async listWorkflows(_scope: Scope): Promise<WorkflowRef[]> {
    return [WORKFLOW]
  }

  async listRuns(_workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]> {
    this.listRunsCalls += 1
    this.sinceCalls.push(since)
    if (this.error) throw this.error
    return this.runs
  }
}

describe('Poller — deduplicação', () => {
  it('notifica um run falho apenas uma vez, mesmo aparecendo em vários ciclos', async () => {
    const adapter = new FakeAdapter()
    adapter.runs = [makeRun('r1', '2026-08-26T10:00:00.000Z', 'Failed')]
    const poller = new Poller([adapter], { lookbackHours: 24 })

    const first = await poller.runCycle(EMPTY_SCOPE)
    expect(first.newFailures).toHaveLength(1)

    const second = await poller.runCycle(EMPTY_SCOPE)
    expect(second.newFailures).toHaveLength(0)
    // Continua visível na lista, só não é "novo".
    expect(second.allFailures).toHaveLength(1)
  })

  it('trata Failed, TimedOut e Aborted como falha, e ignora Succeeded', async () => {
    const adapter = new FakeAdapter()
    adapter.runs = [
      makeRun('ok', '2026-08-26T10:00:00.000Z', 'Succeeded'),
      makeRun('failed', '2026-08-26T10:01:00.000Z', 'Failed'),
      makeRun('timeout', '2026-08-26T10:02:00.000Z', 'TimedOut'),
      makeRun('aborted', '2026-08-26T10:03:00.000Z', 'Aborted'),
      makeRun('running', '2026-08-26T10:04:00.000Z', 'Running'),
    ]
    const poller = new Poller([adapter], { lookbackHours: 24 })

    const result = await poller.runCycle(EMPTY_SCOPE)
    expect(result.newFailures.map((r) => r.runName).sort()).toEqual([
      'aborted',
      'failed',
      'timeout',
    ])
  })

  it('primeSeen impede que o histórico do boot vire notificação', async () => {
    const adapter = new FakeAdapter()
    const existing = makeRun('antigo', '2026-08-26T10:00:00.000Z', 'Failed')
    adapter.runs = [existing]
    const poller = new Poller([adapter], { lookbackHours: 24 })

    poller.primeSeen([existing])
    const result = await poller.runCycle(EMPTY_SCOPE)
    expect(result.newFailures).toHaveLength(0)
    expect(result.allFailures).toHaveLength(1)
  })

  it('runs dispensados não voltam para a lista', async () => {
    const adapter = new FakeAdapter()
    const run = makeRun('r1', '2026-08-26T10:00:00.000Z', 'Failed')
    adapter.runs = [run]
    const poller = new Poller([adapter], { lookbackHours: 24 })

    await poller.runCycle(EMPTY_SCOPE)
    poller.dismiss(run.runId)

    const result = await poller.runCycle(EMPTY_SCOPE)
    expect(result.allFailures).toHaveLength(0)
  })
})

describe('Poller — cursor', () => {
  it('avança o cursor para não reler a janela inteira', async () => {
    const adapter = new FakeAdapter()
    adapter.runs = [makeRun('r1', '2026-08-26T10:00:00.000Z', 'Failed')]
    const now = new Date('2026-08-26T12:00:00.000Z')
    const poller = new Poller([adapter], { lookbackHours: 24, now: () => now })

    await poller.runCycle(EMPTY_SCOPE)
    await poller.runCycle(EMPTY_SCOPE)

    const [firstSince, secondSince] = adapter.sinceCalls
    expect(firstSince).toBeDefined()
    expect(secondSince).toBeDefined()
    // Primeiro ciclo olha 24h para trás; o segundo parte do run mais recente.
    expect(firstSince!.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000)
    expect(secondSince!.getTime()).toBeGreaterThan(firstSince!.getTime())
  })

  it('avança o cursor mesmo quando todos os runs tiveram sucesso', async () => {
    const adapter = new FakeAdapter()
    adapter.runs = [makeRun('ok', '2026-08-26T11:00:00.000Z', 'Succeeded')]
    const now = new Date('2026-08-26T12:00:00.000Z')
    const poller = new Poller([adapter], { lookbackHours: 24, now: () => now })

    await poller.runCycle(EMPTY_SCOPE)
    await poller.runCycle(EMPTY_SCOPE)

    const [first, second] = adapter.sinceCalls
    expect(second!.getTime()).toBeGreaterThan(first!.getTime())
  })
})

describe('Poller — backoff', () => {
  it('pula o workflow enquanto o backoff estiver ativo, sem gastar quota', async () => {
    const adapter = new FakeAdapter()
    adapter.error = Object.assign(new Error('boom'), { statusCode: 500 })
    let clock = new Date('2026-08-26T12:00:00.000Z').getTime()
    const poller = new Poller([adapter], {
      lookbackHours: 24,
      now: () => new Date(clock),
    })

    const first = await poller.runCycle(EMPTY_SCOPE)
    expect(first.errors).toHaveLength(1)
    expect(adapter.listRunsCalls).toBe(1)

    // Logo em seguida: ainda em backoff, não deve chamar de novo.
    clock += 1000
    await poller.runCycle(EMPTY_SCOPE)
    expect(adapter.listRunsCalls).toBe(1)

    // Passado o backoff máximo, volta a tentar.
    clock += 16 * 60 * 1000
    await poller.runCycle(EMPTY_SCOPE)
    expect(adapter.listRunsCalls).toBe(2)
  })

  it('respeita Retry-After em vez de adivinhar', () => {
    const error = {
      statusCode: 429,
      response: { headers: { get: (name: string) => (name === 'retry-after' ? '120' : undefined) } },
    }
    expect(retryAfterFromError(error)).toBe(120_000)
  })

  it('um workflow em backoff não impede os demais', async () => {
    const bad = new FakeAdapter()
    bad.error = Object.assign(new Error('boom'), { statusCode: 500 })

    // kind 'standard' é o que roteia para o adapter saudável — o roteamento
    // do poller é por kind, então o fixture precisa refletir isso.
    const other: WorkflowRef = {
      ...WORKFLOW,
      resourceId: '/subscriptions/s1/wf2',
      name: 'wf2',
      kind: 'standard',
      siteName: 'site',
    }
    const good: LogicAppAdapter = {
      id: 'standard',
      listWorkflows: async () => [other],
      // Só responde pelo próprio workflow: é o adapter real que faz isso, e
      // sem essa fidelidade o teste não distingue roteamento de coincidência.
      listRuns: async (workflow) =>
        workflow.resourceId !== other.resourceId
          ? []
          : [
              {
                runName: 'r9',
                runId: `${other.resourceId}/runs/r9`,
                workflowResourceId: other.resourceId,
                workflowName: other.name,
                kind: 'standard',
                status: 'Failed',
                startTime: '2026-08-26T11:00:00.000Z',
              },
            ],
    }

    const poller = new Poller([bad, good], { lookbackHours: 24 })
    const result = await poller.runCycle(EMPTY_SCOPE)

    expect(result.errors).toHaveLength(1)
    expect(result.newFailures).toHaveLength(1)
    expect(result.newFailures[0]?.workflowName).toBe('wf2')
  })
})

describe('classifyError', () => {
  it('401 vira erro de autenticação', () => {
    expect(classifyError({ statusCode: 401, message: 'unauthorized' }).kind).toBe('auth')
  })

  it('403 vira erro de permissão', () => {
    expect(classifyError({ statusCode: 403, message: 'forbidden' }).kind).toBe('permission')
  })

  it('429 vira throttling', () => {
    expect(classifyError({ statusCode: 429, message: 'too many' }).kind).toBe('throttled')
  })

  it('erro de DNS vira erro de rede', () => {
    expect(classifyError({ code: 'ENOTFOUND', message: 'getaddrinfo' }).kind).toBe('network')
  })

  it('ausência de credencial do CLI vira erro de auth acionável', () => {
    const error = classifyError(new Error('AzureCliCredential: please run az login'))
    expect(error.kind).toBe('auth')
    expect(error.message).toContain('az login')
  })
})
