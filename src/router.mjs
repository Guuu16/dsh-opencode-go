/**
 * Router: model resolution, provider/key failover, catalogs, counters.
 *
 * Resolution order for a client-supplied model id:
 *   1. `auto`                → routing.defaultModel, or the highest-priority
 *                              provider's first catalog model
 *   2. `provider/model`      → that exact pair (unknown model ids pass through,
 *                              so a brand-new upstream model works immediately)
 *   3. alias name            → ordered list of `provider/model` fallbacks
 *   3. bare model id         → every provider that lists that model, in
 *                              priority order (this is cross-provider failover)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KeyPool, classifyFailure } from './pool.mjs'
import { buildUpstreamRequest, joinUrl, looksLikeErrorEvent } from './protocol.mjs'
import {
  GatewayError,
  aipoolHome,
  log,
  nowISO,
  readJSON,
  sha256,
  sleep,
  writeJSON,
} from './util.mjs'

const CATALOG_TTL_MS = 10 * 60_000
const MODEL_MISS_TTL_MS = 5 * 60_000
const RECENT_LIMIT = 50

function catalogFile() {
  return join(aipoolHome(), 'catalog.json')
}

function stateFile() {
  return join(aipoolHome(), 'state.json')
}

function readCatalogCache() {
  try {
    const raw = JSON.parse(readFileSync(catalogFile(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeCatalogCache(cache) {
  try {
    const path = catalogFile()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, path)
  } catch {
    // Cache is an optimization; a failed write only costs one re-fetch.
  }
}

/** Read at most `limit` bytes of an error body; never buffer a huge page. */
async function readErrorBody(response, limit = 8192) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    return text.slice(0, limit)
  } finally {
    await reader.cancel().catch(() => {})
  }
  return text.slice(0, limit)
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Honouring it keeps a
 * throttled key out of rotation exactly as long as the provider asked.
 */
function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.trim() === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600_000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 600_000))
  return 0
}

function parseMaybeJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export class Router {
  /**
   * @param {object} options
   * @param {object} options.config - normalized config
   * @param {(event: object) => void} [options.onEvent] - observability hook
   */
  constructor({ config, onEvent, restoreState = true }) {
    this.config = config
    this.onEvent = onEvent ?? (() => {})
    this.pools = new Map()
    this.catalog = new Map()
    this.modelMisses = new Map()
    this.startedAt = Date.now()
    this.counters = {
      requests: 0,
      ok: 0,
      failed: 0,
      retries: 0,
      activeStreams: 0,
      tokensIn: 0,
      tokensOut: 0,
    }
    this.recent = []
    this.catalogFetchedAt = 0
    this.catalogInflight = null
    this.lastSavedDigest = null
    this.buildPools()
    if (restoreState) this.restoreState()
    this.hydrateCatalog(readCatalogCache())
  }

  buildPools() {
    const seen = new Set()
    for (const provider of this.config.providers) {
      seen.add(provider.id)
      const existing = this.pools.get(provider.id)
      if (existing) {
        existing.setKeys(provider.keys)
        existing.setCooldowns(this.config.cooldown)
        existing.setPreemptAtPercent(provider.preemptAtPercent)
      } else {
        this.pools.set(provider.id, new KeyPool({
          providerId: provider.id,
          keys: provider.keys,
          cooldowns: this.config.cooldown,
          preemptAtPercent: provider.preemptAtPercent,
        }))
      }
    }
    for (const id of [...this.pools.keys()]) {
      if (!seen.has(id)) this.pools.delete(id)
    }
  }

  /** Apply a hot-reloaded config without dropping live counters. */
  updateConfig(config) {
    this.config = config
    this.buildPools()
  }

  pool(providerId) {
    return this.pools.get(providerId) ?? null
  }

  provider(providerId) {
    return this.config.providers.find(item => item.id === providerId) ?? null
  }

  // ---- catalog -------------------------------------------------------------

  hydrateCatalog(cache) {
    for (const provider of this.config.providers) {
      const staticModels = provider.models.map(model => ({ id: model.id, name: model.name ?? model.id }))
      const cached = Array.isArray(cache[provider.id]) ? cache[provider.id] : []
      const merged = new Map()
      for (const model of [...cached, ...staticModels]) {
        if (model && typeof model.id === 'string' && model.id) merged.set(model.id, { id: model.id, name: model.name ?? model.id })
      }
      this.catalog.set(provider.id, [...merged.values()])
    }
  }

  catalogFor(providerId) {
    return this.catalog.get(providerId) ?? []
  }

  /**
   * Pull `/models` from every provider that advertises one. Best-effort:
   * failures leave the previous catalog in place.
   */
  /**
   * Pull `/models` from every provider that advertises one.
   *
   * - A key is used when the pool has one, but its absence is not fatal: many
   *   `/models` endpoints (OpenCode Go, OpenRouter) are public, and hiding the
   *   catalog before the first key is added makes the tool look empty.
   * - Concurrent callers share one sweep, so `/v1/models` right after boot does
   *   not race the startup fetch and return an empty list.
   */
  async refreshCatalog({ force = false, timeoutMs = 15_000 } = {}) {
    const now = Date.now()
    if (!force && this.catalogInflight) return this.catalogInflight
    if (!force && now - this.catalogFetchedAt < CATALOG_TTL_MS) return
    this.catalogInflight = this.sweepCatalog({ timeoutMs, now })
    try {
      return await this.catalogInflight
    } finally {
      this.catalogInflight = null
    }
  }

  async sweepCatalog({ timeoutMs = 15_000, now = Date.now() } = {}) {
    const cache = readCatalogCache()
    let succeeded = 0
    await Promise.all(this.config.providers.map(async provider => {
      if (!provider.enabled) return
      const url = provider.modelsUrl ?? (provider.modelsPath ? joinUrl(provider.baseUrl, provider.modelsPath) : null)
      if (!url) return
      const key = this.pool(provider.id)?.pick()
      const headers = { accept: 'application/json' }
      if (key) {
        if (provider.authHeader === 'bearer') headers.authorization = `Bearer ${key.key}`
        else if (provider.authHeader === 'x-api-key') headers['x-api-key'] = key.key
        else {
          headers.authorization = `Bearer ${key.key}`
          headers['x-api-key'] = key.key
        }
      }
      if (provider.type === 'anthropic') headers['anthropic-version'] = provider.anthropicVersion
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return
        const body = await response.json()
        const raw = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
        const models = []
        for (const item of raw) {
          if (typeof item === 'string') models.push({ id: item, name: item })
          else if (item && typeof item === 'object' && typeof item.id === 'string' && item.id) {
            models.push({ id: item.id, name: typeof item.display_name === 'string' ? item.display_name : typeof item.name === 'string' ? item.name : item.id })
          }
        }
        if (models.length === 0) return
        const staticModels = provider.models.map(model => ({ id: model.id, name: model.name ?? model.id }))
        const merged = new Map()
        for (const model of [...models, ...staticModels]) merged.set(model.id, model)
        this.catalog.set(provider.id, [...merged.values()])
        cache[provider.id] = [...merged.values()]
        succeeded += 1
        log('info', `catalog: ${provider.id} → ${models.length} models`)
      } catch (error) {
        log('debug', `catalog fetch failed for ${provider.id}: ${error.message}`)
      }
    }))
    // A total failure retries within a minute instead of waiting the full TTL,
    // so fixing a URL in the config takes effect quickly.
    this.catalogFetchedAt = succeeded > 0 ? now : now - CATALOG_TTL_MS + 60_000
    writeCatalogCache(cache)
    return { providers: Object.fromEntries([...this.catalog].map(([id, models]) => [id, models.length])) }
  }

  // ---- model resolution ----------------------------------------------------

  /** @returns {Array<{provider: object, modelId: string}>} ordered candidates. */
  resolveTargets(rawModel) {
    const requested = typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim() : null
    const model = requested ?? this.config.routing.defaultModel

    if (model === 'auto') {
      const aliasTargets = (this.config.aliases.auto ?? []).flatMap(entry => this.targetFromString(entry))
      if (aliasTargets.length > 0) return aliasTargets
      const autoTargets = []
      for (const provider of this.config.providers) {
        if (!provider.enabled) continue
        if (this.pool(provider.id)?.candidates().length === 0) continue
        const first = this.catalogFor(provider.id)[0]
        if (first) autoTargets.push({ provider, modelId: first.id })
      }
      if (autoTargets.length > 0) return autoTargets
      throw new GatewayError('没有可用的 provider/key：先在 dashboard 或 `aipool key add` 里加一个', {
        status: 503,
        code: 'NO_PROVIDER',
        type: 'service_unavailable',
      })
    }

    const slash = model.indexOf('/')
    if (slash > 0) {
      const providerId = model.slice(0, slash)
      const modelId = model.slice(slash + 1)
      const provider = this.provider(providerId)
      if (!provider) {
        throw new GatewayError(`未知 provider "${providerId}"（已知：${this.config.providers.map(item => item.id).join(', ')}）`, {
          status: 404,
          code: 'PROVIDER_NOT_FOUND',
          type: 'invalid_request_error',
        })
      }
      return [{ provider, modelId }]
    }

    const aliased = this.config.aliases[model]
    if (aliased && aliased.length > 0) {
      const targets = aliased.flatMap(entry => this.targetFromString(entry))
      if (targets.length > 0) return targets
    }

    const targets = []
    for (const provider of this.config.providers) {
      if (!provider.enabled) continue
      if (this.catalogFor(provider.id).some(item => item.id === model)) targets.push({ provider, modelId: model })
    }
    if (targets.length > 0) return targets

    throw new GatewayError(
      `模型 "${model}" 不在任何 provider 的目录里。用 \`GET /v1/models\` 看可用列表，或写成 "provider/model" 直接透传给某个 provider。`,
      { status: 404, code: 'MODEL_NOT_FOUND', type: 'invalid_request_error' },
    )
  }

  targetFromString(entry) {
    const slash = String(entry).indexOf('/')
    if (slash <= 0) return []
    const provider = this.provider(String(entry).slice(0, slash))
    if (!provider || !provider.enabled) return []
    return [{ provider, modelId: String(entry).slice(slash + 1) }]
  }

  /** Next (provider, key) to try, skipping pairs already attempted. */
  nextCandidate(targets, tried) {
    for (const target of targets) {
      const provider = target.provider
      if (!provider.enabled) continue
      const pool = this.pool(provider.id)
      if (!pool) continue
      const missKey = `${provider.id}\u0000${target.modelId}`
      const miss = this.modelMisses.get(missKey)
      if (miss && miss > Date.now()) continue
      const key = pool.pick(new Set(
        [...tried]
          .filter(entry => entry.startsWith(`${provider.id}\u0000`))
          .map(entry => entry.slice(provider.id.length + 1)),
      ))
      if (key) return { provider, modelId: target.modelId, key }
    }
    return null
  }

  // ---- request execution ---------------------------------------------------

  /**
   * Open one upstream response, rotating providers/keys on retryable failures.
   * Returns as soon as a 2xx (and, for streams, a first non-error event) is in
   * hand; the caller owns the body from there.
   */
  async open({ canonical, stream = false, clientSignal }) {
    const startedAt = Date.now()
    const targets = this.resolveTargets(canonical.model)
    const tried = new Set()
    const attempts = []
    const maxAttempts = Math.max(1, Math.min(this.config.routing.maxAttempts, 10))
    const delays = this.config.routing.retryDelaysMs
    const decoder = new TextDecoder()
    let lastFailure = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = this.nextCandidate(targets, tried)
      if (!candidate) break
      const { provider, modelId, key } = candidate
      tried.add(`${provider.id}\u0000${key.id}`)
      const pool = this.pool(provider.id)
      pool.onAttempt(key.id)
      if (attempt > 0) this.counters.retries += 1

      const controller = new AbortController()
      const onClientAbort = () => controller.abort()
      // Kept alive on the success path: the caller owns the response body, and
      // a client disconnect or the overall request timeout must still be able
      // to stop the upstream stream.
      clientSignal?.addEventListener?.('abort', onClientAbort, { once: true })
      const attemptStart = Date.now()
      let timedOut = false
      let failure = null
      let response = null
      let peeked = null

      try {
        const headerTimer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, provider.timeoutMs)
        try {
          const request = buildUpstreamRequest({
            provider,
            apiKey: key.key,
            modelId,
            canonical: { ...canonical, model: modelId, stream },
            signal: controller.signal,
          })
          response = await fetch(request.url, request.init)
        } finally {
          clearTimeout(headerTimer)
        }

        if (!response.ok) {
          const raw = await readErrorBody(response)
          const classified = classifyFailure({
            status: response.status,
            body: parseMaybeJSON(raw),
            cooldowns: this.config.cooldown,
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          })
          failure = { ...classified, status: response.status }
          if (classified.kind === 'model') {
            this.modelMisses.set(`${provider.id}\u0000${modelId}`, Date.now() + MODEL_MISS_TTL_MS)
          }
        } else if (stream) {
          // A 200 is not a success yet: peek the first SSE chunk so a provider
          // that answers 200 and then an error event still rotates inside the
          // same attempt budget instead of leaking a half-broken stream.
          const reader = response.body.getReader()
          const first = await reader.read()
          const text = first.done ? '' : decoder.decode(first.value, { stream: true })
          const upstreamError = looksLikeErrorEvent(text)
          if (upstreamError) {
            await reader.cancel().catch(() => {})
            failure = {
              kind: 'transport',
              code: 'STREAM_ERROR',
              retryable: true,
              rotateKey: true,
              cooldownMs: this.config.cooldown.transportMs,
              message: upstreamError.message,
              status: 200,
            }
          } else {
            peeked = { reader, first, firstText: text }
          }
        }
      } catch (error) {
        clientSignal?.removeEventListener?.('abort', onClientAbort)
        if (error instanceof GatewayError) {
          controller.abort()
          throw error
        }
        if (clientSignal?.aborted) {
          controller.abort()
          throw new GatewayError('客户端已断开', { status: 499, code: 'CLIENT_CLOSED_REQUEST', type: 'api_error' })
        }
        const code = timedOut ? 'TIMEOUT' : (error?.code ?? error?.name ?? 'TRANSPORT')
        failure = { ...classifyFailure({ status: 0, code, cooldowns: this.config.cooldown }), status: 0 }
      }

      if (failure === null) {
        return {
          response,
          provider,
          key,
          modelId,
          requestedModel: canonical.model ?? this.config.routing.defaultModel,
          dialect: provider.type,
          attempts,
          startedAt,
          attemptStartedAt: attemptStart,
          reader: peeked?.reader ?? null,
          first: peeked?.first ?? null,
          firstText: peeked?.firstText ?? '',
          releaseAbort: () => clientSignal?.removeEventListener?.('abort', onClientAbort),
          abort: () => controller.abort(),
        }
      }

      // Failure: drop the listener (the next attempt installs its own), make
      // sure the socket is released, and count the attempt.
      clientSignal?.removeEventListener?.('abort', onClientAbort)
      controller.abort()
      pool.onFailure(key.id, failure)
      lastFailure = { ...failure, provider: provider.id, key: key.id }
      attempts.push({
        provider: provider.id,
        key: key.id,
        status: failure.status ?? 0,
        code: failure.code,
        kind: failure.kind,
        ms: Date.now() - attemptStart,
      })
      log('warn', `attempt ${attempt + 1}: ${provider.id}/${key.id} → ${failure.status ? `HTTP ${failure.status}` : failure.code} (${failure.kind})`)

      if (!failure.retryable) {
        throw this.failureToError(failure, { provider, key, status: failure.status ?? null, attempts })
      }

      // Back off before the next attempt — for HTTP failures as well as
      // transport ones, otherwise a 429 turns into an instant key sweep.
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
      if (delay > 0) await sleep(delay, clientSignal)
      if (clientSignal?.aborted) {
        throw new GatewayError('客户端已断开', { status: 499, code: 'CLIENT_CLOSED_REQUEST', type: 'api_error' })
      }
    }

    if (lastFailure) throw this.failureToError(lastFailure, { attempts })

    const hint = this.cooldownHint()
    if (hint.keys > 0 && hint.cooldownMs > 0) {
      throw new GatewayError(
        `所有 Key 都在冷却中，最快 ${Math.ceil(hint.cooldownMs / 1000)} 秒后恢复`,
        {
          status: 429,
          code: 'ALL_KEYS_COOLING',
          type: 'rate_limit_error',
          detail: { retryAfterMs: hint.cooldownMs, attempts },
        },
      )
    }
    throw new GatewayError('没有可用的 key 完成这次请求', {
      status: 503,
      code: 'NO_USABLE_KEY',
      type: 'service_unavailable',
      detail: { attempts },
    })
  }

  /** Shortest remaining cooldown across every configured key, for Retry-After. */
  cooldownHint() {
    const now = Date.now()
    let keys = 0
    let cooldownMs = 0
    for (const provider of this.config.providers) {
      const pool = this.pool(provider.id)
      if (!pool) continue
      for (const entry of pool.entries) {
        keys += 1
        const state = pool.stateOf(entry.id)
        if (!state) continue
        const remaining = state.cooldownUntil > now ? state.cooldownUntil - now : 0
        if (remaining > 0 && (cooldownMs === 0 || remaining < cooldownMs)) cooldownMs = remaining
      }
    }
    return { keys, cooldownMs }
  }

  failureToError(failure, { provider = null, key = null, status = null, attempts = [] } = {}) {
    const where = provider && key ? `${provider.id}/${key.id}` : 'pool'
    const code = failure.code || 'UPSTREAM_ERROR'
    const mapping = {
      auth: [502, 'authentication_error'],
      quota: [429, 'rate_limit_error'],
      rateLimit: [429, 'rate_limit_error'],
      server: [502, 'api_error'],
      transport: [502, 'api_error'],
      model: [404, 'invalid_request_error'],
      request: [status && status >= 400 && status < 500 ? status : 400, 'invalid_request_error'],
    }
    const [httpStatus, type] = mapping[failure.kind] ?? [502, 'api_error']
    return new GatewayError(
      `上游 ${where} 失败：${failure.message}`,
      {
        status: httpStatus,
        code,
        type,
        detail: { kind: failure.kind, attempts },
      },
    )
  }

  // ---- outcome accounting --------------------------------------------------

  finish({ candidate, usage = null, error = null, startedAt, streamed = false }) {
    const ms = Date.now() - startedAt
    const pool = this.pool(candidate.provider.id)
    if (error) {
      pool?.onFailure(candidate.key.id, {
        kind: 'transport',
        code: 'STREAM_ERROR',
        rotateKey: true,
        cooldownMs: this.config.cooldown.transportMs,
        message: error.message ?? String(error),
      })
      this.counters.failed += 1
    } else {
      pool?.onSuccess(candidate.key.id, {
        latencyMs: ms,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
      })
      this.counters.ok += 1
      this.counters.tokensIn += usage?.prompt_tokens ?? 0
      this.counters.tokensOut += usage?.completion_tokens ?? 0
    }
    this.record({
      at: nowISO(),
      model: `${candidate.provider.id}/${candidate.modelId}`,
      requested: candidate.requestedModel,
      status: error ? 'error' : 'ok',
      ms,
      attempts: candidate.attempts.length + 1,
      route: `${candidate.provider.id}/${candidate.key.id}`,
      error: error ? (error.code ?? error.name ?? 'ERROR') : null,
      streamed,
    })
  }

  record(entry) {
    this.recent.unshift(entry)
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT
  }

  beginRequest() {
    this.counters.requests += 1
  }

  // ---- durability ----------------------------------------------------------

  /** Restore cooldowns/counters so a crash-loop cannot hammer a dead key. */
  restoreState() {
    const raw = readJSON(stateFile(), null)
    if (!raw || typeof raw !== 'object' || !raw.providers) return
    for (const [providerId, records] of Object.entries(raw.providers)) {
      this.pool(providerId)?.importState(records)
    }
  }

  /**
   * Persist pool state (cooldowns, counters, fresh quota facts). The digest
   * check keeps an idle daemon from rewriting the same bytes every 5 seconds.
   */
  saveState() {
    try {
      const providers = {}
      for (const [providerId, pool] of this.pools.entries()) providers[providerId] = pool.exportState()
      const digest = sha256(JSON.stringify(providers))
      if (digest === this.lastSavedDigest) return false
      writeJSON(stateFile(), { version: 1, savedAt: nowISO(), providers })
      this.lastSavedDigest = digest
      return true
    } catch {
      // Best-effort: losing counters costs a warm-up, never a request.
      return false
    }
  }

  // ---- dashboard snapshot --------------------------------------------------

  snapshot() {
    return {
      version: this.versionString,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
      providers: this.config.providers.map(provider => {
        const keys = this.pool(provider.id)?.snapshot() ?? []
        return {
          id: provider.id,
          name: provider.name,
          type: provider.type,
          priority: provider.priority,
          enabled: provider.enabled,
          healthy: provider.enabled && keys.some(key => key.state === 'healthy'),
          models: this.catalogFor(provider.id).map(model => model.id),
          keys,
        }
      }),
      tokens: this.config.auth.tokens.map(token => ({
        id: token.id,
        name: token.name,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        requests: token.requests,
        disabled: token.disabled,
      })),
      recent: this.recent,
      config: {
        host: this.config.server.host,
        port: this.config.server.port,
        defaultModel: this.config.routing.defaultModel,
        maxAttempts: this.config.routing.maxAttempts,
      },
    }
  }
}

// ---- usage probe -----------------------------------------------------------

/**
 * Poll each provider's usage endpoint and feed quota facts into the pool.
 * The endpoint is what revives an exhausted key, never a timer guess.
 */
export class UsagePoller {
  constructor({ router, intervalMs = 60_000 }) {
    this.router = router
    this.intervalMs = intervalMs
    this.timer = null
    this.inflight = null
    this.lastRunAt = 0
    this.lastProbeAt = new Map()
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.run() }, this.intervalMs)
    this.timer.unref?.()
    void this.run()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async run({ force = false } = {}) {
    // A concurrent caller (forced refresh from the dashboard, or the timer
    // firing during startup) joins the in-flight sweep instead of starting a
    // second one — and instead of returning a lie that it already ran.
    if (this.inflight) return this.inflight
    const now = Date.now()
    if (!force && now - this.lastRunAt < Math.min(this.intervalMs, 20_000)) return
    this.lastRunAt = now
    this.inflight = this.sweep({ force, now })
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  async sweep({ force = false, now = Date.now() } = {}) {
    try {
      for (const provider of this.router.config.providers) {
        if (!provider.enabled || !provider.usageUrl) continue
        // Honour each provider's own cadence instead of one global interval.
        const last = this.lastProbeAt.get(provider.id) ?? 0
        if (!force && now - last < provider.usageRefreshMs) continue
        this.lastProbeAt.set(provider.id, now)
        const pool = this.router.pool(provider.id)
        if (!pool) continue
        for (const entry of pool.entries) {
          try {
            const headers = { accept: 'application/json' }
            if (provider.authHeader === 'bearer') headers.authorization = `Bearer ${entry.key}`
            else if (provider.authHeader === 'x-api-key') headers['x-api-key'] = entry.key
            else {
              headers.authorization = `Bearer ${entry.key}`
              headers['x-api-key'] = entry.key
            }
            const response = await fetch(provider.usageUrl, { headers, signal: AbortSignal.timeout(15_000) })
            if (!response.ok) continue
            const body = await response.json()
            const usage = body && typeof body === 'object' && body.usage ? body.usage : body
            pool.applyUsage(entry.id, {
              rolling: pickWindow(usage?.rolling),
              weekly: pickWindow(usage?.weekly),
              monthly: pickWindow(usage?.monthly),
            })
          } catch {
            // Ignore: quota probing must never affect request traffic.
          }
        }
      }
    } catch {
      // A sweep must never throw into the server loop.
    }
  }
}

function pickWindow(value) {
  if (!value || typeof value !== 'object') return null
  const percent = typeof value.percent === 'number' ? value.percent : Number(value.percent)
  return {
    status: typeof value.status === 'string' ? value.status : null,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
  }
}
