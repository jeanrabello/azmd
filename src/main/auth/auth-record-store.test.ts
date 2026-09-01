import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticationRecord } from '@azure/identity'

/**
 * O arquivo é JSON legível e editável à mão. Um record com campo faltando não
 * pode chegar ao `@azure/identity`: a falha apareceria como erro de MSAL, longe
 * daqui. O contrato é "inválido = não há record", que cai no fluxo de login.
 */
const state = { userData: '' }

vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

const { AuthRecordStore } = await import('./auth-record-store.js')

const valid: AuthenticationRecord = {
  authority: 'login.microsoftonline.com',
  homeAccountId: 'home-account',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  tenantId: 'tenant-1',
  username: 'jean@exemplo.com',
}

function writeRaw(contents: string): void {
  writeFileSync(join(state.userData, 'auth-record.json'), contents, 'utf8')
}

describe('AuthRecordStore', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'azmd-record-'))
  })

  afterEach(() => {
    rmSync(state.userData, { recursive: true, force: true })
  })

  it('faz round-trip do record', () => {
    const store = new AuthRecordStore()
    store.set(valid)
    expect(store.get()).toEqual(valid)
  })

  it('não deixa arquivo .tmp para trás', () => {
    new AuthRecordStore().set(valid)
    expect(existsSync(join(state.userData, 'auth-record.json.tmp'))).toBe(false)
  })

  it('devolve undefined quando não há arquivo', () => {
    expect(new AuthRecordStore().get()).toBeUndefined()
  })

  it('devolve undefined para JSON corrompido', () => {
    writeRaw('{ isto não é json')
    expect(new AuthRecordStore().get()).toBeUndefined()
  })

  it('devolve undefined quando falta qualquer campo', () => {
    for (const field of ['authority', 'homeAccountId', 'clientId', 'tenantId', 'username']) {
      const incomplete: Record<string, string> = { ...valid }
      delete incomplete[field]
      writeRaw(JSON.stringify(incomplete))
      expect(new AuthRecordStore().get()).toBeUndefined()
    }
  })

  it('rejeita campo com tipo errado ou vazio', () => {
    writeRaw(JSON.stringify({ ...valid, tenantId: 42 }))
    expect(new AuthRecordStore().get()).toBeUndefined()
    writeRaw(JSON.stringify({ ...valid, username: '' }))
    expect(new AuthRecordStore().get()).toBeUndefined()
  })

  it('descarta campos extras em vez de repassá-los ao MSAL', () => {
    writeRaw(JSON.stringify({ ...valid, injetado: 'lixo' }))
    expect(new AuthRecordStore().get()).toEqual(valid)
  })

  it('clear apaga o record e tolera ausência', () => {
    const store = new AuthRecordStore()
    store.set(valid)
    store.clear()
    expect(store.get()).toBeUndefined()
    expect(() => store.clear()).not.toThrow()
  })
})
