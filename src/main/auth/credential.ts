import {
  AzureCliCredential,
  ChainedTokenCredential,
  AzureDeveloperCliCredential,
  EnvironmentCredential,
  type TokenCredential,
} from '@azure/identity'

/**
 * Provedor de credencial para o modo Azure.
 *
 * Fase 1–3 do plano usam credenciais já presentes na máquina (Azure CLI etc.)
 * em vez de MSAL. A vantagem é não guardar segredo nenhum: quem detém o token
 * é o `az`, não o Runbar. A fase 4 troca isto por MSAL + safeStorage, e o
 * ponto de troca é só esta função — nada mais no app conhece credencial.
 *
 * Ordem da cadeia: variáveis de ambiente primeiro (útil em CI e para service
 * principal), depois `az login`, depois `azd`.
 */
export function createAzureCredential(): TokenCredential {
  return new ChainedTokenCredential(
    new EnvironmentCredential(),
    new AzureCliCredential(),
    new AzureDeveloperCliCredential(),
  )
}

/**
 * Verifica se há credencial utilizável, sem quebrar o boot quando não há.
 * Retorna o tenantId quando o token permite descobri-lo — ele melhora as URLs
 * do portal para quem tem mais de um diretório.
 */
export async function probeCredential(
  credential: TokenCredential,
): Promise<{ ok: true; tenantId?: string } | { ok: false; error: unknown }> {
  try {
    const token = await credential.getToken('https://management.azure.com/.default')
    if (!token) return { ok: false, error: new Error('Nenhum token retornado.') }
    const tenantId = tenantIdFromJwt(token.token)
    return tenantId ? { ok: true, tenantId } : { ok: true }
  } catch (error) {
    return { ok: false, error }
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
