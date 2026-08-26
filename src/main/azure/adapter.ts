import type { Scope, WorkflowRef, WorkflowRun, RunStatus } from '../../shared/types.js'

/**
 * Interface única sobre as fontes de dados.
 *
 * Existem três implementações: `ConsumptionAdapter` (@azure/arm-logic),
 * `StandardAdapter` (@azure/arm-appservice) e `DemoAdapter` (mocks). O poller
 * fala apenas com esta interface, então trocar o modo do app não toca em
 * nenhuma linha da lógica de polling, dedupe ou notificação.
 */
export interface LogicAppAdapter {
  /** Identificador legível, usado em logs e mensagens de erro. */
  readonly id: string

  /** Inventário de workflows visíveis dentro do escopo. */
  listWorkflows(scope: Scope): Promise<WorkflowRef[]>

  /**
   * Runs do workflow iniciados em `since` ou depois.
   *
   * Implementações devem filtrar por tempo do lado do servidor quando a API
   * permitir, e do lado do cliente quando não permitir (caso do Standard).
   * O contrato para o chamador é o mesmo nos dois casos.
   */
  listRuns(workflow: WorkflowRef, since: Date): Promise<WorkflowRun[]>
}

/** Normaliza o status vindo do Azure, que é uma string livre no SDK. */
export function normalizeStatus(raw: string | undefined): RunStatus {
  switch (raw) {
    case 'Succeeded':
    case 'Failed':
    case 'Cancelled':
    case 'Running':
    case 'Waiting':
    case 'Suspended':
    case 'TimedOut':
    case 'Skipped':
    case 'Aborted':
      return raw
    default:
      return 'Unknown'
  }
}

/** Monta a chave global de um run. Deve ser a única forma de construir runId. */
export function makeRunId(workflowResourceId: string, runName: string): string {
  return `${workflowResourceId}/runs/${runName}`
}
