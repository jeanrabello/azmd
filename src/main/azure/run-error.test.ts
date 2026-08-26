import { describe, expect, it } from 'vitest'
import { extractRunError } from './run-error.js'

/**
 * Cada caso aqui é um formato que o campo `error` (tipado como `any` no SDK)
 * pode assumir. A versão anterior lia só `error.message` e devolvia undefined
 * na maioria deles — o sintoma era a UI dizer "sem mensagem detalhada" para
 * runs que tinham motivo.
 */
describe('extractRunError', () => {
  it('lê o formato plano {code, message}', () => {
    const error = extractRunError({ code: 'ActionFailed', message: 'A ação HTTP falhou.' })
    expect(error?.message).toBe('A ação HTTP falhou.')
    expect(error?.code).toBe('ActionFailed')
  })

  it('desembrulha o erro aninhado em error.error', () => {
    const error = extractRunError({ error: { code: 'BadRequest', message: 'Payload inválido.' } })
    expect(error?.message).toBe('Payload inválido.')
    expect(error?.code).toBe('BadRequest')
  })

  it('cai para details[0] quando a mensagem do topo está vazia', () => {
    const error = extractRunError({
      code: 'WorkflowRunFailed',
      details: [{ code: 'Unauthorized', message: 'Token expirado.' }],
    })
    expect(error?.message).toBe('Token expirado.')
  })

  it('aceita erro que veio como string solta', () => {
    const error = extractRunError('Falha de conexão com o Service Bus.')
    expect(error?.message).toBe('Falha de conexão com o Service Bus.')
  })

  it('usa o code do run quando não há payload de erro nenhum', () => {
    const error = extractRunError(undefined, 'ActionFailed')
    expect(error?.code).toBe('ActionFailed')
    expect(error?.message).toContain('ActionFailed')
  })

  it('devolve undefined quando não há erro algum', () => {
    expect(extractRunError(undefined)).toBeUndefined()
    expect(extractRunError({})).toBeUndefined()
  })

  it('preserva o payload cru para a tela de detalhes', () => {
    const error = extractRunError({ code: 'X', message: 'm', extra: { pista: 42 } })
    expect(error?.raw).toContain('pista')
  })

  it('trunca payload gigante para não travar a UI', () => {
    const error = extractRunError({ message: 'm', blob: 'x'.repeat(10_000) })
    expect(error?.raw!.length).toBeLessThan(4_200)
    expect(error?.raw).toContain('truncado')
  })
})
