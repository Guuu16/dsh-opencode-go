/**
 * Host half of dsh-opencode-go.
 *
 * One class-based Cordis plugin that also exposes the `opencodePool` Typert
 * Remote (strict-mode dispatch driven by `typert.host.js`):
 *
 *   1. Exposes its `Config` (all fields volatile) as this entry's settings
 *      document; the card writes keys through `putKeys` with the settings
 *      service's revision fencing, and volatile live-commits re-apply the
 *      config without a remount.
 *   2. Maintains the KeyPool state machine, persisted to
 *      `$DSH_HOME/dsh-opencode-go.state.json`.
 *   3. Owns the provider route (default `opencode-go`, taking over the
 *      single-key route dsh-llm-pi-ai serves): an LlmAdapter whose stream()
 *      silently retries with the next pool key on quota/credential failures
 *      that arrive before any content, so the conversation never notices.
 *      While the route is owned elsewhere the plugin stays dormant and
 *      re-attempts registration on every `llm/adapters-updated` commit.
 *   4. Answers the card: per-key usage from the official OpenCode Go usage
 *      endpoint, plus switch/disable/clear actions.
 *   5. Model selection: the card picks which catalog models the route
 *      exposes (listModels filters; resolveModel/stream gate the rest).
 *
 * @module dsh-opencode-go
 */

import z from '@deepseek-ai/schemastery'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  assertUsableApiKey,
  INVALID_CREDENTIAL_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { AUTH_CODE, KeyPool, assertKeyList, harnessRetryBudget } from './pool.js'
import { fetchUsage, UsageCache } from './usage.js'
import {
  dynamicModelDescriptor,
  fetchModels,
  loadDynamicModels,
  saveDynamicModels,
} from './models.js'

export const name = 'dsh-opencode-go'

const DISPLAY_NAME = 'OpenCode Zen Go（池）'
const DEFAULT_ROUTE = 'opencode-go'
const ALT_ROUTE = 'opencode-go-alt'
const DEFAULT_USAGE_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'
const DEFAULT_MODELS_BASE_URL = 'https://opencode.ai/zen/go/v1/models'
const MODELS_CACHE_FILE = 'dsh-opencode-go.models.json'
const STATE_FILE = 'dsh-opencode-go.state.json'
// Pre-rename names. A pool that had a key disabled by hand keeps that mark
// across the rename because the legacy file is migrated on first start.
const LEGACY_STATE_FILE = 'opencode-go-pool.state.json'
const LEGACY_MODELS_CACHE_FILE = 'opencode-go-pool.models.json'
const DEFAULT_USAGE_REFRESH_MS = 30000
const DEFAULT_TIMEOUT_MS = 15000
const USAGE_CACHE_TTL_MS = 15000
const REVIVE_THRESHOLD_PERCENT = 98
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
/** Provider attempts one stream() call may make: the failing key plus one rotation. */
const MAX_ATTEMPTS_PER_REQUEST = 2

/**
 * Cap on `llm-retry` backoff for this route. A pool retry usually lands on a
 * different account, so the delay exists to space out a sweep rather than to
 * wait out one endpoint: the harness default of 10s would make a full sweep of
 * ten accounts (keys × threshold = 40 retries) take about six minutes before the
 * task may resume, where a 2s cap bounds the same sweep to roughly 80 seconds.
 */
const POOL_MAX_RETRY_DELAY_MS = 2000
const POOL_INITIAL_RETRY_DELAY_MS = 500

/** The default bounded transient-retry code set, plus quota for pool rotation. */
const BASE_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

const keyEntry = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
})

// Every field is volatile: the DSH 0.2 settings seam only accepts writes to
// volatile paths, and volatile edits commit live (no fiber remount, so an
// in-flight typert request and the serving route both survive a save). The
// deployment (base) layer keeps its values; user edits ride the volatile
// overlay.
export const Config = z.object({
  route: z.union([DEFAULT_ROUTE, ALT_ROUTE]).default(DEFAULT_ROUTE).volatile(),
  keys: z.array(keyEntry).default([]).volatile(),
  preemptAtPercent: z.number().min(0).max(100).default(100).volatile(),
  // Consecutive non-quota failures (rate limit / server / timeout) after
  // which the pool rotates away from a key; 0 disables the rule.
  switchAfterConsecutiveFailures: z.number().min(0).max(20).default(0).volatile(),
  // Which models the pool route exposes. 'all' follows the official catalog
  // (new models appear automatically); 'custom' exposes exactly `models`.
  modelMode: z.union(['all', 'custom']).default('all').volatile(),
  models: z.array(z.string()).default([]).volatile(),
  usageBaseUrl: z.string().default(DEFAULT_USAGE_BASE_URL).volatile(),
  modelsBaseUrl: z.string().default(DEFAULT_MODELS_BASE_URL).volatile(),
  usageRefreshMs: z.number().min(5000).max(300000).default(DEFAULT_USAGE_REFRESH_MS).volatile(),
  timeoutMs: z.number().min(1000).max(120000).default(DEFAULT_TIMEOUT_MS).volatile(),
})

/**
 * Resolve one `$DSH_HOME` file, migrating it from a pre-rename name on first
 * start. The copy is best-effort: a missing or unreadable legacy file just
 * means there is nothing to carry over.
 *
 * @param {string} name - current file name.
 * @param {string} legacyName - name this file had before the rename.
 * @returns {string} absolute path of the current file.
 */
function migrateHomeFile(name, legacyName) {
  const target = dshHomePath(name)
  try {
    if (existsSync(target)) return target
    const legacy = dshHomePath(legacyName)
    if (!existsSync(legacy)) return target
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(legacy, target)
  } catch {
    // Fall through to the new path: losing the legacy file only costs a
    // re-selection, never a failed request.
  }
  return target
}

// DSH's schemastery wraps each volatile field of the parsed Fiber config in a
// cosmokit Volatile reference ({ get(), [Symbol(cosmokit.volatile.write)] }).
// Live commits update those references in place, so dereferencing at read time
// always yields the current user value — the same helper shape the settings
// service uses as `plainConfig`.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
function toPlain(value) {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) return toPlain(value.get())
  if (Array.isArray(value)) return value.map(toPlain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPlain(child)]))
  }
  return value
}

// Field names unique enough to identify this plugin's own settings row from
// the schema the settings service reports in describe(). Entry identity is
// deliberately not trusted: a Fiber comparison can land on an unrelated core
// entry (dsh-base's `typert-gateway` shares the profile Fiber tree), and the
// settings service then refuses the write with `Plugin entry "typert-gateway"
// has no volatile fields`.
const OWN_SETTINGS_FIELDS = [
  'preemptAtPercent',
  'switchAfterConsecutiveFailures',
  'usageBaseUrl',
  'modelsBaseUrl',
]

/**
 * Build the resolved pi-ai profile for the opencode-go catalog route.
 *
 * The catalog provider is wrapped so that models fetched from the official
 * models endpoint (see refreshModels) are merged into listModels /
 * resolveModel / stream: pi-ai reads `provider.getModels()` on every call, so
 * appending freshly pulled descriptors makes new supplier models usable
 * without a pi-ai package release. Known (shipped) models are never touched.
 */
function buildProfile(route, dynamicDescriptors) {
  const upstream = opencodeGoProvider()
  if (upstream.id !== route) upstream.id = route
  const provider = {
    ...upstream,
    getModels: () => {
      const base = upstream.getModels()
      const extras = dynamicDescriptors(route).filter(descriptor => !base.some(m => m.id === descriptor.id))
      return extras.length > 0 ? [...base, ...extras] : base
    },
  }
  return {
    provider: route,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-opencode-go.catalog.retryPolicy'),
    piProvider: provider,
    configuredMaxTokens: new Map(),
    // Newer llm-pi-ai builds read modelCapabilities in listModels; a catalog
    // route with no configured overrides declares none, so an empty map is
    // the exact contract (capabilityInfo() returns no claims).
    modelCapabilities: new Map(),
    // dsh-llm-pi-ai 0.2's modelOf() reads profile.modelErrors on every
    // resolve: a profile without it crashes with "Cannot read properties of
    // undefined". The catalog route declares no per-model configuration
    // errors, so an empty map is the exact contract — mirroring the field
    // llm-pi-ai's own resolved-profile builder always emits.
    modelErrors: new Map(),
    // Image budgets mirror llm-pi-ai's profile-builder defaults so image
    // inputs pass real bounds into toPiContext's requestImagePolicy.
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
  }
}

/** A terminal error finish stating the whole pool is dry. */
function dryPoolFinish(message) {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE, message } },
  }
}

function isContentChunk(chunk) {
  return chunk.type === 'block-start'
    || chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
    || chunk.type === 'block-end'
}

/** Quota → rotate; credential problems → rotate (invalid mark); everything else keeps the key. */
function isRotationFailure(failure) {
  if (!failure) return false
  const code = failure.code
  return code === QUOTA_EXCEEDED_CODE || code === INVALID_CREDENTIAL_CODE || code === AUTH_CODE
}

function failureOf(error) {
  if (error && typeof error === 'object'
      && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return null
}

/**
 * The pool adapter. Metadata (catalog, retry policy shape, model resolution)
 * delegates to a catalog PiAiAdapter; stream() runs the failover loop.
 */
class OpenCodeGoPoolAdapter extends LlmAdapter {
  constructor(plugin) {
    super()
    this.plugin = plugin
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }

  providerRetryPolicy(_provider) {
    // dsh-llm-retry owns the retry loop and pauses the task once its budget is
    // spent, so the budget has to be wide enough for the pool's rotation rule
    // to fire — otherwise the task fails on a key the pool never switched away
    // from. See harnessRetryBudget().
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: this.plugin.retryBudget(),
      retryableCodes: [...BASE_RETRYABLE_CODES, QUOTA_EXCEEDED_CODE],
      backoff: {
        initialDelayMs: POOL_INITIAL_RETRY_DELAY_MS,
        maxDelayMs: POOL_MAX_RETRY_DELAY_MS,
      },
    }, 'dsh-opencode-go.retryPolicy')
  }

  async listModels(provider) {
    const list = await this.plugin.innerCatalog.listModels(provider)
    const selection = this.plugin.modelSelection()
    if (selection === null) return list
    return list.filter(entry => selection.has(entry.id))
  }

  async resolveModel(provider, model, signal) {
    const selection = this.plugin.modelSelection()
    if (selection !== null && !selection.has(model)) {
      throw new LlmError(
        `model "${model}" is not enabled in the OpenCode Go pool model selection (Settings → OpenCode Go 套餐池 → 模型选择)`,
        'UNKNOWN_MODEL',
      )
    }
    return this.plugin.innerCatalog.resolveModel(provider, model, signal)
  }

  async *stream(options) {
    const selection = this.plugin.modelSelection()
    if (selection !== null && options.model && !selection.has(options.model)) {
      throw new LlmError(
        `model "${options.model}" is not enabled in the OpenCode Go pool model selection (Settings → OpenCode Go 套餐池 → 模型选择)`,
        'UNKNOWN_MODEL',
      )
    }
    const pool = this.plugin.pool
    // One provider attempt, plus one silent follow-up when the pool rotates away
    // from the key that just failed — the "the conversation never notices" case
    // for a single quota/credential rotation.
    //
    // This bound must stay independent of the pool size. The harness retry
    // budget already scales with the pool (keys × threshold), so letting one
    // call sweep every key multiplies the two and grows the real request count
    // with the square of the pool: at threshold 1, ten accounts issued 121
    // requests instead of 22. Keys the pool exhausts beyond the first rotation
    // are reached by the harness retry loop instead.
    const attempts = MAX_ATTEMPTS_PER_REQUEST
    let lastErrorFinish = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = pool.currentKey()
      if (!entry) {
        yield dryPoolFinish('dsh-opencode-go: every key is exhausted, disabled, or invalid — add or revive a key in Settings → OpenCode Go 套餐池')
        return
      }
      const inner = this.plugin.makeAttemptAdapter(entry)
      let emitted = false
      let silentRetry = false
      let finish = null
      try {
        for await (const chunk of inner.stream(options)) {
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error') {
              // quota/auth codes rotate the pool; other codes count the
              // transient-failure streak and rotate once the configured
              // consecutive-failure threshold trips. Either rotation can
              // trigger a silent retry while no content was emitted.
              const rotation = pool.onFailure(entry.id, chunk.reason.failure)
              if (rotation !== null) silentRetry = !emitted
            } else if (chunk.reason.kind !== 'aborted') {
              pool.onSuccess(entry.id)
            }
            finish = chunk
            if (finish.reason.kind === 'error') lastErrorFinish = finish
            break
          }
          if (isContentChunk(chunk)) emitted = true
          yield chunk
        }
      } catch (error) {
        const failure = failureOf(error)
        if (failure) {
          const rotation = pool.onFailure(entry.id, failure)
          if (rotation !== null && !emitted) {
            silentRetry = true
          } else {
            throw error
          }
        } else {
          throw error
        }
      }
      if (silentRetry) continue
      if (finish !== null) {
        yield finish
        return
      }
      // Degenerate inner adapter that ended without a terminal finish.
      return
    }
    // The bound ran out while a rotation-driven silent retry was still pending.
    // Every stream must end in exactly one terminal finish chunk, so surface the
    // last classified failure instead of ending with none.
    yield lastErrorFinish
      ?? dryPoolFinish('dsh-opencode-go: no key completed the request after rotating through the pool')
  }
}

/**
 * The plugin service. Extends TypertRemoteService so the Gateway can claim
 * and dispatch the `opencodePool` invocations declared in typert.host.js.
 */
export class OpenCodeGoPool extends TypertRemoteService {
  static inject = ['llm', 'credentials', 'settings']
  static Config = Config

  constructor(ctx, config) {
    super(ctx, 'opencodePool')
    this.ctx = ctx
    this.logger = ctx.logger ?? console

    // DSH 0.2: the 0.1 ctx.settings.register()/scope seam is gone. The Fiber
    // config (captured here) already carries parsed defaults; volatile fields
    // are live references, so current() dereferences them at call time.
    this.config = config ?? {}
    this.current = () => toPlain(this.config)

    this.pool = new KeyPool({
      stateFile: migrateHomeFile(STATE_FILE, LEGACY_STATE_FILE),
      reviveThresholdPercent: REVIVE_THRESHOLD_PERCENT,
    })
    this.usageCache = new UsageCache({ ttlMs: USAGE_CACHE_TTL_MS })
    // Models pulled from the official models endpoint (id → {id, name}).
    // Loaded from a cache file so a fetched lineup survives restarts.
    this.dynamicModels = new Map(
      loadDynamicModels(migrateHomeFile(MODELS_CACHE_FILE, LEGACY_MODELS_CACHE_FILE))
        .map(entry => [entry.id, entry]),
    )
    // Injectable fetch for refreshModels; undefined = the host fetch.
    this.fetchModelsImpl = undefined

    this.profileRoute = null
    this.profileMap = null
    this.innerCatalog = null
    this.poolAdapter = null
    this.registration = null
    this.servingRoute = null
    this.lastTakeoverError = null
    this.lastModelSelection = null
    this.lastRetryBudget = null

    this.applyConfig()
    // The Loader emits `loader/volatile-update` with an owner filter scoped to
    // this entry's Fiber after every volatile live-commit (our own
    // settings writes and any native settings-form edit alike). It replaces
    // the 0.1 scope.watch hook: re-apply the config without a remount.
    this.offConfigUpdated = ctx.on('loader/volatile-update', () => {
      this.applyConfig()
    })
    this.offAdaptersUpdated = ctx.on('llm/adapters-updated', () => {
      if (this.servingRoute === null) this.tryRegister()
    })
    this.tryRegister()
  }

  // ---- configuration & registration ---------------------------------------

  applyConfig() {
    const cfg = this.current()
    this.pool.setPreempt(cfg.preemptAtPercent)
    this.pool.setConsecutiveThreshold(cfg.switchAfterConsecutiveFailures)
    this.pool.syncKeys(cfg.keys)

    if (this.profileRoute !== cfg.route) {
      this.profileRoute = cfg.route
      this.profileMap = new Map([[cfg.route, buildProfile(cfg.route, route => this.dynamicModelDescriptors(route))]])
      this.innerCatalog = new PiAiAdapter({
        profiles: () => this.profileMap,
        // Newer runtimes resolve a key while listing models, to tell an empty
        // catalog apart from a missing credential. Hand over the active pool
        // key: MISSING_CREDENTIAL is the one code the runtime turns into an
        // empty model list, everything else becomes a catalog load failure.
        // (This used to be an unconditional throw, back when listing never
        // resolved a key at all — that turned "list models" into a hard error.)
        resolveApiKey: async () => {
          const entry = this.pool?.currentKey()
          if (!entry) {
            throw new LlmError(
              'dsh-opencode-go: no usable key to resolve for the model catalog — add or revive a key in Settings → OpenCode Go 套餐池',
              'MISSING_CREDENTIAL',
            )
          }
          return this.resolveKeyValue(entry)
        },
        resolveAttachments: () => this.ctx.get('attachments'),
      })
    }
    if (!this.poolAdapter) this.poolAdapter = new OpenCodeGoPoolAdapter(this)

    const selection = this.modelSelectionKey(cfg)
    const budget = this.retryBudget()
    if (this.servingRoute === cfg.route) {
      // The model selection changed without a route change: re-announce the
      // route so model pickers refresh their catalog from the filtered
      // listModels(). Settings docs that predate the field read as 'all'.
      // The retry policy is captured at registration, so a key-list or
      // threshold edit has to re-announce as well or the harness would keep
      // running with a budget too small for the new rotation rule.
      if ((this.lastModelSelection !== null && this.lastModelSelection !== selection)
          || (this.lastRetryBudget !== null && this.lastRetryBudget !== budget)) {
        this.announceAdapterChange()
      }
      this.lastModelSelection = selection
      this.lastRetryBudget = budget
      return
    }
    this.lastModelSelection = selection
    this.lastRetryBudget = budget
    this.tryRegister()
  }

  /**
   * The retry budget this pool needs from the harness right now. Depends on the
   * live key list and rotation threshold, so it is recomputed on every config
   * commit rather than cached from construction.
   */
  retryBudget() {
    return harnessRetryBudget({
      keyCount: this.pool.keyCount(),
      consecutiveThreshold: this.pool.consecutiveThreshold,
    })
  }

  /** A stable key for the enabled-model selection (null = all models). */
  modelSelectionKey(cfg) {
    return JSON.stringify([cfg.modelMode ?? 'all', [...(cfg.models ?? [])].sort()])
  }

  /**
   * The enabled-model filter: null = the whole catalog, otherwise the Set of
   * explicitly selected ids. Tolerates undefined fields from pre-feature
   * settings documents.
   */
  modelSelection() {
    const cfg = this.current()
    if (cfg.modelMode !== 'custom' || !Array.isArray(cfg.models) || cfg.models.length === 0) return null
    return new Set(cfg.models)
  }

  /** Re-announce the current route so adapters-updated listeners refresh catalogs. */
  announceAdapterChange() {
    if (this.registration === null || this.servingRoute === null) return
    try {
      this.registration.replace([this.servingRoute])
    } catch (error) {
      this.logger?.warn?.(`[dsh-opencode-go] catalog re-announce failed: ${String((error && error.message) || error)}`)
    }
  }

  /**
   * Register (or atomically re-route) the pool adapter. A conflicting route
   * leaves the previous registration serving and records the refusal; the
   * `llm/adapters-updated` subscription retries after every topology commit,
   * so removing the opencode-go row under Settings → Models hands the route
   * to this plugin automatically.
   */
  tryRegister() {
    const route = this.current().route
    if (this.servingRoute === route) return
    try {
      if (this.registration === null) {
        this.registration = this.ctx.llm.registerAdapter([route], this.poolAdapter)
      } else {
        this.registration.replace([route])
      }
      this.servingRoute = route
      this.lastTakeoverError = null
      this.logger?.info?.(`[dsh-opencode-go] serving provider route "${route}"`)
    } catch (error) {
      this.lastTakeoverError = String((error && error.message) || error)
      this.logger?.warn?.(`[dsh-opencode-go] route "${route}" unavailable: ${this.lastTakeoverError}; waiting for the owning plugin to release it`)
    }
  }

  takeoverState() {
    if (this.servingRoute === DEFAULT_ROUTE) return 'serving'
    if (this.servingRoute === ALT_ROUTE) return 'own-route'
    return 'waiting'
  }

  // ---- credentials & adapters ----------------------------------------------

  /** Per-attempt adapter bound to one key: no cross-attempt key races. */
  makeAttemptAdapter(entry) {
    return new PiAiAdapter({
      profiles: () => this.profileMap,
      resolveApiKey: () => this.resolveKeyValue(entry),
      resolveAttachments: () => this.ctx.get('attachments'),
    })
  }

  /** Resolve one key's credential reference through the credentials seam. */
  async resolveKeyValue(entry) {
    const credentials = this.ctx.get('credentials')
    const ref = credentialRef(entry.apiKeyEnv)
    let hit
    if (credentials) {
      try {
        hit = (await credentials.resolve(ref))?.value
      } catch {
        hit = undefined
      }
    }
    if (!hit || hit.length === 0) {
      throw new LlmError(
        `dsh-opencode-go: no credential for key "${entry.id}" (${entry.apiKeyEnv}) — store it through the credentials service (the web Models page writes it) or export it`,
        'MISSING_CREDENTIAL',
      )
    }
    return assertUsableApiKey(hit, 'dsh-opencode-go', ref)
  }

  // ---- Typert Remote surface (the card) -------------------------------------

  /** The card-facing model selector data: catalog entries plus enabled flags. */
  async listAvailableModels(cfg) {
    const route = this.profileRoute ?? cfg.route
    let catalog = []
    try {
      if (this.innerCatalog) catalog = await this.innerCatalog.listModels(route)
    } catch {
      catalog = []
    }
    const selection = cfg.modelMode === 'custom' && Array.isArray(cfg.models) ? new Set(cfg.models) : null
    return catalog.map(entry => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      enabled: selection === null || selection.has(entry.id),
      dynamic: this.dynamicModels.has(entry.id),
    }))
  }

  /**
   * Synthesized pi-ai descriptors for the fetched models not present in the
   * shipped catalog. The wrapper provider appends these to getModels().
   */
  dynamicModelDescriptors(route) {
    return Array.from(this.dynamicModels.values(), ({ id, name }) => dynamicModelDescriptor(id, name, route))
  }

  /** The static (shipped) catalog ids, for detecting newly-fetched models. */
  staticModelIds() {
    try {
      return new Set(opencodeGoProvider().getModels().map(model => model.id))
    } catch {
      return new Set()
    }
  }

  /** Persist the fetched-model cache (best-effort). */
  persistDynamicModels() {
    saveDynamicModels(dshHomePath(MODELS_CACHE_FILE), Array.from(this.dynamicModels.values()))
  }

  /**
   * Pull the latest model lineup from the official models endpoint and merge
   * it into the catalog. Newly-added models become selectable immediately
   * (routed with a best-effort default protocol). Returns a summary the card
   * renders: total fetched, the full list, and the ids that were new.
   */
  async refreshModels() {
    const cfg = this.current()
    const baseUrl = cfg.modelsBaseUrl || DEFAULT_MODELS_BASE_URL
    // The endpoint is public, but pass the active key's credential when one is
    // resolvable (account-specific lineups); a missing key must not block.
    let apiKey
    try {
      const entry = this.pool.currentKey()
      if (entry) apiKey = await this.resolveKeyValue(entry)
    } catch {
      apiKey = undefined
    }
    const fetched = await fetchModels({
      baseUrl,
      apiKey,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: this.fetchModelsImpl,
    })
    const known = this.staticModelIds()
    const before = new Set(this.dynamicModels.keys())
    const added = []
    for (const model of fetched) {
      if (!known.has(model.id) && !before.has(model.id)) added.push(model.id)
      this.dynamicModels.set(model.id, { id: model.id, name: model.name || model.id })
    }
    this.persistDynamicModels()
    // Refresh any model picker that cached the catalog from listModels().
    this.announceAdapterChange()
    return {
      count: fetched.length,
      models: fetched.map(model => ({ id: model.id, name: model.name || model.id })),
      added,
      fetchedAt: new Date().toISOString(),
    }
  }

  async status() {
    const cfg = this.current()
    const fetchedAt = new Date().toISOString()
    const entries = this.pool.entries()
    const availableModels = await this.listAvailableModels(cfg)
    const usageResults = await Promise.all(entries.map(async entry => {
      try {
        const key = await this.resolveKeyValue(entry)
        const usage = await this.usageCache.get(entry.id, () => fetchUsage({
          baseUrl: cfg.usageBaseUrl,
          apiKey: key,
          timeoutMs: cfg.timeoutMs,
        }))
        this.pool.onUsage(entry.id, usage)
        return { id: entry.id, usage, usageError: null, fetchedAt, credentialSet: true }
      } catch (error) {
        const code = error && error.code ? error.code : 'network'
        return {
          id: entry.id,
          usage: null,
          usageError: code === 'MISSING_CREDENTIAL' ? 'no-api-key' : code,
          fetchedAt: null,
          credentialSet: code !== 'MISSING_CREDENTIAL',
        }
      }
    }))
    return {
      takeover: this.takeoverState(),
      route: this.servingRoute ?? cfg.route,
      usageRefreshMs: cfg.usageRefreshMs,
      preemptAtPercent: cfg.preemptAtPercent,
      switchAfterConsecutiveFailures: cfg.switchAfterConsecutiveFailures,
      modelMode: cfg.modelMode ?? 'all',
      availableModels,
      activeId: this.pool.activeId,
      lastSwitch: this.pool.lastSwitch,
      takeoverHint: this.servingRoute ? null : this.lastTakeoverError,
      keys: entries.map(entry => {
        const st = this.pool.stateOf(entry.id)
        const result = usageResults.find(item => item.id === entry.id)
        return {
          id: entry.id,
          label: entry.label,
          apiKeyEnv: entry.apiKeyEnv,
          state: st.state,
          active: entry.id === this.pool.activeId,
          usage: (result && result.usage) ?? null,
          usageError: (result && result.usageError) ?? null,
          fetchedAt: (result && result.fetchedAt) ?? null,
          credentialSet: (result && result.credentialSet) ?? false,
          lastFailure: st.lastFailure ?? null,
        }
      }),
    }
  }

  async setActive(id) {
    this.pool.setActive(id)
    return true
  }

  async setDisabled(id, on) {
    this.pool.setDisabled(id, on)
    return true
  }

  async clearInvalid(id) {
    this.pool.clearInvalid(id)
    return true
  }

  async putKeys(keys) {
    assertKeyList(keys)
    await this.updateSettings({ keys })
    return true
  }

  /**
   * Store one key's literal secret through the credentials seam under its
   * configured reference name. The secret never enters settings, logs, or
   * any response — the same carrier and trust domain the Models page uses
   * when it writes credentials.
   */
  async putKeySecret(id, secret) {
    const entry = this.pool.entries().find(item => item.id === id)
    if (!entry) throw new Error(`unknown key "${id}"`)
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      throw new Error(`key "${id}" needs a non-empty secret`)
    }
    const credentials = this.ctx.get('credentials')
    if (!credentials || typeof credentials.set !== 'function') {
      throw new Error('no credentials service is mounted — set the key through the credentials page instead')
    }
    const ref = credentialRef(entry.apiKeyEnv)
    const usable = assertUsableApiKey(secret.trim(), 'dsh-opencode-go', ref)
    await credentials.set(ref, usable)
    // A freshly supplied secret may repair an invalid-marked key.
    this.pool.clearInvalid(id)
    this.usageCache.invalidate(id)
    return true
  }

  /** Update the card-visible pool settings (thresholds only, never keys). */
  async putConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('putConfig needs an object')
    const patch = {}
    if (config.preemptAtPercent !== undefined) {
      const value = Number(config.preemptAtPercent)
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('preemptAtPercent must be 0..100')
      patch.preemptAtPercent = value
    }
    if (config.switchAfterConsecutiveFailures !== undefined) {
      const value = Number(config.switchAfterConsecutiveFailures)
      if (!Number.isFinite(value) || value < 0 || value > 20) throw new Error('switchAfterConsecutiveFailures must be 0..20')
      patch.switchAfterConsecutiveFailures = value
    }
    if (config.modelMode !== undefined) {
      if (config.modelMode !== 'all' && config.modelMode !== 'custom') throw new Error('modelMode must be "all" or "custom"')
      patch.modelMode = config.modelMode
    }
    if (config.models !== undefined) {
      if (!Array.isArray(config.models) || config.models.some(id => typeof id !== 'string' || id.trim().length === 0)) {
        throw new Error('models must be an array of non-empty model ids')
      }
      patch.models = [...new Set(config.models.map(id => id.trim()))]
    }
    if (Object.keys(patch).length === 0) throw new Error('putConfig received no known fields')
    const effective = { ...this.current(), ...patch }
    if (effective.modelMode === 'custom' && (!Array.isArray(effective.models) || effective.models.length === 0)) {
      throw new Error('custom model selection needs at least one model — pick models or use modelMode "all"')
    }
    await this.updateSettings(patch)
    return true
  }

  /**
   * The Loader row id for this entry (also the settings namespace), used only
   * as a hint: the Fiber comparison is guarded against an undefined Fiber on
   * both sides, which would otherwise match an unloaded entry (a plain
   * `entry.fiber === this.ctx.fiber` picks dsh-base's `typert-gateway`).
   */
  ownSettingsId() {
    try {
      const ownFiber = this.ctx.fiber
      let fallback
      for (const entry of this.ctx.loader.entries()) {
        const id = entry.options.id
        if (typeof id !== 'string' || id === '') continue
        if (ownFiber !== undefined && entry.fiber === ownFiber) return id
        if (entry.options.name === 'dsh-opencode-go' && entry.disabled !== true && fallback === undefined) {
          fallback = id
        }
      }
      return fallback
    } catch {
      return undefined
    }
  }

  /**
   * This plugin's own settings row, identified by the volatile schema the
   * service reports rather than by entry id. Returns undefined when no
   * configurable row carries this plugin's fields.
   */
  settingsRow() {
    const rows = this.ctx.settings.describe({ redactSecrets: true })
    const isOwnRow = (row) => {
      const schema = JSON.stringify(row?.schema ?? {})
      return OWN_SETTINGS_FIELDS.every(field => schema.includes(`"${field}"`))
    }
    const hinted = rows.find(row => row.ns === this.ownSettingsId())
    if (hinted !== undefined && isOwnRow(hinted)) return hinted
    return rows.find(isOwnRow)
  }

  /**
   * Persist a Config patch through the DSH 0.2 settings service (partial
   * merge, revision-fenced). Every Config field is volatile, so the write
   * takes the live-commit path and the `loader/volatile-update` subscription
   * above re-applies it.
   */
  async updateSettings(patch) {
    const row = this.settingsRow()
    if (row === undefined) {
      throw new Error('dsh-opencode-go: no settings row for this plugin — cannot persist config')
    }
    await this.ctx.settings.update(row.ns, patch, row.revision)
  }

  async takeOverState() {
    return this.takeoverState()
  }
}

export default OpenCodeGoPool
