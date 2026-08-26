import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  LOOKBACK_BOUNDS,
  POLL_INTERVAL_BOUNDS,
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
 * Só preferências passam por aqui. Nada sensível: tokens ficam com o Azure CLI
 * (hoje) ou no Keychain via safeStorage (fase 4). Ver plano, seção 9.
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
    notificationsEnabled:
      typeof raw['notificationsEnabled'] === 'boolean'
        ? raw['notificationsEnabled']
        : base.notificationsEnabled,
    launchAtLogin:
      typeof raw['launchAtLogin'] === 'boolean' ? raw['launchAtLogin'] : base.launchAtLogin,
    ...(tenantId ? { tenantId } : {}),
  }
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
      console.error('[runbar] falha ao salvar settings:', error)
    }
  }
}
