// src/core/completion.js
import { ROUTE_MAIN, ROUTE_REGION } from "./adapter.js";
import { toOpenAiUsage } from "./forward.js";
import { carryFailure } from "./failure.js";
import { effortsFor, defaultEffortFor } from "./effort.js";
function routableModelIds(snapshot) {
  const membership = new Set(snapshot.membership[ROUTE_MAIN] ?? []);
  if (snapshot.settings.exposeRegionModels !== false) {
    for (const id of snapshot.membership[ROUTE_REGION] ?? []) membership.add(id);
  }
  return membership;
}
function publicModelRows(snapshot) {
  const membership = routableModelIds(snapshot);
  return snapshot.catalog.filter((entry) => membership.has(entry.id)).map((entry) => {
    const efforts = effortsFor(entry, void 0, snapshot.settings.defaultMaxTokens);
    return {
      id: entry.id,
      object: "model",
      created: Math.floor(Date.now() / 1e3),
      owned_by: "our-free-model",
      ...entry.contextWindow === void 0 ? {} : { context_window: entry.contextWindow },
      ...efforts === void 0 ? {} : {
        x_ofm_efforts: efforts.map((effort) => effort.id),
        x_ofm_effort_default: defaultEffortFor(entry)
      }
    };
  });
}
function createForwardCompletion({ adapter, state, signal }) {
  return async (request, onChunk) => {
    if (signal?.aborted) throw Object.assign(new Error("model runtime is stopped"), { statusCode: 503 });
    const snapshot = state();
    const entry = snapshot.catalog.find((candidate) => candidate.id === request.model);
    if (entry === void 0 || !routableModelIds(snapshot).has(entry.id)) {
      throw Object.assign(new Error(`model "${request.model}" not found`), { statusCode: 404 });
    }
    const openAi = request.openAi ?? {};
    const messages = Array.isArray(request.messages) ? request.messages : fromOpenAiMessages(openAi, request.responses === true, entry.id);
    const tools = Array.isArray(request.tools) ? request.tools : (openAi.tools ?? []).map(normalizeTool).filter(Boolean);
    const handler = typeof onChunk === "function" ? onChunk : () => {
    };
    const outcome = { text: "", toolCalls: [], usage: void 0, truncated: false, error: void 0 };
    const maxTokens = Number.isFinite(request.maxTokens) ? request.maxTokens : Number.isFinite(openAi.max_tokens) ? openAi.max_tokens : void 0;
    const temperature = Number.isFinite(request.temperature) ? request.temperature : Number.isFinite(openAi.temperature) ? openAi.temperature : void 0;
    const reasoningEffort = typeof request.reasoningEffort === "string" ? request.reasoningEffort : typeof openAi.reasoning_effort === "string" ? openAi.reasoning_effort : void 0;
    const toolChoice = request.toolChoice === void 0 ? openAi.tool_choice : request.toolChoice;
    const options = {
      provider: ROUTE_MAIN,
      model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : void 0,
      ...temperature === void 0 ? {} : { temperature },
      ...maxTokens === void 0 ? {} : { maxTokens },
      ...reasoningEffort === void 0 ? {} : { reasoningEffort },
      ...toolChoice === void 0 ? {} : { toolChoice },
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? request.sessionId ?? "shared")}`,
      signal: request.signal && signal ? AbortSignal.any([request.signal, signal]) : request.signal ?? signal
    };
    for await (const chunk of adapter.stream(options, entry, snapshot)) {
      handler(chunk);
      foldForwardOutcome(outcome, chunk);
    }
    if (outcome.truncated === true) {
      outcome.toolCalls = outcome.toolCalls.filter((call) => {
        try {
          JSON.parse(call.arguments === "" ? "{}" : call.arguments);
          return true;
        } catch {
          return false;
        }
      });
    }
    return outcome;
  };
}
function fromOpenAiMessages(body, isResponses, modelId) {
  const out = [];
  const rows = isResponses ? normaliseResponsesInput(body.input) : Array.isArray(body.messages) ? body.messages : [];
  for (const row of rows) {
    const role = row.role ?? "user";
    const content = [];
    if (typeof row.content === "string") {
      if (row.content !== "") content.push({ type: "text", text: row.content });
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === "string") {
          if (part !== "") content.push({ type: "text", text: part });
          continue;
        }
        const text = part?.text ?? part?.input_text ?? part?.output_text;
        if (typeof text === "string" && text !== "") content.push({ type: "text", text });
        const image = part?.image_url?.url ?? part?.image_url;
        if (typeof image === "string" && image !== "") {
          content.push({ type: "image", attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: "image/png", bytes: 0, width: 0, height: 0, url: image } });
        }
      }
    }
    if (role === "tool") {
      out.push({ role: "tool", content: [{ type: "text", text: typeof row.content === "string" ? row.content : JSON.stringify(row.content ?? "") }], toolCallId: row.tool_call_id ?? "", source: { kind: "tool", callId: row.tool_call_id ?? "" } });
      continue;
    }
    if (role === "assistant" && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: "tool-call", id: call.id ?? "", name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" });
      }
    }
    if (content.length === 0) continue;
    out.push({
      role: role === "developer" ? "developer" : role === "system" ? "system" : role === "assistant" ? "assistant" : "user",
      content,
      ...role === "assistant" && typeof row.reasoning_content === "string" ? { reasoning_content: row.reasoning_content } : {},
      ...role === "assistant" ? { source: { kind: "model", provider: ROUTE_MAIN, model: String(modelId ?? "") } } : {}
    });
  }
  return out;
}
function normaliseResponsesInput(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((row) => {
    if (typeof row === "string") return { role: "user", content: row };
    if (row.type === "function_call") return { role: "assistant", content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] };
    if (row.type === "function_call_output") return { role: "tool", content: String(row.output ?? ""), tool_call_id: row.call_id };
    return row;
  });
}
function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name;
  if (typeof name !== "string" || name.trim() === "") return null;
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: "object", properties: {} };
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ""), parameters };
}
function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case "text-delta":
      outcome.text += chunk.text;
      break;
    case "tool-call-delta": {
      let call = outcome.toolCalls.find((candidate) => candidate.slot === chunk.index);
      if (call === void 0) {
        call = { slot: chunk.index, id: chunk.id ?? "", name: chunk.name ?? "", arguments: chunk.argumentsDelta ?? "" };
        outcome.toolCalls.push(call);
      } else call.arguments += chunk.argumentsDelta ?? "";
      if (chunk.name) call.name = chunk.name;
      if (chunk.id) call.id = chunk.id;
      break;
    }
    case "block-end":
      if (chunk.block?.type === "tool-call") {
        const bySlot = outcome.toolCalls.find((candidate) => candidate.slot === chunk.index);
        if (bySlot !== void 0) {
          if (typeof chunk.block.id === "string" && chunk.block.id !== "") bySlot.id = chunk.block.id;
          if (typeof chunk.block.name === "string" && chunk.block.name !== "") bySlot.name = chunk.block.name;
          if (typeof chunk.block.arguments === "string") bySlot.arguments = chunk.block.arguments;
          break;
        }
        const byId = outcome.toolCalls.find((candidate) => typeof candidate.id === "string" && candidate.id !== "" && candidate.id === chunk.block.id);
        if (byId === void 0) {
          outcome.toolCalls.push({
            slot: chunk.index,
            id: typeof chunk.block.id === "string" ? chunk.block.id : "",
            name: typeof chunk.block.name === "string" ? chunk.block.name : "",
            arguments: typeof chunk.block.arguments === "string" ? chunk.block.arguments : ""
          });
        }
      }
      break;
    case "usage":
      outcome.usage = toOpenAiUsage(chunk.usage);
      break;
    case "finish":
      if (chunk.reason?.kind === "max-tokens") outcome.truncated = true;
      if (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted") {
        outcome.failure = carryFailure(chunk.reason.failure, chunk.reason.kind);
        outcome.error = outcome.failure.message;
      }
      break;
    default:
      break;
  }
  return outcome;
}

// src/core/runtime.js
import fs from "node:fs";
import path from "node:path";
import { FreeModelAdapter, ROUTE_MAIN as ROUTE_MAIN2, ROUTE_REGION as ROUTE_REGION2 } from "./adapter.js";
import { buildCatalog, buildEacCatalog, buildKiloCatalog, isEacEntry, isKiloEntry, parseListing, reviveKiloCatalog } from "./catalog.js";
import { buildAggregateCatalog, isAggregateEntry } from "./aggregate.js";
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from "./combos.js";
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, migrateStats, pruneDays, recordTurn, recordUsage, isModelHidden } from "./store.js";
import { STATE, detectEgress, probeCatalog } from "./probe.js";
import { CODE, UpstreamError, getJson } from "./http.js";
import { runModelTest, modelAvailability } from "./model-test.js";
import { DEFAULT_LEVEL } from "./effort.js";
import { fetchSealedListing } from "./eac.js";
import { fetchKiloListing } from "./kilo.js";
import { sessionForConversation } from "./upstream.js";
import { isSubscriptionEntry, subscriptionCatalog } from "./subscription-adapter.js";
var FALLBACK_CATALOG = buildCatalog([
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
  "flint-40b-free"
]);
var LANE_QUOTA_DEFAULT_MS = 6 * 60 * 60 * 1e3;
function createRuntimeStores({ dataDir, logger = console }) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new TypeError("dataDir must be an absolute path");
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 448 });
  const open = (file, initial) => new JsonStore(path.join(dataDir, file), structuredClone(initial), {
    log: (message) => logger.warn?.(message)
  });
  const settingsInitial = structuredClone(SETTINGS_INITIAL);
  const settingsPath = path.join(dataDir, "settings.json");
  if (fs.existsSync(settingsPath)) settingsInitial.combos = [];
  const settings = new JsonStore(settingsPath, settingsInitial, {
    log: (message) => logger.warn?.(message)
  });
  const stats = open("stats.json", STATS_INITIAL);
  const availability = open("availability.json", { version: 1, at: 0, egress: null, results: {} });
  const catalogStore = open("catalog.json", { version: 1, at: 0, entries: FALLBACK_CATALOG.map((entry) => entry.id) });
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats);
  return {
    settings,
    stats,
    availability,
    catalogStore,
    dispose() {
      settings.dispose();
      stats.dispose();
      availability.dispose();
      catalogStore.dispose();
    }
  };
}
function createModelRuntime({
  settings,
  stats,
  availability,
  catalogStore,
  logger = console,
  attributionUserAgent = "our-free-model",
  resolveImage,
  sealedCredential = () => null,
  onSealedUnavailable = () => {
  },
  onTopology = () => {
  },
  subscriptionRuntime,
  extensionRuntime = null
}) {
  let catalog = materializeCatalog(catalogStore.get().entries ?? []);
  let sealedCatalog = sealedCredential() === null ? [] : buildEacCatalog(catalogStore.get().sealIds ?? []);
  let kiloCatalog = reviveKiloCatalog(catalogStore.get().kiloRows);
  let aggregateCatalog = [];
  let subscriptionEntries = [];
  let comboCatalog = [];
  let extensionCatalog = [];
  let freeCatalog = catalog;
  let egress = availability.get().egress ?? null;
  let gatewayLatency = { ms: 0, at: 0 };
  let disposed = false;
  const lifetime = new AbortController();
  let egressGeneration = 0;
  const rebuildCatalog = () => {
    const replacedLane = extensionRuntime?.replacesLane ?? null;
    const laneStandsDown = (entry) => replacedLane === "kilo" && isKiloEntry(entry);
    const seen = /* @__PURE__ */ new Set();
    const merged = [];
    for (const entry of [...freeCatalog, ...sealedCatalog, ...kiloCatalog, ...aggregateCatalog, ...extensionCatalog, ...subscriptionEntries]) {
      if (entry === null || entry === void 0 || seen.has(entry.id)) continue;
      if (laneStandsDown(entry)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
    const combos = normalizeCombos(settings.get().combos);
    comboCatalog = buildComboCatalog(combos, merged);
    pruneRotation(combos);
    for (const entry of comboCatalog) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
    catalog = merged;
  };
  const mergeCatalogs = () => {
    aggregateCatalog = buildAggregateCatalog(settings.get().aggregate ?? {});
    subscriptionEntries = subscriptionCatalog(subscriptionRuntime);
    extensionCatalog = extensionRuntime === null ? [] : extensionRuntime.catalog ?? [];
    rebuildCatalog();
  };
  mergeCatalogs();
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
    lane: laneRow(),
    routing: {
      quota: subscriptionRuntime?.routingQuota?.() ?? {},
      usage: Object.fromEntries(catalog.map((row) => [row.id, stats.get().models?.[row.id]?.calls ?? 0]))
    }
  });
  const emitTopology = () => {
    if (!disposed) onTopology();
  };
  function laneRow() {
    return availability.get().lane ?? null;
  }
  function setLaneState(laneState, extra = {}) {
    availability.edit((value) => ({ ...value, lane: { state: laneState, at: Date.now(), ...extra } }));
    availability.flush();
    emitTopology();
  }
  function laneGate() {
    const lane = laneRow();
    if (!lane || lane.state === "ok" || lane.state === void 0) return { ok: true };
    if (lane.state === "quota") {
      if (!Number.isFinite(lane.retryAt) || lane.retryAt <= Date.now()) return { ok: true };
      return { ok: false, state: "quota", retryAt: lane.retryAt, message: lane.message ?? "" };
    }
    if (lane.state === "locked") {
      return { ok: false, state: "locked", message: lane.message ?? "" };
    }
    return { ok: true };
  }
  function clearLaneBreaker() {
    const lane = laneRow();
    if (!lane || lane.state === "ok") return false;
    setLaneState("ok");
    return true;
  }
  function recordPassiveResult(model, resultState, extra = {}) {
    availability.edit((value) => ({
      ...value,
      results: {
        ...value.results,
        [model]: { ...value.results?.[model] ?? {}, state: resultState, source: "passive", at: Date.now(), ...extra }
      }
    }));
    availability.flush();
  }
  function noteFreeLaneOutcome({ entry, ok, error } = {}) {
    if (disposed || !entry || entry.channel) return;
    if (ok === true) {
      const lane = laneRow();
      if (lane && lane.state !== "ok") setLaneState("ok");
      recordPassiveResult(entry.id, STATE.available);
      return;
    }
    const code = error?.code;
    if (code === CODE.quota) {
      const retryAfter = Number(error?.providerRetryAfterMs);
      const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter : Date.now() + LANE_QUOTA_DEFAULT_MS;
      setLaneState("quota", { retryAt, message: String(error?.message ?? "free usage limit reached").slice(0, 300) });
      recordPassiveResult(entry.id, STATE.throttled);
      return;
    }
    if (code === CODE.laneLocked) {
      setLaneState("locked", { message: String(error?.message ?? "the free tier answers this client only").slice(0, 300) });
      recordPassiveResult(entry.id, STATE.unavailable);
      return;
    }
    if (code === CODE.region) recordPassiveResult(entry.id, STATE.regionBlocked);
  }
  const adapter = new FreeModelAdapter({
    state,
    resolveImage,
    subscriptionRuntime,
    sealedCredential,
    extensionRuntime,
    recordUsage: (record) => {
      if (disposed) return;
      recordUsage(stats, record);
      stats.edit((value) => pruneDays(value, 120));
    },
    recordTurn: (record) => {
      if (!disposed) recordTurn(stats, record);
    },
    warn: (message) => logger.warn?.(message) ?? logger.log?.(message),
    freeLaneGate: laneGate,
    onFreeLaneOutcome: noteFreeLaneOutcome,
    onRegionBlocked: (modelId) => {
      if (!disposed) recordPassiveResult(modelId, STATE.regionBlocked);
    }
    // Automatic probing is disabled by owner policy: a region refusal from a
    // real turn stays a turn failure and never fires a background probe.
  });
  let catalogRefresh = null;
  let catalogRefreshForced = false;
  let catalogRefreshProbed = false;
  async function refreshCatalog(opts) {
    const { probe = false, force = false, report = false, throttleListing = false } = opts ?? {};
    const result = (value) => report ? value : value.catalog;
    if (disposed) return result({ catalog, sources: {} });
    while (catalogRefresh !== null) {
      const shared = catalogRefresh;
      const sharedForced = catalogRefreshForced;
      const sharedProbed = catalogRefreshProbed;
      const value = await shared;
      if (disposed || (!force || sharedForced) && (!probe || sharedProbed)) return result(value);
    }
    const run = refreshCatalogOnce({ probe, force, throttleListing });
    catalogRefresh = run;
    catalogRefreshForced = force;
    catalogRefreshProbed = probe;
    try {
      return result(await run);
    } finally {
      if (catalogRefresh === run) {
        catalogRefresh = null;
        catalogRefreshForced = false;
        catalogRefreshProbed = false;
      }
    }
  }
  const LISTING_MIN_INTERVAL_MS = 10 * 6e4;
  let lastListingAt = 0;
  async function refreshCatalogOnce({ probe, force, throttleListing }) {
    const sources = {};
    let ids = [];
    if (throttleListing === true && !force && Date.now() - lastListingAt < LISTING_MIN_INTERVAL_MS && freeCatalog.length > 0) {
      ids = freeCatalog.map((entry) => entry.id);
      sources.free = { ok: true, count: freeCatalog.length, skipped: "recent" };
    } else {
      try {
        ids = parseListing(await fetchListing());
        lastListingAt = Date.now();
      } catch (error) {
        if (!disposed) logger.warn?.(`our-free-model: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`);
      }
    }
    if (disposed) return { catalog, sources };
    if (ids.length > 0) {
      freeCatalog = buildCatalog(ids);
      catalogStore.update({ at: Date.now(), entries: freeCatalog.map((entry) => entry.id) });
      catalogStore.flush();
      settings.update({ catalogSyncedAt: Date.now() });
    } else {
      freeCatalog = materializeCatalog(catalogStore.get().entries ?? []);
    }
    if (sources.free === void 0) sources.free = { ok: ids.length > 0, count: freeCatalog.length };
    sources.sealed = await refreshSealedRoster();
    if (disposed) return { catalog, sources };
    sources.kilo = { ok: await refreshKiloRoster(), count: kiloCatalog.length };
    if (disposed) return { catalog, sources };
    mergeCatalogs();
    if (probe) await refreshAvailability(force);
    emitTopology();
    return { catalog, sources };
  }
  async function refreshSealedRoster() {
    const credential = sealedCredential();
    if (credential === null) {
      sealedCatalog = [];
      onSealedUnavailable();
      return { ok: true, count: 0, skipped: true };
    }
    try {
      const ids = parseListing(await fetchSealedListing(credential, { signal: lifetime.signal }));
      if (disposed) return;
      if (Object.hasOwn(credential, "userToken") && sealedCredential()?.userToken !== credential.userToken) return { ok: false, count: sealedCatalog.length, skipped: true };
      if (ids.length > 0) {
        sealedCatalog = buildEacCatalog(ids);
        catalogStore.update({ sealIds: sealedCatalog.map((entry) => entry.id) });
      }
      return { ok: ids.length > 0, count: sealedCatalog.length };
    } catch (error) {
      if (disposed) return;
      if (Object.hasOwn(credential, "userToken") && sealedCredential()?.userToken !== credential.userToken) return { ok: false, count: sealedCatalog.length, skipped: true };
      if (error?.code === CODE.credential) {
        sealedCatalog = [];
        catalogStore.update({ sealIds: [] });
        logger.warn?.("our-free-model: the sealed lane refused its credential; its models are hidden until it is accepted again");
        return { ok: false, count: 0 };
      }
      logger.warn?.(`our-free-model: sealed lane listing failed (${error?.code ?? "unknown"}); keeping its cached roster`);
      return { ok: false, count: sealedCatalog.length };
    }
  }
  async function refreshSealedLane() {
    await refreshSealedRoster();
    if (disposed) return;
    mergeCatalogs();
    emitTopology();
  }
  async function refreshKiloRoster() {
    try {
      const payload = await fetchKiloListing({ signal: lifetime.signal });
      if (disposed) return;
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error("invalid Kilo model listing");
      kiloCatalog = buildKiloCatalog(payload.data);
      catalogStore.update({ kiloRows: kiloCatalog });
      return true;
    } catch (error) {
      if (!disposed) logger.warn?.(`our-free-model: Kilo channel listing failed (${error?.code ?? error?.message ?? "unknown"}); keeping its cached roster`);
      return false;
    }
  }
  async function fetchListing() {
    if (disposed) return { data: [] };
    const started = Date.now();
    const listing = await getJson("/inference/v1/models", {
      session: sessionForConversation("catalog:our-free-model"),
      attributionUserAgent,
      signal: lifetime.signal
    });
    if (!disposed) gatewayLatency = { ms: Date.now() - started, at: Date.now() };
    return listing;
  }
  let probeRound = null;
  let probeRoundGeneration = 0;
  let probeBackoffUntil = 0;
  async function runProbeRound(onlyModel) {
    const generation = egressGeneration;
    const probeable = catalog.filter((entry) => !entry.channel && !isComboEntry(entry));
    const targets = typeof onlyModel === "string" && onlyModel !== "" ? probeable.filter((entry) => entry.id === onlyModel) : probeable.filter((entry) => entry.pinned === true).slice(0, 1).length > 0 ? probeable.filter((entry) => entry.pinned === true).slice(0, 1) : probeable.slice(0, 1);
    if (targets.length === 0) return {};
    const results = await probeCatalog(targets, { attributionUserAgent, signal: lifetime.signal }, (id, result) => {
      if (disposed || generation !== egressGeneration) return;
      availability.edit((value) => ({
        ...value,
        results: {
          ...value.results,
          [id]: {
            state: result.state,
            source: "manual",
            ...result.detail === void 0 ? {} : { detail: result.detail },
            ...result.ttftMs === void 0 ? {} : { ttftMs: result.ttftMs },
            latencyMs: result.latencyMs,
            startedAt: result.startedAt,
            at: Date.now()
          }
        }
      }));
    }, 1);
    if (disposed || generation !== egressGeneration) return {};
    availability.update({ at: Date.now(), egress });
    availability.flush();
    const verdicts = Object.values(results);
    const allThrottled = verdicts.length > 0 && verdicts.every((row) => row.state === STATE.throttled);
    if (allThrottled) {
      probeBackoffUntil = Date.now() + 30 * 6e4;
      logger.warn?.("our-free-model: the manual probe hit the lane quota; the breaker now carries the window");
    } else {
      probeBackoffUntil = 0;
    }
    emitTopology();
    return results;
  }
  async function refreshAvailability(force = false, { model } = {}) {
    if (disposed) return {};
    if (!force && probeBackoffUntil > Date.now()) return {};
    const gate = laneGate();
    if (!gate.ok) return { skipped: gate.state, retryAt: gate.retryAt, message: gate.message };
    if (probeRound !== null && probeRoundGeneration === egressGeneration) return probeRound;
    probeRoundGeneration = egressGeneration;
    const round = runProbeRound(model);
    probeRound = round;
    try {
      return await round;
    } finally {
      if (probeRound === round) probeRound = null;
    }
  }
  async function watchEgress() {
    if (disposed) return false;
    const seen = await detectEgress({ signal: lifetime.signal });
    if (disposed || seen === void 0) return false;
    const previous = availability.get().egress;
    const changed = previous === null || previous === void 0 || previous.ip !== seen.ip || seen.country !== void 0 && previous.country !== seen.country;
    egress = seen;
    if (changed) {
      egressGeneration++;
      const expire = (rows) => Object.fromEntries(Object.entries(rows ?? {}).map(([id, row]) => [id, { ...row, stale: true }]));
      availability.edit((value) => ({
        ...value,
        egress: seen,
        at: 0,
        results: expire(value.results),
        manualResults: expire(value.manualResults),
        lane: { state: "ok", at: Date.now() }
      }));
      availability.flush();
      probeBackoffUntil = 0;
      emitTopology();
      logger.info?.(`our-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ""}; previous availability marked stale`);
    }
    return true;
  }
  const latestTests = /* @__PURE__ */ new Map();
  async function testModel(id, effort = DEFAULT_LEVEL, { signal } = {}) {
    if (disposed) throw new UpstreamError("Model runtime stopped", CODE.aborted);
    if (settings.get().enabled === false) throw new UpstreamError("Inference is paused", CODE.client);
    const entry = catalog.find((candidate) => candidate.id === id);
    if (!entry) throw new UpstreamError('Unknown model "' + id + '"', CODE.client, { status: 404 });
    const token = {};
    latestTests.set(id, token);
    const generation = egressGeneration;
    const selectedEffort = effort === void 0 || effort === "" ? DEFAULT_LEVEL : effort;
    const linkedSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const persist = (row) => {
      if (disposed || linkedSignal.aborted || latestTests.get(id) !== token || generation !== egressGeneration) return false;
      availability.edit((value) => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }));
      availability.flush();
      emitTopology();
      return !availability.writeFailed;
    };
    try {
      const measured = await runModelTest((testSignal) => adapter.stream({
        provider: ROUTE_MAIN2,
        model: entry.id,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        reasoningEffort: selectedEffort,
        sessionId: "bench:" + entry.id + ":" + selectedEffort,
        signal: testSignal
      }, entry, state()), { signal: linkedSignal });
      if (linkedSignal.aborted || disposed) throw new UpstreamError("Text test cancelled", CODE.aborted);
      if (generation !== egressGeneration) throw new UpstreamError("Network egress changed during the text test; please test again", CODE.aborted);
      const persisted = persist({ state: STATE.available, source: "manual", at: Date.now(), ttftMs: measured.ttftMs, latencyMs: measured.totalMs });
      return { model: entry.id, effort: selectedEffort, ok: true, ...measured, persisted };
    } catch (error) {
      if (error?.code !== CODE.aborted) persist({ state: STATE.unknown, source: "manual", at: Date.now(), detail: String(error?.message ?? error).slice(0, 200) });
      throw error;
    } finally {
      if (latestTests.get(id) === token) latestTests.delete(id);
    }
  }
  return {
    testModel,
    state,
    adapter,
    refreshCatalog,
    refreshSealedLane,
    refreshAvailability,
    watchEgress,
    fetchListing,
    laneGate,
    clearLaneBreaker,
    complete: createForwardCompletion({
      adapter,
      signal: lifetime.signal,
      state: () => {
        const snapshot = state();
        return { ...snapshot, membership: computeMembership(snapshot.catalog, availability.get(), {
          ...snapshot.settings,
          hiddenModelIds: [],
          hideFreeModels: false,
          hideEacModels: false
        }) };
      }
    }),
    publicModelRows: () => publicModelRows(state()),
    // A settings write that changes the aggregate lane or the chains (a key
    // saved, a subscription imported/toggled/removed, a combo edited) rebuilds
    // the merged view without an upstream listing round.
    syncAggregateCatalog() {
      if (disposed) return catalog;
      mergeCatalogs();
      emitTopology();
      return catalog;
    },
    // An extension install/enable/disable/uninstall lands here: the extension
    // runtime has already rebuilt its own rows, so this is a merge + announce.
    syncExtensionCatalog() {
      return this.syncAggregateCatalog();
    },
    get catalog() {
      return catalog;
    },
    get egress() {
      return egress;
    },
    get gatewayLatency() {
      return gatewayLatency;
    },
    setAttributionUserAgent(value) {
      attributionUserAgent = value;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
    }
  };
}
function materializeCatalog(ids) {
  const rebuilt = buildCatalog(ids);
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG;
}
function computeMembership(catalog, availabilitySnapshot, settings) {
  const expose = settings?.exposeRegionModels !== false;
  const verdictOf = (entry) => modelAvailability(entry.id, availabilitySnapshot, Boolean(entry.channel)).availability;
  const probeable = catalog.filter((entry) => !entry.channel);
  const refusedAll = probeable.length > 0 && probeable.every((entry) => verdictOf(entry) === STATE.unavailable);
  let usable = catalog.filter((entry) => verdictOf(entry) !== STATE.unavailable);
  if (refusedAll) usable = catalog;
  const main = [];
  const region = [];
  for (const entry of usable) {
    if (isModelHidden(entry, settings)) continue;
    const verdict = verdictOf(entry);
    if (verdict !== STATE.regionBlocked) main.push(entry.id);
    else if (expose) region.push(entry.id);
  }
  const membership = {};
  if (main.length > 0) membership[ROUTE_MAIN2] = main;
  if (region.length > 0) membership[ROUTE_REGION2] = region;
  return membership;
}

// src/core/stats.js
import { MIN_DECODE_MS } from "./store.js";
import { describeSavingsTotal, emptySavings, savingsPercent } from "./token-saver.js";
function buildStats(stats, catalog) {
  const days = stats.days ?? {};
  const series = Object.keys(days).sort().map((day) => ({
    day,
    total: days[day].total ?? 0,
    models: Object.entries(days[day].models ?? {}).map(([model, value]) => ({ model, ...value }))
  }));
  const totals = {};
  for (const entry of series) for (const row of entry.models) {
    const previous = totals[row.model] ?? {
      model: row.model,
      input: 0,
      output: 0,
      reasoning: 0,
      calls: 0,
      failed: 0,
      ttftMs: 0,
      ttftSamples: 0,
      decodeMs: 0,
      decodeTokens: 0
    };
    totals[row.model] = {
      ...previous,
      input: previous.input + row.input,
      output: previous.output + row.output,
      reasoning: previous.reasoning + row.reasoning,
      calls: previous.calls + row.calls,
      failed: previous.failed + row.failed,
      ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
      decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0)
    };
  }
  const logical = stats.logical ?? {};
  const logicalModels = logical.models ?? {};
  const logicalReady = Number.isSafeInteger(logical.turns);
  const lifetimeModels = stats.models ?? {};
  const empty = (model) => ({
    model,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    calls: 0,
    failed: 0,
    ttftMs: 0,
    ttftSamples: 0,
    decodeMs: 0,
    decodeTokens: 0
  });
  const modelIds = /* @__PURE__ */ new Set([...Object.keys(totals), ...Object.keys(lifetimeModels), ...Object.keys(logicalModels)]);
  const named = [...modelIds].map((model) => {
    const row = totals[model] ?? empty(model);
    const lifetime = lifetimeModels[model] ?? {};
    const physical = {
      ...row,
      input: Number.isSafeInteger(lifetime.input) ? lifetime.input : row.input,
      output: Number.isSafeInteger(lifetime.output) ? lifetime.output : row.output,
      reasoning: Number.isSafeInteger(lifetime.reasoning) ? lifetime.reasoning : row.reasoning,
      cacheRead: Number.isSafeInteger(lifetime.cacheRead) ? lifetime.cacheRead : row.cacheRead,
      calls: Number.isSafeInteger(lifetime.calls) ? lifetime.calls : row.calls,
      failed: Number.isSafeInteger(lifetime.failed) ? lifetime.failed : row.failed
    };
    return {
      ...physical,
      turns: logicalModels[model]?.turns ?? (logicalReady ? 0 : row.calls),
      failedTurns: logicalModels[model]?.failed ?? (logicalReady ? 0 : row.failed),
      recoveredTurns: logicalModels[model]?.recovered ?? 0,
      name: catalog.find((entry) => entry.id === model)?.name ?? model,
      // A rate over too few measurable calls is a rounding error with a unit on it.
      tps: row.decodeMs >= MIN_DECODE_MS ? Math.round(row.decodeTokens / (row.decodeMs / 1e3)) : null,
      avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null
    };
  });
  const physicalFailed = named.reduce((sum, row) => sum + row.failed, 0);
  const turns = logicalReady ? logical.turns : named.reduce((sum, row) => sum + row.turns, 0);
  const failedTurns = Number.isSafeInteger(logical.failed) ? logical.failed : named.reduce((sum, row) => sum + row.failedTurns, 0);
  const recoveredTurns = Number.isSafeInteger(logical.recovered) ? logical.recovered : named.reduce((sum, row) => sum + row.recoveredTurns, 0);
  const hasLifetimeFailures = Number.isSafeInteger(stats.failedRequests);
  const savings = { ...emptySavings(), ...stats.savings ?? {} };
  return {
    requests: stats.requests ?? 0,
    requestFailures: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
    requestFailuresEstimated: stats.failedRequestsEstimated === true || !hasLifetimeFailures,
    logicalEstimated: logical.estimated === true,
    turns,
    failedTurns,
    recoveredTurns,
    days: series,
    models: named,
    samples: (stats.samples ?? []).slice(-200),
    // What the token savers measured. The percentage is computed here, from the
    // same bytes the rows above counted, so the panel never has to derive a rate
    // from two numbers that were rounded separately.
    savings: { ...savings, percent: savingsPercent(savings), summary: describeSavingsTotal(savings) },
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
      turns,
      failedTurns,
      recoveredTurns
    }
  };
}
export {
  buildStats,
  computeMembership,
  createForwardCompletion,
  createModelRuntime,
  createRuntimeStores,
  foldForwardOutcome,
  fromOpenAiMessages,
  publicModelRows,
  routableModelIds
};
