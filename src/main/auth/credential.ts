import {
  AuthenticationRequiredError,
  AzureCliCredential,
  AzureDeveloperCliCredential,
  ChainedTokenCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  EnvironmentCredential,
  useIdentityPlugin,
  type AuthenticationRecord,
  type DeviceCodeInfo,
  type TokenCredential,
} from '@azure/identity'
import type { AuthAccount, AuthConfig } from '../../shared/types.js'
import { TOKEN_CACHE_NAME, azmdCachePersistencePlugin } from './token-cache-store.js'

/*
 * Registro do plugin de cache, no import do módulo.
 *
 * Tem que acontecer antes de qualquer credencial ser construída — é o que o
 * `@azure/identity` exige para aceitar `tokenCachePersistenceOptions`. No topo
 * do módulo garante isso sem depender de alguém lembrar de chamar init: quem
 * importa `createAzureCredential` já importou o registro.
 */
useIdentityPlugin(azmdCachePersistencePlugin)

/**
 * Provedor de credencial para o modo Azure.
 *
 * Toda a superfície de autenticação do app é esta função: os adapters do ARM
 * só conhecem a interface `TokenCredential`. Trocar de credencial é trocar aqui
 * e em nenhum outro lugar.
 *
 * Três modos, por três necessidades diferentes:
 *  - `deviceCode`: o padrão. Login interativo, sem CLI e — o ponto importante —
 *    sem App Registration.
 *  - `servicePrincipal`: credencial de aplicação, para operação contínua sem
 *    ninguém para clicar em nada.
 *  - `azureCli`: a cadeia original, para dev e para quem já vive no `az`.
 *
 * PERSISTÊNCIA DA SESSÃO
 * O cache de tokens do MSAL é persistido e cifrado por
 * `auth/token-cache-store.ts`, um `ICachePlugin` sobre o `safeStorage` do
 * Electron. Isso mantém o refresh token entre execuções sem depender de
 * `@azure/identity-cache-persistence` (que traz keytar, módulo nativo, e o
 * custo de rebuild/notarização que este app evita).
 *
 * A versão anterior guardava o cache só em memória, e o efeito era ruim de
 * diagnosticar: o `AuthenticationRecord` reidentificava a conta, a UI mostrava
 * o usuário logado, mas não havia token para renovar — ao reabrir o app o
 * device code era pedido de novo e o polling ficava parado sem erro visível.
 * Ver o comentário de token-cache-store.ts.
 */

/** Escopo do ARM: é o único recurso que o app consulta. */
const ARM_SCOPE = 'https://management.azure.com/.default'

/** O que a credencial precisa saber. Inclui o segredo — por isso só existe no main. */
export interface CredentialInput {
  readonly config: AuthConfig
  /** Secret lido do Keychain. Só relevante em `servicePrincipal`. */
  readonly clientSecret?: string
  /** Record do device code, quando há um salvo. */
  readonly authRecord?: AuthenticationRecord
  /** Recebe o código do device flow. Só usado em `deviceCode`. */
  readonly onPrompt?: (info: {
    userCode: string
    verificationUri: string
    message: string
  }) => void
}

/**
 * Configuração incompleta, distinta de falha de rede ou 401.
 *
 * A distinção existe para a UI: "faltou o Client ID" tem conserto óbvio;
 * um 401 opaco vindo do ARM, não. Sem esta classe, esquecer um campo do
 * service principal apareceria como erro de autenticação genérico.
 */
export class AuthConfigError extends Error {
  readonly kind = 'authConfig'
}

/** Lança `AuthConfigError` quando a config está incompleta. */
export function createAzureCredential(input: CredentialInput): TokenCredential {
  switch (input.config.mode) {
    case 'servicePrincipal':
      return createServicePrincipalCredential(input)
    case 'deviceCode':
      return createDeviceCodeCredential(input)
    case 'azureCli':
      return createAzureCliCredential()
  }
}

function createServicePrincipalCredential(input: CredentialInput): TokenCredential {
  const { tenantId, clientId } = input.config
  const secret = input.clientSecret

  // Diz *o que* falta, e não apenas que falta algo: o usuário digitou três
  // campos numa tela e precisa saber qual deles voltar a preencher.
  const missing: string[] = []
  if (!tenantId) missing.push('Tenant ID')
  if (!clientId) missing.push('Client ID')
  if (!secret) missing.push('Client Secret')
  if (!tenantId || !clientId || !secret) {
    throw new AuthConfigError(
      `Service principal incompleto: falta ${missing.join(', ')}. Preencha em Configurações › Autenticação.`,
    )
  }

  return new ClientSecretCredential(tenantId, clientId, secret)
}

function createDeviceCodeCredential(input: CredentialInput): DeviceCodeCredential {
  const { config, onPrompt } = input

  return new DeviceCodeCredential({
    // POR QUE NÃO PASSAMOS `clientId` QUANDO O USUÁRIO NÃO CONFIGUROU UM
    // Esta é a descoberta que dispensa criar App Registration. Sem `clientId`,
    // o @azure/identity@4.13.2 usa `DeveloperSignOnClientId` =
    // "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
    // (node_modules/@azure/identity/dist/commonjs/credentials/deviceCodeCredential.js:67),
    // que é o client ID público da própria Azure CLI — pré-autorizado em
    // qualquer tenant do Entra ID. Passar `clientId: undefined` explicitamente
    // funcionaria igual, mas com `exactOptionalPropertyTypes` o spread
    // condicional é a forma correta de dizer "não informe este campo".
    ...(config.clientId ? { clientId: config.clientId } : {}),
    // Sem tenant informado, o MSAL usa "organizations" e resolve pelo login.
    ...(config.tenantId ? { tenantId: config.tenantId } : {}),
    // O record indica qual conta procurar no cache em memória, permitindo
    // renovação silenciosa sem novo código.
    ...(input.authRecord ? { authenticationRecord: input.authRecord } : {}),
    // Persiste o cache de tokens (cifrado) para a sessão sobreviver ao
    // restart. Sem isto, só o `authenticationRecord` cruzava execuções — e ele
    // identifica a conta sem carregar token, o que fazia o app pedir device
    // code a cada abertura. Ver token-cache-store.ts.
    tokenCachePersistenceOptions: { enabled: true, name: TOKEN_CACHE_NAME },
    // CRÍTICO: nenhum `getToken` implícito pode abrir fluxo de login. Um probe
    // no boot ou um ciclo de polling que resolvesse em "mostre um código ao
    // usuário" seria um pop-up vindo do nada. Login é ação explícita, feita por
    // `signInWithDeviceCode`, que chama `authenticate()` — o único caminho que
    // ignora esta flag.
    disableAutomaticAuthentication: true,
    userPromptCallback: (info: DeviceCodeInfo) => {
      onPrompt?.({
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        message: info.message,
      })
    },
  })
}

/**
 * A cadeia original, preservada para o modo `azureCli`.
 *
 * A vantagem dela é não guardar segredo nenhum: quem detém o token é o `az`,
 * não o azmd. Ordem: variáveis de ambiente primeiro (útil em CI), depois
 * `az login`, depois `azd`.
 */
function createAzureCliCredential(): TokenCredential {
  return new ChainedTokenCredential(
    new EnvironmentCredential(),
    new AzureCliCredential(),
    new AzureDeveloperCliCredential(),
  )
}

/**
 * Verifica se há credencial utilizável, sem quebrar o boot quando não há.
 *
 * NÃO É INTERATIVO: nunca abre fluxo de login. Em `deviceCode` isso vem de
 * `disableAutomaticAuthentication`, que faz o MSAL lançar
 * `AuthenticationRequiredError` em vez de emitir um código. Traduzimos isso em
 * `needsSignIn: true` para que a UI ofereça "Entrar" em vez de mostrar um erro
 * — são situações diferentes e merecem tratamento diferente.
 *
 * Retorna o tenantId quando o token permite descobri-lo — ele melhora as URLs
 * do portal para quem tem mais de um diretório.
 */
export async function probeCredential(
  credential: TokenCredential,
): Promise<{ ok: true; tenantId?: string } | { ok: false; error: unknown; needsSignIn?: boolean }> {
  try {
    const token = await credential.getToken(ARM_SCOPE)
    if (!token) return { ok: false, error: new Error('Nenhum token retornado.') }
    const tenantId = tenantIdFromJwt(token.token)
    return tenantId ? { ok: true, tenantId } : { ok: true }
  } catch (error) {
    return needsInteractiveSignIn(error)
      ? { ok: false, error, needsSignIn: true }
      : { ok: false, error }
  }
}

/**
 * O erro significa "precisa logar"?
 *
 * O caminho normal é `instanceof`, mas ele falha em dois casos reais: o erro
 * pode vir embrulhado por uma `AggregateAuthenticationError` da cadeia, e pode
 * atravessar uma fronteira de bundle onde a classe não é a mesma instância.
 * Por isso checamos também `name` e, por último, a mensagem.
 */
function needsInteractiveSignIn(error: unknown): boolean {
  if (error instanceof AuthenticationRequiredError) return true
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; message?: unknown; errors?: unknown }
  if (candidate.name === 'AuthenticationRequiredError') return true
  if (Array.isArray(candidate.errors) && candidate.errors.some(needsInteractiveSignIn)) return true
  return (
    typeof candidate.message === 'string' &&
    /authentication\s+required|interactive\s+authentication\s+is\s+needed/i.test(candidate.message)
  )
}

/**
 * Login interativo por device code. Só válido em `mode === 'deviceCode'`.
 *
 * `authenticate()` — e não `getToken()` — porque é o único método que ignora
 * `disableAutomaticAuthentication` e portanto pode emitir o código. Ele
 * devolve o `AuthenticationRecord` que o chamador deve persistir.
 */
export async function signInWithDeviceCode(
  input: CredentialInput,
): Promise<{ record: AuthenticationRecord; account: AuthAccount; credential: TokenCredential }> {
  if (input.config.mode !== 'deviceCode') {
    throw new AuthConfigError(
      'Login interativo só existe no modo "Entrar com minha conta". Troque o modo em Configurações › Autenticação.',
    )
  }

  const credential = createDeviceCodeCredential(input)
  const record = await credential.authenticate(ARM_SCOPE)
  if (!record) {
    // Acontece quando o usuário abandona o fluxo ou o código expira sem uso.
    // A tipagem permite `undefined`, então tratamos em vez de confiar.
    throw new Error('O login não foi concluído: nenhuma conta foi autenticada.')
  }

  /*
   * POR QUE DEVOLVEMOS A CREDENCIAL, E NÃO SÓ O RECORD
   *
   * O token que este login produziu vive no cache EM MEMÓRIA desta instância —
   * não há cache em disco (ver comentário do módulo). O `AuthenticationRecord`
   * diz *qual conta* procurar nesse cache, mas não carrega token nenhum.
   *
   * Descartar a credencial aqui e montar outra para as consultas dava uma
   * instância de cache vazio: o `getToken` não achava nada, e como
   * `disableAutomaticAuthentication` proíbe pedir código, ele lançava
   * "Automatic authentication has been disabled" — logo depois de um login
   * bem-sucedido. Quem chama precisa REUTILIZAR esta instância enquanto o
   * processo viver.
   */
  return {
    record,
    account: { username: record.username, tenantId: record.tenantId },
    credential,
  }
}

/**
 * Extrai o `tid` do payload do JWT.
 *
 * Só lemos um claim informativo para montar URL — não validamos assinatura,
 * porque não somos a parte que confia no token: quem valida é o ARM.
 */
function tenantIdFromJwt(jwt: string): string | undefined {
  const payload = jwt.split('.')[1]
  if (!payload) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && 'tid' in parsed) {
      const tid = (parsed as { tid: unknown }).tid
      return typeof tid === 'string' ? tid : undefined
    }
  } catch {
    // Token opaco ou formato inesperado: seguimos sem tenant.
  }
  return undefined
}
