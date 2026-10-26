/**
 * Account channels this build does not offer.
 *
 * WorkBuddy is sold under two names and ships in two builds: the China build
 * ("workbuddy", also marketed as CodeBuddy) and the international build
 * ("workbuddy-ai"). Neither is offered: the community plugin that serves them
 * signs requests as WorkBuddy's own desktop client, which is a risk this
 * product will not carry. The engine is a pinned binary whose plugin market is
 * fetched at run time, so the exclusion is enforced here, at the management
 * boundary this application owns, rather than in the engine.
 *
 * Huawei Cloud MaaS ("huaweicloud", its Token Plan preset) is likewise not
 * offered: this build carries no Huawei channel, and the engine's pinned preset
 * list is the one surface that would otherwise reintroduce it.
 *
 * A channel is denied by its subscription id, by the preset that names it, by
 * the package that serves it, and by any name carrying one of the aliases below
 * — a third-party plugin can sign in to the same provider under any package
 * name, and the China build is listed under "CodeBuddy" as often as under
 * "WorkBuddy".
 */

const DENIED_IDS = new Set(['workbuddy', 'workbuddy-ai', 'huaweicloud', 'codebuddy', 'codebuddy-cn', 'codearts'])
// Aliases, not a product name filter: every spelling a package, preset, agent
// or provider row could carry for one of these channels. "CodeArts" is Huawei
// Cloud's own coding plan, served by a community plugin rather than a preset.
const DENIED_TEXT = /workbuddy|codebuddy|huaweicloud|huawei[\s-]*cloud|modelarts|codearts|华为云|码道/i
export const POLICY_REFUSED = 'WorkBuddy and Huawei Cloud are not offered by this build'

/**
 * Whether an account channel is excluded from this build. Both the embedded
 * engine (via the filters below) and the desktop provider directory (via the
 * aggregate registry) answer this same question, so the two surfaces cannot
 * disagree about which channels this product offers.
 */
export function isDeniedChannel(id, text) {
  return deniedId(id) || deniedText(text) || deniedText(id)
}

function idOf(value) {
  return typeof value === 'string' ? value.replace(/^plugin:/i, '').replace(/-plugin$/i, '').toLowerCase() : ''
}

const deniedId = value => DENIED_IDS.has(idOf(value))
const deniedText = value => typeof value === 'string' && DENIED_TEXT.test(value)
const deniedAny = list => Array.isArray(list) && list.some(value => deniedId(value) || deniedText(value))
const deniedListing = listing => deniedText(listing?.package) || deniedAny(listing?.providers)
const deniedEntry = entry => deniedText(entry?.spec) || deniedText(entry?.package) ||
  deniedText(entry?.name) || deniedAny(entry?.providers) || deniedAny(entry?.moved)
const deniedSub = sub => deniedId(sub?.pid) || deniedId(sub?.id) || deniedText(sub?.spec) || deniedText(sub?.name)
const deniedCard = card => deniedId(card?.provider) || deniedId(card?.agent)

function filterPluginsState(state) {
  if (!state || typeof state !== 'object') return state
  if (Array.isArray(state.plugins)) state.plugins = state.plugins.filter(entry => !deniedEntry(entry))
  if (Array.isArray(state.movable)) state.movable = state.movable.filter(row => !deniedId(row?.id))
  return state
}

function filterProviders(state) {
  if (!state || typeof state !== 'object') return state
  // The pinned preset list is where Huawei Cloud's Token Plan would otherwise
  // reappear as an addable vendor; an account already added keeps working and
  // stays listed, so only the way onto the channel is withdrawn.
  if (Array.isArray(state.presets)) {
    state.presets = state.presets.filter(preset => !deniedId(preset?.id) && !deniedText(preset?.name)
      && !deniedText(preset?.short))
  }
  // An account already signed in keeps working and stays listed; only its way
  // onto the excluded plugin is withdrawn.
  for (const provider of Array.isArray(state.providers) ? state.providers : []) {
    if (deniedText(provider?.move?.package)) delete provider.move
  }
  if (Array.isArray(state.plugins)) state.plugins = state.plugins.filter(sub => !deniedSub(sub))
  if (Array.isArray(state.unmoved)) state.unmoved = state.unmoved.filter(row => !deniedId(row?.id))
  if (Array.isArray(state.onPlugins)) state.onPlugins = state.onPlugins.filter(id => !deniedId(id))
  if (state.movesTo && typeof state.movesTo === 'object') {
    for (const id of Object.keys(state.movesTo)) if (deniedId(id)) delete state.movesTo[id]
  }
  // state.movable is kept whole on purpose: the page reads it to decide a
  // built-in is deprecated and hidden, so dropping the id would surface the very
  // tile it is meant to hide. The way *onto* it is withdrawn above (`movesTo`,
  // `plugins`, `unmoved`), which is what a user can act on.
  return state
}

/** Vendor-status answers are keyed by provider id, so the excluded id goes too. */
function filterUpstream(body) {
  if (!body || typeof body !== 'object' || !body.providers || typeof body.providers !== 'object') return body
  for (const id of Object.keys(body.providers)) if (deniedId(id) || deniedText(id)) delete body.providers[id]
  return body
}

const RESPONSE_FILTERS = {
  '/api/plugins/listings': body => {
    if (Array.isArray(body.listings)) body.listings = body.listings.filter(listing => !deniedListing(listing))
    return body
  },
  '/api/plugins/market': body => {
    if (Array.isArray(body.listings)) body.listings = body.listings.filter(listing => !deniedListing(listing))
    filterPluginsState(body.state)
    return body
  },
  '/api/plugins': body => {
    if (Array.isArray(body.plugins)) body.plugins = body.plugins.filter(entry => !deniedEntry(entry))
    return body
  },
  '/api/plugins/check': body => {
    if (Array.isArray(body.plugins)) {
      body.plugins = body.plugins.filter(row => !deniedText(row?.spec) && !deniedText(row?.package))
    }
    filterPluginsState(body.state)
    return body
  },
  '/api/plugins/updates': body => {
    if (Array.isArray(body.waiting)) {
      body.waiting = body.waiting.filter(row => !deniedText(row?.spec) && !deniedText(row?.package))
    }
    if (Array.isArray(body.updated)) body.updated = body.updated.filter(row => !deniedText(row?.package))
    return body
  },
  '/api/plugins/search': body => {
    if (Array.isArray(body.hits)) body.hits = body.hits.filter(hit => !deniedText(hit?.package))
    return body
  },
  '/api/plugins/npm': body => {
    if (body.npm && typeof body.npm === 'object') {
      for (const name of Object.keys(body.npm)) if (deniedText(name)) delete body.npm[name]
    }
    return body
  },
  '/api/plugins/github': body => {
    if (Array.isArray(body.repos)) {
      body.repos = body.repos.filter(repo => !deniedText(repo?.package) &&
        !deniedText(repo?.spec) && !deniedText(repo?.repo))
    }
    return body
  },
  '/api/providers': filterProviders,
  '/api/upstream': filterUpstream,
  '/api/plugin-pages': body => Array.isArray(body) ? body.filter(page => !deniedText(page?.spec)) : body,
  '/api/plugin-panels': body => Array.isArray(body) ? body.filter(panel => !deniedText(panel?.spec)) : body,
  '/api/login/usage': body => Array.isArray(body) ? body.filter(card => !deniedCard(card)) : body,
  '/api/usage/quotas': body => Array.isArray(body) ? body.filter(card => !deniedCard(card)) : body,
  '/api/importapps': body => Array.isArray(body)
    ? body.map(source => ({
      ...source,
      items: Array.isArray(source?.items) ? source.items.filter(item => !deniedId(item?.provider?.id)) : [],
    })) : body,
}

/** Whether an engine response for this route has to be rewritten. */
export function policyResponse(pathname) {
  return Object.hasOwn(RESPONSE_FILTERS, pathname)
}

/** The same answer with the excluded channel left out; other routes pass through. */
export function filterEngineJSON(pathname, value) {
  const filter = RESPONSE_FILTERS[pathname]
  if (!filter || !value || typeof value !== 'object') return value
  return filter(value) ?? value
}

/** A plugin detail page is a lookup by name, refused before the engine is asked. */
export function deniedLookup(pathname, params) {
  return pathname === '/api/plugins/page' && deniedText(params?.get?.('name'))
}

/**
 * A gateway model row serving the excluded channel. Its provider is the row's
 * `owned_by`; the id carries it too for a namespaced listing.
 */
export function deniedModel(row) {
  return deniedId(row?.owned_by) || deniedText(row?.owned_by) || deniedText(row?.id)
}

// Turning the channel off and removing it stay open: a plugin installed before
// this change has to be removable, or hiding it would trap it.
const PLUGIN_OPS = /^\/api\/plugins\/(?:add|upgrade|options|prefer)$/
const MUTATION_ROUTES = [
  PLUGIN_OPS,
  /^\/api\/plugins\/off$/,
  /^\/api\/plugin-signin(?:\/prompt)?$/,
  /^\/api\/signin(?:\/import)?$/,
  /^\/api\/login\/[^/]+$/,
  /^\/api\/provider\/(?:move|moveback|save)$/,
]

/**
 * Whether this route's request body decides if the channel is involved. These
 * are the only bodies buffered before forwarding; every other request streams.
 */
export function policyMutation(method, pathname) {
  const verb = String(method || 'GET').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return false
  return MUTATION_ROUTES.some(route => route.test(pathname))
}

/** Refuses an engine mutation that would install, enable or sign in the channel. */
export function assertEngineMutation(method, pathname, input) {
  const verb = String(method || 'GET').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return
  const body = input && typeof input === 'object' && !ArrayBuffer.isView(input) ? input : {}
  const refuse = () => { throw Object.assign(new Error(POLICY_REFUSED), { statusCode: 403 }) }
  if (PLUGIN_OPS.test(pathname) && deniedText(body.spec)) refuse()
  // Re-enabling is a way in; switching off is the way out and stays allowed.
  if (pathname === '/api/plugins/off' && body.off === false && deniedText(body.spec)) refuse()
  if (/^\/api\/plugin-signin(?:\/prompt)?$/.test(pathname) && deniedId(body.provider)) refuse()
  if ((pathname === '/api/signin' || pathname === '/api/signin/import') && deniedId(body.agent)) refuse()
  if (/^\/api\/login\/[^/]+$/.test(pathname) && deniedId(body.agent)) refuse()
  if (/^\/api\/provider\/(?:move|moveback)$/.test(pathname) && deniedId(body.id)) refuse()
  // A save built from an excluded preset, or one naming the channel itself,
  // is the other way onto it.
  if (pathname === '/api/provider/save' && (deniedId(body.preset) || deniedId(body.id) || deniedText(body.name))) refuse()
}
