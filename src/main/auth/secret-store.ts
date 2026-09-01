import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Guarda o `clientSecret` do service principal.
 *
 * POR QUE UM ARQUIVO SEPARADO
 * O `settings.json` é texto plano e declara, no próprio comentário do módulo,
 * que só preferências passam por ele. Um secret de aplicação não é preferência:
 * vale um arquivo próprio, cifrado, com um caminho que ninguém confunde com
 * config.
 *
 * POR QUE `safeStorage` E NÃO keytar
 * O `safeStorage` do Electron encosta no Keychain do macOS sem módulo nativo
 * extra — nada a recompilar para cada versão do Electron, nada a mais para
 * assinar e notarizar. A chave usada é derivada da identidade do app, então o
 * arquivo cifrado só é legível por este app nesta máquina, que é exatamente a
 * garantia que queremos.
 *
 * REGRA DURA: se a encriptação não estiver disponível, `set` falha. Gravar o
 * secret em texto plano "para funcionar" trocaria uma falha visível por um
 * vazamento silencioso — pior negócio.
 */

function secretPath(): string {
  return join(app.getPath('userData'), 'auth-secret.bin')
}

export class SecretStore {
  /**
   * No macOS costuma ser sempre true; em Linux sem chaveiro configurado, false.
   * Quem chama usa isto para avisar o usuário *antes* de ele digitar o secret.
   */
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Lê o secret. Retorna `undefined` em qualquer falha, de propósito.
   *
   * Os modos de falha aqui são todos recuperáveis pela UI ("nenhum secret
   * guardado, digite de novo"): arquivo ausente no primeiro uso, Keychain
   * negando acesso, ou chave rotacionada depois de uma reinstalação do app.
   * Nenhum deles justifica derrubar o boot, então nada propaga.
   */
  get(): string | undefined {
    try {
      const encrypted = readFileSync(secretPath())
      const secret = safeStorage.decryptString(encrypted)
      return secret.length > 0 ? secret : undefined
    } catch {
      return undefined
    }
  }

  /** Lança quando não há encriptação disponível — ver comentário do módulo. */
  set(secret: string): void {
    if (!this.isAvailable()) {
      throw new Error(
        'Não há armazenamento seguro disponível nesta máquina; o secret não foi salvo. ' +
          'Guardá-lo em texto plano não é uma opção.',
      )
    }
    const target = secretPath()
    mkdirSync(dirname(target), { recursive: true })
    // Escrita atômica, mesmo padrão do settings-store: um crash no meio deixa
    // o arquivo antigo intacto em vez de um blob cifrado pela metade, que na
    // leitura seria indistinguível de "Keychain recusou".
    const temp = `${target}.tmp`
    writeFileSync(temp, safeStorage.encryptString(secret))
    renameSync(temp, target)
  }

  /** Apagar algo que já não existe é sucesso: `force` evita ruído no sign-out. */
  clear(): void {
    try {
      rmSync(secretPath(), { force: true })
    } catch (error) {
      console.error('[azmd] falha ao apagar o secret:', error)
    }
  }
}
