/**
 * Key pool: per-provider key lifecycle, cooldowns, quota awareness, counters.
 *
 * One instance per provider. Unlike the DSH plugin version this pool is
 * request-driven: the gateway asks for the next eligible key, reports the
 * outcome, and the pool decides how long a sick key stays out of rotation.
 *
 * Failure classes and their meaning:
 *   auth      401/403            → the key itself is wrong  → long cooldown
 *   quota     402/429-quota-text → the account is out       → medium cooldown
 *   rateLimit 429                 → momentary throttle       → short cooldown
 *   server    5xx                 → upstream is sick         → short cooldown
 *   transport ECONNRESET/DNS/TLS  → network blip             → short cooldown
 *   model     404-model-text      → model unknown there      → no key penalty
 *   request   400/413/422         → the caller's body is bad → no retry at all
 */

import { maskSecret } from './util.mjs'

export const HEALTHY = 'healthy'
export const COOLDOWN = 'cooldown'
export const EXHAUSTED = 'exhausted'
export const INVALID = 'invalid'
export const DISABLED = 'disabled'

const QUOTA_TEXT = /insufficient[_\s-]?quota|quota\s*(?:exceeded|reached|exhausted)|exceeded\s+your\s+(?:current\s+)?quota|credit\s*balance|insufficient\s+(?:balance|credits?|funds)|余额不足|额度(?:已|用)?(?:耗尽|不足|用完)|超出(?:了)?配额/i
const MODEL_TEXT = /model(?:\s+[\w.:-]+)?\s+(?:not\s+found|does\s+not\s+exist|not\s+supported)|unknown\s+model|invalid\s+model|no\s+such\s+model|模型(?:不存在|不支持)/i

function errorText(body) {
  if (typeof body === 'string') return body.slice(0, 2000)
  if (!body || typeof body !== 'object') return ''
  const parts = []
  for (const value of [body.error, body.message, body.detail, body.msg]) {
    if (typeof value === 'string') parts.push(value)
    else if (value && typeof value === 'object' && typeof value.message === 'string') parts.push(value.message)
  }
  return parts.join(' ').slice(0, 2000)
}

/**
 * Classify one failed upstream attempt.
 * @param {object} input
 * @param {number} [input.status] - HTTP status (0 for transport failures).
 * @param {unknown} [input.body] - parsed error body or raw text.
 * @param {string} [input.code] - transport error code (ECONNRESET, …).
 * @returns {{kind: string, code: string, retryable: boolean, rotateKey: boolean, cooldownMs: number, message: string}}
 */
export function classifyFailure({ status = 0, body = null, code = '', cooldowns, retryAfterMs = 0 } = {}) {
  const message = errorText(body) || (code ? String(code) : status ? `HTTP ${status}` : 'unknown failure')
  // A provider may ask for any Retry-After; never bench a key for more than
  // ten minutes on its say-so.
  const retryAfter = Math.max(0, Math.min(Number(retryAfterMs) || 0, 600_000))
  const base = cooldowns ?? { rateLimitMs: 20_000, serverMs: 15_000, transportMs: 8_000, authMs: 900_000, quotaMs: 600_000 }

  if (status === 0) {
    return { kind: 'transport', code: code || 'TRANSPORT', retryable: true, rotateKey: true, cooldownMs: base.transportMs, message }
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: 'INVALID_CREDENTIAL', retryable: true, rotateKey: true, cooldownMs: base.authMs, message }
  }
  if (status === 402) {
    return { kind: 'quota', code: 'QUOTA', retryable: true, rotateKey: true, cooldownMs: Math.max(base.quotaMs, retryAfter), message }
  }
  if (status === 429) {
    // A bare 429 is usually a per-minute throttle, not an exhausted account:
    // benching the key for the quota cooldown would idle a healthy account.
    if (!QUOTA_TEXT.test(message)) {
      return { kind: 'rateLimit', code: 'RATE_LIMIT', retryable: true, rotateKey: true, cooldownMs: Math.max(base.rateLimitMs, retryAfter), message }
    }
    return { kind: 'quota', code: 'QUOTA', retryable: true, rotateKey: true, cooldownMs: Math.max(base.quotaMs, retryAfter), message }
  }
  if (status === 404 && MODEL_TEXT.test(message)) {
    return { kind: 'model', code: 'MODEL_NOT_FOUND', retryable: true, rotateKey: false, cooldownMs: 0, message }
  }
  if (status >= 500) {
    return { kind: 'server', code: 'SERVER', retryable: true, rotateKey: true, cooldownMs: Math.max(base.serverMs, retryAfter), message }
  }
  if (status === 408 || status === 425) {
    return { kind: 'transport', code: 'TIMEOUT', retryable: true, rotateKey: true, cooldownMs: base.transportMs, message }
  }
  if (status === 400 && QUOTA_TEXT.test(message)) {
    // Some providers report exhausted quota as a 400 with a message body.
    return { kind: 'quota', code: 'QUOTA', retryable: true, rotateKey: true, cooldownMs: base.quotaMs, message }
  }
  if (status === 400 && MODEL_TEXT.test(message)) {
    return { kind: 'model', code: 'MODEL_NOT_FOUND', retryable: true, rotateKey: false, cooldownMs: 0, message }
  }
  return { kind: 'request', code: 'BAD_REQUEST', retryable: false, rotateKey: false, cooldownMs: 0, message }
}

function freshState() {
  return {
    state: HEALTHY,
    cooldownUntil: 0,
    failureStreak: 0,
    lastError: null,
    lastUsedAt: 0,
    requests: 0,
    errors: 0,
    retries: 0,
    tokensIn: 0,
    tokensOut: 0,
    latencySum: 0,
    latencyCount: 0,
    quota: null,
    quotaFetchedAt: null,
  }
}

export class KeyPool {
  /**
   * @param {object} options
   * @param {string} options.providerId
   * @param {Array<{id: string, label: string, key: string, enabled: boolean, weight: number}>} options.keys
   * @param {object} options.cooldowns
   * @param {number} [options.preemptAtPercent]
   * @param {() => number} [options.now]
   */
  constructor({ providerId, keys = [], cooldowns, preemptAtPercent = 100, now = () => Date.now() }) {
    this.providerId = providerId
    this.cooldowns = cooldowns
    this.preemptAtPercent = preemptAtPercent
    this.now = now
    this.entries = []
    this.states = new Map()
    this.setKeys(keys)
  }

  /** Reconcile the configured key list, keeping live state for surviving ids. */
  setKeys(keys) {
    const previous = this.states
    this.entries = keys.map(key => ({ ...key }))
    this.states = new Map()
    for (const key of this.entries) {
      const state = previous.get(key.id) ?? freshState()
      if (!key.enabled) state.state = DISABLED
      else if (state.state === DISABLED) state.state = HEALTHY
      this.states.set(key.id, state)
    }
  }

  setCooldowns(cooldowns) {
    this.cooldowns = cooldowns
  }

  setPreemptAtPercent(percent) {
    this.preemptAtPercent = percent
  }

  entry(id) {
    return this.entries.find(key => key.id === id) ?? null
  }

  /** Live state; an elapsed cooldown reports `healthy` immediately. */
  stateOf(id) {
    if (!this.states.has(id)) return null
    return this.refresh(id)
  }

  /** Cooldown has elapsed → the key returns to rotation on its own. */
  refresh(id) {
    const state = this.states.get(id)
    if (!state || state.state === DISABLED) return state
    if ((state.state === COOLDOWN || state.state === EXHAUSTED || state.state === INVALID)
        && state.cooldownUntil > 0 && state.cooldownUntil <= this.now()) {
      state.state = HEALTHY
      state.cooldownUntil = 0
      state.failureStreak = 0
    }
    return state
  }

  /** Quota preemption: skip a key before it fails, without marking it dead. */
  isPreempted(state) {
    if (this.preemptAtPercent >= 100 || !state?.quota) return false
    for (const window of [state.quota.rolling, state.quota.weekly]) {
      if (window && typeof window.percent === 'number' && window.percent >= this.preemptAtPercent) return true
    }
    return false
  }

  isEligible(id) {
    const entry = this.entry(id)
    if (!entry || !entry.enabled) return false
    const state = this.refresh(id)
    if (!state || state.state !== HEALTHY) return false
    return !this.isPreempted(state)
  }

  /** Eligible keys, least-recently-used first (weighted fair rotation). */
  candidates(exclude = null) {
    const now = this.now()
    return this.entries
      .filter(entry => (exclude ? !exclude.has(entry.id) : true) && this.isEligible(entry.id))
      .map(entry => {
        const state = this.states.get(entry.id)
        return { entry, score: (now - state.lastUsedAt) / Math.max(0.1, entry.weight) }
      })
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .map(item => item.entry)
  }

  pick(exclude = null) {
    const list = this.candidates(exclude)
    return list.length > 0 ? list[0] : null
  }

  onAttempt(id) {
    const state = this.states.get(id)
    if (!state) return
    state.requests += 1
    state.lastUsedAt = this.now()
  }

  onRetry(id) {
    const state = this.states.get(id)
    if (state) state.retries += 1
  }

  onSuccess(id, { latencyMs = null, tokensIn = 0, tokensOut = 0 } = {}) {
    const state = this.states.get(id)
    if (!state) return
    state.failureStreak = 0
    state.tokensIn += Number(tokensIn) || 0
    state.tokensOut += Number(tokensOut) || 0
    if (Number.isFinite(latencyMs)) {
      state.latencySum += latencyMs
      state.latencyCount += 1
    }
  }

  /** Record a classified failure; returns the applied cooldown in ms. */
  onFailure(id, failure) {
    const state = this.states.get(id)
    if (!state) return 0
    if (failure.rotateKey === false) return 0
    state.errors += 1
    state.failureStreak += 1
    state.lastError = {
      code: failure.code,
      message: String(failure.message || '').slice(0, 500),
      at: new Date(this.now()).toISOString(),
    }
    const cooldownMs = Math.max(0, Number(failure.cooldownMs) || 0)
    if (cooldownMs > 0) {
      state.state = failure.kind === 'auth' ? INVALID : failure.kind === 'quota' ? EXHAUSTED : COOLDOWN
      state.cooldownUntil = this.now() + cooldownMs
    }
    return cooldownMs
  }

  /** Manual reset from the dashboard: forget cooldown/invalid and revive. */
  reset(id) {
    const state = this.states.get(id)
    if (!state) return false
    const entry = this.entry(id)
    state.state = entry?.enabled === false ? DISABLED : HEALTHY
    state.cooldownUntil = 0
    state.failureStreak = 0
    state.lastError = null
    return true
  }

  setEnabled(id, on) {
    const entry = this.entry(id)
    const state = this.states.get(id)
    if (!entry || !state) return false
    entry.enabled = on
    if (on) {
      state.state = HEALTHY
      state.cooldownUntil = 0
    } else {
      state.state = DISABLED
    }
    return true
  }

  /** Fresh quota facts; revives an exhausted key the endpoint reports as ok. */
  applyUsage(id, quota) {
    const state = this.states.get(id)
    if (!state) return
    state.quota = quota ?? null
    state.quotaFetchedAt = new Date(this.now()).toISOString()
    const rolling = quota?.rolling
    if (state.state === EXHAUSTED
        && rolling && rolling.status === 'ok'
        && typeof rolling.percent === 'number' && rolling.percent < 98) {
      state.state = HEALTHY
      state.cooldownUntil = 0
      state.failureStreak = 0
    }
  }

  // ---- durability ----------------------------------------------------------
  // Cooldowns are absolute timestamps, so restoring them after a crash-loop is
  // safe: an expired cooldown heals on the next read instead of hammering a
  // dead key. Quota facts carry `quotaFetchedAt` and are dropped when stale.

  exportState() {
    return [...this.states.entries()].map(([id, state]) => ({
      id,
      state: state.state === DISABLED ? HEALTHY : state.state,
      cooldownUntil: state.cooldownUntil,
      failureStreak: state.failureStreak,
      lastError: state.lastError,
      lastUsedAt: state.lastUsedAt,
      requests: state.requests,
      errors: state.errors,
      retries: state.retries,
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
      latencySum: state.latencySum,
      latencyCount: state.latencyCount,
      quota: state.quota,
      quotaFetchedAt: state.quotaFetchedAt,
    }))
  }

  importState(records, { quotaFreshMs = 15 * 60_000 } = {}) {
    const now = this.now()
    for (const record of Array.isArray(records) ? records : []) {
      const state = this.states.get(record?.id)
      if (!state || !record || typeof record !== 'object') continue
      const entry = this.entry(record.id)
      if (entry?.enabled === false) continue
      if ([HEALTHY, COOLDOWN, EXHAUSTED, INVALID].includes(record.state)) state.state = record.state
      state.cooldownUntil = Number.isFinite(record.cooldownUntil) ? record.cooldownUntil : 0
      if (state.cooldownUntil <= now && state.state !== HEALTHY) {
        state.state = HEALTHY
        state.cooldownUntil = 0
      }
      state.failureStreak = Number.isFinite(record.failureStreak) ? record.failureStreak : 0
      state.lastError = record.lastError ?? null
      state.lastUsedAt = Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : 0
      for (const field of ['requests', 'errors', 'retries', 'tokensIn', 'tokensOut', 'latencySum', 'latencyCount']) {
        if (Number.isFinite(record[field])) state[field] = record[field]
      }
      const fetchedAt = record.quotaFetchedAt ? Date.parse(record.quotaFetchedAt) : 0
      if (record.quota && now - fetchedAt < quotaFreshMs) {
        state.quota = record.quota
        state.quotaFetchedAt = record.quotaFetchedAt
      }
    }
  }

  snapshot() {
    const now = this.now()
    return this.entries.map(entry => {
      const state = this.refresh(entry.id)
      return {
        id: entry.id,
        label: entry.label,
        enabled: entry.enabled,
        weight: entry.weight,
        state: state.state,
        cooldownUntil: state.cooldownUntil > now ? new Date(state.cooldownUntil).toISOString() : null,
        failureStreak: state.failureStreak,
        requests: state.requests,
        errors: state.errors,
        retries: state.retries,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        latencyMsAvg: state.latencyCount > 0 ? Math.round(state.latencySum / state.latencyCount) : null,
        lastError: state.lastError,
        apiKeyMasked: maskSecret(entry.key),
        quota: state.quota,
      }
    })
  }

  totals() {
    const snap = this.snapshot()
    return {
      keys: snap.length,
      healthy: snap.filter(key => key.state === HEALTHY).length,
      requests: snap.reduce((sum, key) => sum + key.requests, 0),
      errors: snap.reduce((sum, key) => sum + key.errors, 0),
    }
  }
}
