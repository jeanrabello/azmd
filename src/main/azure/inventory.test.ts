import { describe, expect, it } from 'vitest'
import { ConsumptionAdapter } from './consumption.js'
import { StandardAdapter } from './standard.js'
import { EMPTY_SCOPE } from '../../shared/types.js'
import type { TokenCredential } from '@azure/identity'

/**
 * Regressão de um bug real encontrado rodando o app.
 *
 * Os adapters listam workflows iterando `scope.subscriptionIds`. Com o escopo
 * padrão (vazio = "tudo"), o laço não executa e eles retornam lista vazia SEM
 * contatar o Azure. O sintoma era pior que uma falha: o app mostrava
 * "conectado, 0 workflows" mesmo sem credencial nenhuma.
 *
 * A correção foi passar a descobrir o inventário pelo Resource Graph
 * (ver discovered.ts). Estes testes fixam o comportamento que motivou aquilo,
 * para que ninguém volte a ligar os adapters crus direto no poller.
 */

// Nunca é usada: com escopo vazio nenhuma chamada de rede deve acontecer.
const credential: TokenCredential = {
  getToken: async () => {
    throw new Error('não deveria pedir token com escopo vazio')
  },
}

describe('adapters crus com escopo vazio', () => {
  it('ConsumptionAdapter devolve vazio sem chamar o Azure', async () => {
    const adapter = new ConsumptionAdapter(credential)
    await expect(adapter.listWorkflows(EMPTY_SCOPE)).resolves.toEqual([])
  })

  it('StandardAdapter devolve vazio sem chamar o Azure', async () => {
    const adapter = new StandardAdapter(credential)
    await expect(adapter.listWorkflows(EMPTY_SCOPE)).resolves.toEqual([])
  })

  it('StandardAdapter recusa listar runs sem siteName, em vez de falhar torto', async () => {
    const adapter = new StandardAdapter(credential)
    await expect(
      adapter.listRuns(
        {
          resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/x/workflows/w',
          name: 'w',
          kind: 'standard',
          subscriptionId: 's',
          resourceGroup: 'rg',
          location: 'brazilsouth',
        },
        new Date(),
      ),
    ).rejects.toThrow(/siteName/i)
  })
})
