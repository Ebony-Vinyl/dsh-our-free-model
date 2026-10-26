import { listProviders, getProvider } from '../../src/providers/index.js'
import { fetchProviderModels, testProvider } from '../../src/aggregate.js'
import { isDeniedChannel } from '../../src/magpie-policy.js'

const fail = message => Object.assign(new Error(message), { statusCode: 400 })
const modelsOf = value => {
  if (!Array.isArray(value) || value.length > 300 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 300 || /[\0\r\n]/.test(id))) {
    throw fail('模型清单必须为不超过 300 项的模型名称数组')
  }
  return [...new Set(value.map(id => id.trim()))]
}

export function publicProviders(section) {
  return Object.fromEntries(Object.entries(section?.providers ?? {}).map(([id, value]) => [id, {
    enabled: value.enabled !== false,
    hasKey: typeof value.apiKey === 'string' && value.apiKey !== '',
    keyHint: value.apiKey ? `…${value.apiKey.slice(-4)}` : '',
    baseUrl: value.baseUrl ?? '',
    models: value.models ?? [], discovered: value.discovered ?? [],
    lastTest: value.lastTest ? { ...value.lastTest, message: String(value.lastTest.message ?? '').replaceAll(value.apiKey || '\0', '[redacted]') } : undefined,
  }]))
}

export function createProviderManagement({ stores, runtime, persist }) {
  const get = id => {
    if (typeof id !== 'string') throw fail('请选择供应商')
    // A channel this build does not offer is unknown here, exactly as it is
    // absent from the directory above.
    if (isDeniedChannel(id)) throw fail('此渠道不在本应用的提供范围内')
    const provider = getProvider(id)
    if (!provider) throw fail('未知供应商')
    return provider
  }
  function write(id, value) {
    const section = stores.settings.get().aggregate ?? {}
    const providers = { ...section.providers }
    if (value === null) delete providers[id]
    else providers[id] = value
    persist({ aggregate: { ...section, providers } })
    runtime.syncAggregateCatalog()
    return { configured: publicProviders(stores.settings.get().aggregate) }
  }
  return {
    list() {
      return {
        registry: listProviders().map(provider => ({
          id: provider.id, name: provider.name, category: provider.category, format: provider.format,
          authKind: provider.auth.kind, baseUrl: provider.baseUrl ?? '', modelCount: provider.models.length,
          models: provider.models.map(model => model.id), website: provider.website ?? '',
          notes: provider.notes ?? '', credentialUrl: provider.auth.url ?? '', local: provider.local === true,
        })),
        configured: publicProviders(stores.settings.get().aggregate),
      }
    },
    save(patch) {
      const provider = get(patch.providerId)
      if (!['apiKey', 'none'].includes(provider.auth.kind)) throw fail('此渠道请使用订阅账号导入')
      for (const name of Object.keys(patch)) if (!['providerId', 'enabled', 'apiKey', 'baseUrl', 'models'].includes(name)) throw fail('不支持的供应商设置字段')
      const previous = stores.settings.get().aggregate?.providers?.[provider.id] ?? {}
      const next = { enabled: true, ...previous, addedAt: previous.addedAt ?? Date.now() }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw fail('enabled 必须为布尔值')
        next.enabled = patch.enabled
      }
      if (patch.apiKey !== undefined) {
        if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 8192 || /[\0\r\n]/.test(patch.apiKey)) throw fail('API Key 格式无效')
        next.apiKey = patch.apiKey.trim()
      }
      if (patch.baseUrl !== undefined) {
        if (typeof patch.baseUrl !== 'string' || patch.baseUrl.length > 2048) throw fail('API 地址无效')
        const raw = patch.baseUrl.trim()
        if (raw) {
          let parsed
          try { parsed = new URL(raw) } catch { throw fail('请输入有效的 HTTP 或 HTTPS 地址') }
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw fail('API 地址不能包含凭据、查询参数或片段')
        }
        next.baseUrl = raw.replace(/\/+$/, '')
      }
      if (patch.models !== undefined) next.models = modelsOf(patch.models)
      // A changed endpoint or credential invalidates the old connectivity verdict.
      if (next.baseUrl !== previous.baseUrl || next.apiKey !== previous.apiKey) delete next.lastTest
      return write(provider.id, next)
    },
    remove({ providerId }) { get(providerId); return write(providerId, null) },
    async test({ providerId }, signal) {
      get(providerId)
      const started = stores.settings.get().aggregate?.providers?.[providerId]
      const result = await testProvider(stores.settings.get().aggregate, providerId, { signal })
      const current = stores.settings.get().aggregate?.providers?.[providerId]
      if (current && current === started && !signal?.aborted) write(providerId, { ...current, lastTest: { ...result, at: Date.now() } })
      return result
    },
    async discover({ providerId }, signal) {
      get(providerId)
      const started = stores.settings.get().aggregate?.providers?.[providerId]
      const ids = await fetchProviderModels(stores.settings.get().aggregate, providerId, { signal })
      if (ids === null) return { models: null, note: '供应商没有可用的模型列表接口' }
      const current = stores.settings.get().aggregate?.providers?.[providerId]
      if (current && current === started && !signal?.aborted) write(providerId, { ...current, discovered: ids.slice(0, 300) })
      return { models: ids }
    },
  }
}
