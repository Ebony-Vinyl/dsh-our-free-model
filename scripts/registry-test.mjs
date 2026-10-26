/**
 * Offline tests for the aggregate lane's provider registry.
 *
 * The registry is data plus a thin loader, and both failure modes are silent:
 * a record that loses a field (or a whole provider) degrades the picker without
 * erroring, and a composite id that stops round-tripping breaks routing only at
 * the moment a request is sent. So the checks below are shape, uniqueness,
 * round-trip and exact-count assertions. Transport regressions use a local
 * HTTP receiver; no external provider or credential is needed.
 *
 * The three wire formats are pinned to their real suffixes here because that is
 * the contract the aggregate lane sends on: openai-chat -> /chat/completions,
 * openai-responses -> /responses, anthropic-messages -> /messages.
 *
 * Run: node scripts/registry-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { postAggregateStreamed } from '../src/aggregate.js'
import {
  PROVIDERS,
  PROVIDER_IDS,
  AUTH_KINDS,
  CATEGORY_VALUES,
  FORMAT_VALUES,
  getProvider,
  listProviders,
  providerModelId,
  parseProviderModelId,
  defaultHeaders,
  chatEndpoint,
  modelsEndpoint,
} from '../src/providers/index.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const repo = fileURLToPath(new URL('..', import.meta.url))
const raw = fs.readFileSync(path.join(repo, 'src/providers/registry.json'), 'utf8')

// Tripwires, not preferences: bump them together with a deliberate data change
// so an accidental truncation of registry.json cannot pass as a smaller catalog.
// The `free` category is empty on purpose: OpenCode's keyless pool needs a
// per-request fingerprint the aggregate transport cannot carry, so it is not a
// row here (see README's aggregate section) — the free lane serves it instead.
const EXPECTED_PROVIDERS = 76
const EXPECTED_BY_CATEGORY = { apikey: 61, 'free-tier': 10, local: 3, oauth: 2 }
const EXPECTED_MODELS = 502
const FLEETRELAY_MODELS = ['deepseek-v4.1-flash-free', 'gpt-6-astra']

const byCategory = {}
for (const provider of PROVIDERS) byCategory[provider.category] = (byCategory[provider.category] ?? 0) + 1
const allModels = PROVIDERS.flatMap(provider => provider.models)
const nonEmpty = value => typeof value === 'string' && value.trim() !== ''
const nullableString = value => value === null || typeof value === 'string'
const nullableBoolean = value => value === null || typeof value === 'boolean'
const nullableNumber = value => value === null || (typeof value === 'number' && Number.isFinite(value))

// ── the data file ─────────────────────────────────────────────────────────────
check('registry.json parses from disk and matches the loader', () => {
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed), 'registry.json must be an array')
  assert.deepEqual(parsed, PROVIDERS)
})

check(`the catalog carries exactly ${EXPECTED_PROVIDERS} providers`, () => {
  assert.equal(PROVIDERS.length, EXPECTED_PROVIDERS)
  assert.deepEqual(byCategory, EXPECTED_BY_CATEGORY)
  assert.equal(allModels.length, EXPECTED_MODELS)
})

check('every record has the required fields with valid enum values', () => {
  for (const provider of PROVIDERS) {
    assert.ok(nonEmpty(provider.id), `${provider.id}: id`)
    assert.ok(!provider.id.includes('/'), `${provider.id}: a provider id must not contain "/"`)
    assert.ok(nonEmpty(provider.name), `${provider.id}: name`)
    assert.ok(CATEGORY_VALUES.includes(provider.category), `${provider.id}: category ${provider.category}`)
    assert.ok(provider.auth !== null && typeof provider.auth === 'object', `${provider.id}: auth`)
    assert.ok(AUTH_KINDS.includes(provider.auth.kind), `${provider.id}: auth.kind ${provider.auth.kind}`)
    assert.ok(nullableString(provider.auth.env), `${provider.id}: auth.env`)
    assert.ok(nullableString(provider.auth.url), `${provider.id}: auth.url`)
    assert.ok(provider.baseUrl === null || nonEmpty(provider.baseUrl), `${provider.id}: baseUrl`)
    assert.ok(FORMAT_VALUES.includes(provider.format), `${provider.id}: format ${provider.format}`)
    assert.ok(Array.isArray(provider.models), `${provider.id}: models`)
    assert.ok(nonEmpty(provider.notes), `${provider.id}: notes`)
    assert.ok(nonEmpty(provider.website), `${provider.id}: website`)
    assert.equal(typeof provider.local, 'boolean', `${provider.id}: local`)
    assert.ok(['fcc', '9router', 'custom'].includes(provider.source), `${provider.id}: source ${provider.source}`)
    assert.equal(provider.local, provider.category === 'local', `${provider.id}: local must track category "local"`)
  }
})

check('every model row is complete and unique inside its provider', () => {
  for (const provider of PROVIDERS) {
    const seen = new Set()
    for (const model of provider.models) {
      assert.ok(nonEmpty(model.id), `${provider.id}: model id`)
      assert.ok(nonEmpty(model.name), `${provider.id}/${model.id}: name`)
      assert.ok(nullableNumber(model.contextWindow), `${provider.id}/${model.id}: contextWindow`)
      assert.ok(nullableBoolean(model.vision), `${provider.id}/${model.id}: vision`)
      assert.ok(nullableBoolean(model.reasoning), `${provider.id}/${model.id}: reasoning`)
      assert.ok(!seen.has(model.id), `${provider.id}: duplicate model id ${model.id}`)
      seen.add(model.id)
    }
  }
})

check('optional fields are well formed where present', () => {
  const envPattern = /^[A-Z][A-Z0-9_]*$/
  for (const provider of PROVIDERS) {
    if (provider.freeModelsHint !== undefined) {
      assert.ok(Array.isArray(provider.freeModelsHint) && provider.freeModelsHint.length > 0, `${provider.id}: freeModelsHint`)
      const ids = new Set(provider.models.map(model => model.id))
      for (const hint of provider.freeModelsHint) {
        assert.ok(nonEmpty(hint), `${provider.id}: freeModelsHint entry`)
        assert.ok(ids.has(hint), `${provider.id}: freeModelsHint ${hint} is not in models`)
      }
    }
    if (provider.baseUrlOverrideEnv !== undefined) {
      assert.ok(envPattern.test(provider.baseUrlOverrideEnv), `${provider.id}: baseUrlOverrideEnv ${provider.baseUrlOverrideEnv}`)
    }
    if (provider.headers !== undefined) {
      assert.ok(provider.headers !== null && typeof provider.headers === 'object' && !Array.isArray(provider.headers), `${provider.id}: headers`)
      for (const [name, value] of Object.entries(provider.headers)) {
        assert.ok(nonEmpty(name) && nonEmpty(value), `${provider.id}: header ${name}`)
      }
    }
  }
})

check('provider ids are unique and sorted by category then id', () => {
  const ids = PROVIDERS.map(provider => provider.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate provider id')
  assert.deepEqual(PROVIDER_IDS.size, ids.length)
  const sorted = [...PROVIDERS].sort((a, b) =>
    CATEGORY_VALUES.indexOf(a.category) - CATEGORY_VALUES.indexOf(b.category) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  assert.deepEqual(ids, sorted.map(provider => provider.id), 'registry.json is not sorted')
})

check('every provider except the documented four keeps at least one model id', () => {
  // Azure deployments are user-named and the three local servers list whatever
  // the user loaded or pulled, so those four carry no ids by design.
  const allowedEmpty = new Set(['azure_openai', 'llamacpp', 'lmstudio', 'ollama'])
  for (const provider of PROVIDERS) {
    if (allowedEmpty.has(provider.id)) continue
    assert.ok(provider.models.length > 0, `${provider.id}: empty model list`)
  }
})

check('every base URL is absolute, slash-free at the end, and double-slash-free', () => {
  for (const provider of PROVIDERS) {
    if (provider.baseUrl === null) continue
    assert.match(provider.baseUrl, /^https?:\/\//, `${provider.id}: baseUrl scheme`)
    assert.ok(!provider.baseUrl.endsWith('/'), `${provider.id}: trailing slash on baseUrl`)
    assert.ok(!provider.baseUrl.slice(provider.baseUrl.indexOf('://') + 3).includes('//'), `${provider.id}: double slash in baseUrl`)
    const modelsUrl = modelsEndpoint(provider)
    if (modelsUrl !== null) {
      assert.match(modelsUrl, /^https?:\/\//, `${provider.id}: modelsUrl scheme`)
      assert.ok(!modelsUrl.slice(modelsUrl.indexOf('://') + 3).includes('//'), `${provider.id}: double slash in modelsUrl`)
    }
  }
})

// ── credentials ───────────────────────────────────────────────────────────────
check('keyless and local providers carry a base URL and no credential env', () => {
  for (const provider of PROVIDERS) {
    if (provider.category !== 'local' && provider.auth.kind !== 'none') continue
    assert.ok(nonEmpty(provider.baseUrl), `${provider.id}: baseUrl is required`)
    assert.equal(provider.auth.env, null, `${provider.id}: env must be null`)
  }
})

check('apiKey providers name an env var and a credential URL', () => {
  for (const provider of PROVIDERS) {
    if (provider.auth.kind !== 'apiKey') continue
    assert.ok(nonEmpty(provider.auth.env), `${provider.id}: auth.env`)
    assert.ok(nonEmpty(provider.auth.url), `${provider.id}: auth.url`)
  }
})

check('oauth and adc providers take no env credential', () => {
  for (const provider of PROVIDERS) {
    if (provider.auth.kind !== 'oauth' && provider.auth.kind !== 'adc') continue
    assert.equal(provider.auth.env, null, `${provider.id}: env must be null`)
    assert.ok(nonEmpty(provider.auth.url), `${provider.id}: auth.url`)
  }
})

// ── composite ids ─────────────────────────────────────────────────────────────
check('provider/model round-trips for every provider and every model', () => {
  for (const provider of PROVIDERS) {
    assert.equal(providerModelId(provider.id, 'some-model'), `${provider.id}/some-model`)
    for (const model of provider.models) {
      const composite = providerModelId(provider.id, model.id)
      assert.equal(composite, `${provider.id}/${model.id}`)
      assert.deepEqual(parseProviderModelId(composite), { providerId: provider.id, modelId: model.id })
    }
  }
})

check('the parser refuses unknown prefixes and malformed composites', () => {
  assert.equal(parseProviderModelId('unknown/x'), null)
  assert.equal(parseProviderModelId('nvidia-nim/x'), null)
  assert.equal(parseProviderModelId('mimo-v2.6-flash-free'), null)
  assert.equal(parseProviderModelId('deepseek-ai/deepseek-v4.1-flash'), null)
  assert.equal(parseProviderModelId('openai/'), null)
  assert.equal(parseProviderModelId('/gpt-5'), null)
  assert.equal(parseProviderModelId(''), null)
  assert.equal(parseProviderModelId(undefined), null)
  assert.equal(providerModelId('unknown', 'x'), null)
  assert.equal(providerModelId('openai', ''), null)
})

check('a model id that itself contains slashes survives the round-trip', () => {
  assert.deepEqual(parseProviderModelId('openai_api/gpt-5.6-sol'), { providerId: 'openai_api', modelId: 'gpt-5.6-sol' })
  assert.deepEqual(parseProviderModelId('nvidia_nim/nvidia/nemotron-3-super-120b-a12b'),
    { providerId: 'nvidia_nim', modelId: 'nvidia/nemotron-3-super-120b-a12b' })
  assert.deepEqual(parseProviderModelId('cloudflare/@cf/moonshotai/kimi-k2.6'),
    { providerId: 'cloudflare', modelId: '@cf/moonshotai/kimi-k2.6' })
})

// ── endpoints ─────────────────────────────────────────────────────────────────
check('chatEndpoint appends the suffix the wire expects, with no double slashes', () => {
  const suffixByFormat = { 'openai-chat': '/chat/completions', 'openai-responses': '/responses', 'anthropic-messages': '/messages' }
  const seenFormats = new Set()
  for (const provider of PROVIDERS) {
    if (provider.baseUrl === null) {
      assert.equal(chatEndpoint(provider), null, `${provider.id}: a null base URL yields no endpoint`)
      continue
    }
    const endpoint = chatEndpoint(provider)
    const suffix = suffixByFormat[provider.format]
    seenFormats.add(provider.format)
    assert.equal(endpoint, `${provider.baseUrl}${suffix}`, `${provider.id}: ${endpoint}`)
    assert.ok(!endpoint.slice(endpoint.indexOf('://') + 3).includes('//'), `${provider.id}: double slash in ${endpoint}`)
  }
  assert.deepEqual([...seenFormats].sort(), [...FORMAT_VALUES].sort(), 'every format must be represented')
})

check('chatEndpoint covers the three formats on real records', () => {
  assert.equal(chatEndpoint('openai_api'), 'https://api.openai.com/v1/responses')
  assert.equal(chatEndpoint('anthropic'), 'https://api.anthropic.com/v1/messages')
  assert.equal(chatEndpoint('minimax-cn'), 'https://api.minimaxi.com/anthropic/v1/messages')
  assert.equal(chatEndpoint('nvidia_nim'), 'https://integrate.api.nvidia.com/v1/chat/completions')
  assert.equal(chatEndpoint('openai'), 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(chatEndpoint('lmstudio'), 'http://localhost:1234/v1/chat/completions')
  assert.equal(chatEndpoint('ollama'), 'http://localhost:11434/v1/chat/completions')
  assert.equal(chatEndpoint('azure_openai'), null)
  assert.equal(chatEndpoint('no-such-provider'), null)
})

check('the FleetRelay gateway exposes only its live public model catalog', () => {
  const provider = getProvider('fleetrelay_t1')
  assert.ok(provider, 'fleetrelay_t1 is missing')
  assert.equal(provider.category, 'apikey')
  assert.equal(provider.auth.kind, 'apiKey')
  assert.equal(provider.baseUrl, 'https://vpn2.asigo.top:8443/v1')
  assert.equal(provider.format, 'openai-responses')
  assert.equal(provider.source, 'custom')
  assert.deepEqual(provider.models.map(model => model.id), FLEETRELAY_MODELS)
  assert.equal(chatEndpoint(provider), 'https://vpn2.asigo.top:8443/v1/responses')
  assert.equal(modelsEndpoint(provider), 'https://vpn2.asigo.top:8443/v1/models')
})

check('the unapproved 0d relay is not directly configurable in OurFreeModel', () => {
  assert.equal(getProvider('third_party_0d'), null)
  assert.equal(parseProviderModelId('third_party_0d/glm-5.3'), null)
})

check('modelsEndpoint returns a declared listing URL or null', () => {
  assert.equal(modelsEndpoint('nvidia_nim'), 'https://integrate.api.nvidia.com/v1/models')
  assert.equal(modelsEndpoint('groq'), 'https://api.groq.com/openai/v1/models')
  assert.equal(modelsEndpoint('anthropic'), null)
  assert.equal(modelsEndpoint('no-such-provider'), null)
})

// ── headers ───────────────────────────────────────────────────────────────────
check('defaultHeaders attaches a bearer token for apiKey providers only', () => {
  for (const provider of PROVIDERS) {
    const headers = defaultHeaders(provider, 'k-test')
    if (provider.auth.kind === 'apiKey') {
      const credential = headers.authorization ?? headers['x-api-key']
      assert.ok(nonEmpty(credential), `${provider.id}: no credential header`)
      if (provider.format === 'anthropic-messages') {
        assert.equal(headers['x-api-key'], 'k-test', `${provider.id}: x-api-key`)
        assert.equal(headers.authorization, undefined, `${provider.id}: bearer on the Anthropic wire`)
      } else {
        assert.equal(headers.authorization, 'Bearer k-test', `${provider.id}: bearer`)
      }
    } else {
      // A keyless row never gains a credential: the aggregate transport is
      // generic, and a provider that needs its own fingerprint cannot be driven
      // through it — see the note on the removed OpenCode row in registry.json.
      assert.equal(headers.authorization, undefined, `${provider.id}: unexpected bearer`)
      assert.equal(headers['x-api-key'], undefined, `${provider.id}: unexpected x-api-key`)
    }
    assert.equal(headers['content-type'], 'application/json', `${provider.id}: content-type`)
    if (provider.format === 'anthropic-messages') assert.equal(headers['anthropic-version'], '2023-06-01', `${provider.id}: anthropic-version`)
  }
})

check('defaultHeaders without a key never invents one, and merges declared headers', () => {
  assert.equal(defaultHeaders('nvidia_nim').authorization, undefined)
  assert.equal(defaultHeaders('minimax-cn', 'k')['anthropic-beta'], 'claude-code-20250219,interleaved-thinking-2025-05-14')
  assert.equal(defaultHeaders('kimchi', 'k')['user-agent'], 'kimchi/0.1.50')
  assert.deepEqual(defaultHeaders('no-such-provider', 'k'), {})
})

// ── lookups and filters ───────────────────────────────────────────────────────
check('getProvider finds records and refuses unknown ids', () => {
  assert.equal(getProvider('nvidia_nim').name, 'NVIDIA NIM')
  assert.equal(getProvider('no-such-provider'), null)
  assert.equal(getProvider(undefined), null)
})

check('listProviders filters by category, format and auth kind', () => {
  assert.equal(listProviders().length, EXPECTED_PROVIDERS)
  for (const category of CATEGORY_VALUES) {
    const rows = listProviders({ category })
    // A category with no rows today (`free`) still has to be a legal filter that
    // answers empty, not an error — the picker offers it either way.
    assert.equal(rows.length, EXPECTED_BY_CATEGORY[category] ?? 0, `category ${category}`)
    assert.ok(rows.every(provider => provider.category === category), `category ${category} leaked`)
  }
  const responses = listProviders({ format: 'openai-responses' })
  assert.deepEqual(responses.map(provider => provider.id).sort(), ['fleetrelay_t1', 'openai', 'openai_api'])
  const messages = listProviders({ format: 'anthropic-messages' })
  assert.deepEqual(messages.map(provider => provider.id).sort(), ['anthropic', 'glm', 'minimax-cn'])
  const keyless = listProviders({ authKind: 'none' })
  assert.deepEqual(keyless.map(provider => provider.id).sort(), ['llamacpp', 'lmstudio', 'ollama'])
  const oauth = listProviders({ authKind: 'oauth' })
  assert.deepEqual(oauth.map(provider => provider.id).sort(), ['github_copilot', 'openai'])
  const adc = listProviders({ authKind: 'adc' })
  assert.deepEqual(adc.map(provider => provider.id).sort(), ['vertex', 'vertex-partner'])
})

check('listProviders searches id, name, model id and notes, case-insensitively', () => {
  assert.deepEqual(listProviders({ search: 'NVIDIA NIM' }).map(provider => provider.id), ['nvidia_nim'])
  assert.deepEqual(listProviders({ search: 'nemotron-3-super' }).map(provider => provider.id).sort(), ['bazaarlink', 'kilo', 'nvidia_nim'])
  assert.ok(listProviders({ search: 'free tier' }).length > 0)
  assert.deepEqual(listProviders({ search: 'NO-SUCH-PROVIDER-ANYWHERE' }), [])
  assert.equal(listProviders({ search: '  ' }).length, EXPECTED_PROVIDERS)
})

check('filters combine, and the returned rows are the frozen shared records', () => {
  const rows = listProviders({ category: 'free-tier', format: 'openai-chat', authKind: 'apiKey', search: 'glm' })
  assert.deepEqual(rows.map(provider => provider.id).sort(), ['bazaarlink', 'byteplus', 'cloudflare', 'nvidia_nim', 'ollama_cloud', 'opencode_zen'])
  assert.equal(rows[0], getProvider(rows[0].id))
  assert.throws(() => { rows[0].notes = 'mutated' }, TypeError)
})

const received = []
const receiver = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    received.push({ path: req.url, raw, body: JSON.parse(raw) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
})
try {
  await new Promise((resolve, reject) => {
    receiver.once('error', reject)
    receiver.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${receiver.address().port}/v1`
  const cases = [
    ['open_router', 'google/gemma-4-31b-it:free', '/v1/chat/completions'],
    ['openai_api', 'gpt-5.5', '/v1/responses'],
    ['anthropic', 'claude-sonnet-4-20250514', '/v1/messages'],
  ]
  for (const [providerId, modelId, expectedPath] of cases) {
    const prompt = [{ role: 'user', content: 'local routing audit' }]
    const body = {
      model: providerModelId(providerId, modelId),
      ...(providerId === 'openai_api' ? { input: prompt, max_output_tokens: 64 } : { messages: prompt, max_tokens: 64 }),
    }
    for (const encoding of ['object', 'json']) {
      const input = encoding === 'json' ? JSON.stringify({ ...body, stream: false }) : body
      const original = structuredClone(input)
      try {
        await postAggregateStreamed({
          config: { providers: { [providerId]: { enabled: true, apiKey: 'synthetic-local-key', baseUrl } } },
          providerId, modelId, body: input, timeoutMs: 3000, onData: () => {},
        })
        check(`aggregate transport sends the bare model id for ${providerId}, ${encoding} (#323)`, () => {
          const actual = received.at(-1)
          assert.equal(actual.path, expectedPath)
          assert.deepEqual(actual.body, { ...body, model: modelId, stream: true })
          assert.deepEqual(input, original, 'the caller body stays unchanged')
        })
      } catch (error) {
        failures++
        console.error(`FAIL  aggregate transport for ${providerId}, ${encoding} — ${error.message}`)
      }
    }
  }
  const compatibilityBody = { model: 'google/gemma-4-31b-it:free', messages: [{ role: 'user', content: 'local audit' }], stream: false }
  for (const body of [compatibilityBody, JSON.stringify(compatibilityBody, null, 2)]) {
    await postAggregateStreamed({
      config: { providers: { open_router: { enabled: true, apiKey: 'synthetic-local-key', baseUrl } } },
      providerId: 'open_router', body, timeoutMs: 3000, onData: () => {},
    })
    check(`omitting modelId preserves the ${typeof body === 'string' ? 'raw JSON' : 'object'} body contract`, () => {
      if (typeof body === 'string') assert.equal(received.at(-1).raw, body)
      else assert.deepEqual(received.at(-1).body, { ...body, stream: true })
      assert.equal(compatibilityBody.stream, false, 'the original object is not mutated')
    })
  }
  for (const body of ['{broken', 'null', '[]', '"text"']) {
    const before = received.length
    let failure
    try {
      await postAggregateStreamed({
        config: { providers: { open_router: { enabled: true, apiKey: 'synthetic-local-key', baseUrl } } },
        providerId: 'open_router', modelId: 'google/gemma-4-31b-it:free', body,
        timeoutMs: 3000, onData: () => {},
      })
    } catch (error) { failure = error }
    check(`a routed serialized body must be a JSON object: ${body}`, () => {
      assert.equal(failure?.code, 'CLIENT_ERROR')
      assert.equal(received.length, before, 'invalid JSON must not reach the provider')
    })
  }
} finally {
  receiver.closeAllConnections()
  await new Promise(resolve => receiver.close(resolve))
}

if (failures > 0) console.error(`registry-test: ${failures} failure(s)`)
else console.log(`registry-test: ${PROVIDERS.length} providers, ${allModels.length} model ids, every wire path resolves`)
process.exitCode = failures > 0 ? 1 : 0
