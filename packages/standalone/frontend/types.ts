export type Page = string

export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  hiddenByUser?: boolean
  hiddenByGroup?: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availabilitySource?: 'listing' | 'probe' | 'manual'
  detail?: string
  probedAt?: number
  latencyMs?: number
  availability?: string
  ttftMs?: number | null
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number; ttftMs?: number; persisted?: boolean }
export interface ServiceSettings {
  enabled: boolean
  exposeRegionModels: boolean
  hiddenModelIds: string[]
  hideFreeModels: boolean
  hideEacModels: boolean
  streamRecovery: boolean
  standaloneProbe: boolean
  probeIntervalMinutes: number
  defaultMaxTokens: number
  developerPlugins: boolean
  autoUpdateExtensions: boolean
}

export interface PluginPermissions { network: string[]; secrets: string[]; storage: boolean }
export interface PluginConfigField {
  key: string
  type: 'text' | 'password' | 'toggle' | 'number' | 'select'
  label: string
  description: string
  default?: unknown
  options?: string[]
}
export interface PluginPage {
  id: string
  pluginId: string
  pageId: string
  title: string
  description?: string
  group: string
  order: number
  icon: string
  url: string
  builtin: boolean
  version: string
}
export interface PluginRecord {
  id: string
  name: string
  version: string
  kind: string
  kinds: string[]
  type: string
  description: string
  author: string
  license: string
  homepage: string
  repository: string
  icon: string
  permissions: PluginPermissions
  config: PluginConfigField[]
  hooks: string[]
  enabled: boolean
  builtin: boolean
  essential: boolean
  source: 'registry' | 'local' | 'builtin' | string
  verified: boolean
  installedAt: string
  state: string
  error: string
  apiVersion: string
  requires: string[]
  provides: string[]
  selfTestAvailable: boolean
  secrets: { key: string; hasValue: boolean; hint: string }[]
  values: Record<string, unknown>
  pages: { id: string; title: string; entry: string; group: string; order: number; icon: string }[]
  pageCount: number
  fileCount: number
  modelCount?: number
}
export interface PluginRegistryEntry extends Omit<PluginRecord, 'enabled' | 'installedAt' | 'state' | 'error' | 'secrets' | 'values' | 'pageCount' | 'fileCount' | 'modelCount' | 'source' | 'verified' | 'builtin' | 'essential'> {
  summary?: string
  tags?: string[]
  publishedAt?: string
  changelog?: string[]
  sourceUrl?: string
  models?: { id: string; name?: string }[]
  cover?: { url: string; size: number; sha256: string; contentType?: string }
  installed: boolean
  installedVersion?: string
  enabled: boolean
  updateAvailable: boolean
  installable: boolean
  state: string
  fileCount: number
}
export interface PluginUpdate {
  id: string
  from: string
  to: string
  seenAt: number
  ready: boolean
  soakRemainingMs: number
  enabled: boolean
}

export interface RegistryMeta {
  source: string
  fetchedAt: number
  generatedAt: string
  soakHours: number
}

export interface PluginsSummary {
  installedCount: number
  builtinCount: number
  pages: PluginPage[]
  developerPlugins: boolean
}

export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  channels: { state: string; error?: string }
  eacAuth?: { local?: boolean; authorized?: boolean; login?: string }
  catalog: Model[]
  plugins?: PluginsSummary | null
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number; reasoning: number }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  saveSettings(settings: Partial<ServiceSettings>): Promise<ServiceSettings>
  request<T = unknown>(path: string, body?: unknown, timeoutMs?: number): Promise<T>
}
