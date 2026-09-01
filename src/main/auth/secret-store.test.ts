import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * O `electron` não existe no runtime do vitest (é o binário do Electron que o
 * fornece), então mockamos os dois membros que o store usa. Testamos a lógica
 * de arquivo e as decisões de segurança de verdade, com um userData temporário;
 * o que fingimos é só a cifra.
 */
const state = {
  userData: '',
  encryptionAvailable: true,
  /** Quando true, `decryptString` lança — simula Keychain negando ou chave rotacionada. */
  decryptFails: false,
}

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    // Cifra de brinquedo: inverte os bytes. O que importa é que o conteúdo em
    // disco não seja o texto original — isso o teste verifica.
    encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (buffer: Buffer) => {
      if (state.decryptFails) throw new Error('keychain recusou')
      return Buffer.from(buffer).reverse().toString('utf8')
    },
  },
}))

const { SecretStore } = await import('./secret-store.js')

describe('SecretStore', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'azmd-secret-'))
    state.encryptionAvailable = true
    state.decryptFails = false
  })

  afterEach(() => {
    rmSync(state.userData, { recursive: true, force: true })
  })

  it('faz round-trip do secret', () => {
    const store = new SecretStore()
    store.set('s3cr3t-do-service-principal')
    expect(store.get()).toBe('s3cr3t-do-service-principal')
  })

  it('não deixa o secret em texto plano no arquivo', () => {
    new SecretStore().set('valor-em-claro')
    const raw = readFileSync(join(state.userData, 'auth-secret.bin'), 'utf8')
    expect(raw).not.toContain('valor-em-claro')
  })

  it('não deixa arquivo .tmp para trás', () => {
    new SecretStore().set('abc')
    expect(existsSync(join(state.userData, 'auth-secret.bin.tmp'))).toBe(false)
  })

  it('lança em vez de gravar plaintext quando não há encriptação', () => {
    state.encryptionAvailable = false
    const store = new SecretStore()
    expect(() => store.set('nunca-deve-chegar-ao-disco')).toThrow(/armazenamento seguro/i)
    // A garantia que importa: nada foi escrito.
    expect(existsSync(join(state.userData, 'auth-secret.bin'))).toBe(false)
  })

  it('reporta indisponibilidade via isAvailable', () => {
    state.encryptionAvailable = false
    expect(new SecretStore().isAvailable()).toBe(false)
  })

  it('devolve undefined quando não há arquivo', () => {
    expect(new SecretStore().get()).toBeUndefined()
  })

  it('devolve undefined quando o decrypt falha, sem propagar', () => {
    const store = new SecretStore()
    store.set('algo')
    state.decryptFails = true
    expect(() => store.get()).not.toThrow()
    expect(store.get()).toBeUndefined()
  })

  it('devolve undefined para arquivo corrompido em vez de string vazia', () => {
    writeFileSync(join(state.userData, 'auth-secret.bin'), Buffer.alloc(0))
    expect(new SecretStore().get()).toBeUndefined()
  })

  it('clear apaga o secret e tolera ausência', () => {
    const store = new SecretStore()
    store.set('abc')
    store.clear()
    expect(store.get()).toBeUndefined()
    expect(() => store.clear()).not.toThrow()
  })
})
