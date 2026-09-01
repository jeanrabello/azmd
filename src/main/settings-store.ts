import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  LOOKBACK_BOUNDS,
  POLL_INTERVAL_BOUNDS,
  type AuthAccount,
  type AuthConfig,
  type AuthMode,
  type DataSourceMode,
  type Scope,
  type Settings,
  type WatchSelection,
} from '../shared/types.js'

/**
 * Persistência de preferências.
 *
 * Implementação própria em vez de `electron-store` por dois motivos: a versão
 * atual é ESM-only e adiciona atrito no bundle do main, e a necessidade aqui é
 * um JSON pequeno. Menos dependência, menos superfície.
 *
 * Só preferências passam por aqui. Nada sensível: este arquivo é texto plano
 * no disco do usuário. Token e `clientSecret` moram no Keychain, via
 * safeStorage (ver main/auth/secret-store.ts) — de `AuthConfig` este JSON
 * guarda apenas o booleano `hasClientSecret`, nunca o valor.
 */

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Valida o que veio do disco ou do IPC.
 *
 * Tudo que entra é `unknown`: um settings.json editado à mão pode conter
 * qualquer coisa, e o renderer é código não-confiável por princípio. Validar
 * aqui é o que garante que o resto do main pode confiar no tipo `Settings`.
 */
export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const raw: Record<string, unknown> =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}

  const mode: DataSourceMode = raw['mode'] === 'azure' ? 'azure' : raw['mode'] === 'demo' ? 'demo' : base.mode

  const tenantId = typeof raw['tenantId'] === 'string' && raw['tenantId'].length > 0
    ? raw['tenantId']
    : base.tenantId

  return {
    mode,
    pollIntervalSeconds: clamp(
      typeof raw['pollIntervalSeconds'] === 'number' ? raw['pollIntervalSeconds'] : base.pollIntervalSeconds,
      POLL_INTERVAL_BOUNDS.min,
      POLL_INTERVAL_BOUNDS.max,
    ),
    lookbackHours: clamp(
      typeof raw['lookbackHours'] === 'number' ? raw['lookbackHours'] : base.lookbackHours,
      LOOKBACK_BOUNDS.min,
      LOOKBACK_BOUNDS.max,
    ),
    scope: sanitizeScope(raw['scope'], base.scope),
    watch: sanitizeWatch(raw['watch'], base.watch),
    auth: sanitizeAuth(raw['auth'], base.auth),
    notificationsEnabled:
      typeof raw['notificationsEnabled'] === 'boolean'
        ? raw['notificationsEnabled']
        : base.notificationsEnabled,
    launchAtLogin:
      typeof raw['launchAtLogin'] === 'boolean' ? raw['launchAtLogin'] : base.launchAtLogin,
    ...(tenantId ? { tenantId } : {}),
  }
}

const AUTH_MODES: readonly AuthMode[] = ['deviceCode', 'servicePrincipal', 'azureCli']

/** Só o que for string não-vazia interessa; '' equivale a ausente. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Valida o bloco `auth`.
 *
 * Duas coisas aqui não são simetria com os outros sanitizers, e são de
 * propósito:
 *
 *  1. `hasClientSecret` NÃO vem do input. Quem sabe se existe um secret é o
 *     Keychain (`SecretStore`), não este JSON — que pode estar desatualizado
 *     por ter sido editado à mão, copiado de outra máquina, ou restaurado de
 *     backup enquanto o Keychain ficou para trás. Preservamos o valor do
 *     `base`, que o AppController recalcula a partir do store a cada escrita.
 *
 *  2. Um `clientSecret` que apareça no input é descartado em silêncio. É o
 *     ponto de segurança central deste arquivo: settings.json é texto plano, e
 *     um secret que entrasse aqui — por patch malformado do renderer ou por
 *     alguém colando à mão — ficaria gravado em claro no disco. Descartar sem
 *     erro é intencional: gritar sobre o campo tenderia a ecoar o valor em log.
 *
 * `auth` ausente cai inteiro no `base` (que na leitura de disco é
 * `DEFAULT_AUTH_CONFIG`), o que faz um settings.json legado, gravado antes de
 * existir autenticação configurável, continuar carregando sem erro.
 */
export function sanitizeAuth(input: unknown, base: AuthConfig): AuthConfig {
  if (typeof input !== 'object' || input === null) return base
  const raw = input as Record<string, unknown>

  const mode = AUTH_MODES.find((candidate) => candidate === raw['mode']) ?? base.mode
  const tenantId = nonEmptyString(raw['tenantId']) ?? base.tenantId
  const clientId = nonEmptyString(raw['clientId']) ?? base.clientId
  const account = sanitizeAuthAccount(raw['account']) ?? base.account

  return {
    mode,
    hasClientSecret: base.hasClientSecret,
    ...(tenantId ? { tenantId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(account ? { account } : {}),
  }
}

/**
 * A conta só é útil se identificar quem entrou e onde: metade dela seria
 * pior que nada, porque a UI mostraria "conectado" sem saber como quem.
 */
function sanitizeAuthAccount(input: unknown): AuthAccount | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  const username = nonEmptyString(raw['username'])
  const tenantId = nonEmptyString(raw['tenantId'])
  if (!username || !tenantId) return undefined
  return { username, tenantId }
}

function sanitizeWatch(input: unknown, base: WatchSelection): WatchSelection {
  if (typeof input !== 'object' || input === null) return base
  const raw = input as Record<string, unknown>
  return {
    ignoredLogicAppIds: stringList(raw['ignoredLogicAppIds'], base.ignoredLogicAppIds),
    ignoredWorkflowResourceIds: stringList(
      raw['ignoredWorkflowResourceIds'],
      base.ignoredWorkflowResourceIds,
    ),
  }
}

/** Mantém só strings: o arquivo pode ter sido editado à mão. */
function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function sanitizeScope(input: unknown, base: Scope): Scope {
  if (typeof input !== 'object' || input === null) return base
  const raw = input as Record<string, unknown>
  return {
    subscriptionIds: stringList(raw['subscriptionIds'], base.subscriptionIds),
    resourceGroups: stringList(raw['resourceGroups'], base.resourceGroups),
    workflowResourceIds: stringList(raw['workflowResourceIds'], base.workflowResourceIds),
  }
}

export class SettingsStore {
  #cached: Settings | undefined

  get(): Settings {
    if (this.#cached) return this.#cached
    this.#cached = this.#readFromDisk()
    return this.#cached
  }

  update(patch: Partial<Settings>): Settings {
    const merged = sanitizeSettings({ ...this.get(), ...patch }, this.get())
    this.#cached = merged
    this.#writeToDisk(merged)
    return merged
  }

  /**
   * Grava `auth` por inteiro, sem passar pelo merge com o valor anterior.
   *
   * Existe separado de `update({ auth })` porque `sanitizeAuth` é escrito para
   * entrada não-confiável e, nesse papel, herda do base tudo que o input não
   * traz: `hasClientSecret` sempre, e os campos opcionais quando ausentes. Isso
   * é o certo lendo disco ou patch do renderer, e é justamente o errado aqui —
   * quem chama é o AppController, que já sanitizou o patch, já consultou o
   * Keychain e precisa poder *apagar* um clientId ou desmarcar
   * `hasClientSecret`. Herdar o valor antigo faria "limpar" virar no-op.
   */
  updateAuth(auth: AuthConfig): Settings {
    const merged: Settings = { ...this.get(), auth }
    this.#cached = merged
    this.#writeToDisk(merged)
    return merged
  }

  #readFromDisk(): Settings {
    try {
      const contents = readFileSync(settingsPath(), 'utf8')
      return sanitizeSettings(JSON.parse(contents))
    } catch {
      // Primeiro boot, ou arquivo corrompido: os padrões são sempre válidos.
      return DEFAULT_SETTINGS
    }
  }

  /** Escrita atômica: um crash no meio não deixa um JSON pela metade. */
  #writeToDisk(settings: Settings): void {
    const target = settingsPath()
    try {
      mkdirSync(dirname(target), { recursive: true })
      const temp = `${target}.tmp`
      writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8')
      renameSync(temp, target)
    } catch (error) {
      console.error('[azmd] falha ao salvar settings:', error)
    }
  }
}
