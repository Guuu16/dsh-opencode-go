/**
 * Key-pool state machine (no Electron, no network).
 *
 * Ported from the DSH plugin with two fixes:
 *  - preemption and revival consider the monthly window too, so an account
 *    whose monthly quota is gone is not selected just because the 5h window
 *    reset;
 *  - every mutator funnels through `touch()` so the controller persists once
 *    and emits one state event.
 */

export const HEALTHY = 'healthy'
export const EXHAUSTED = 'exhausted'
export const INVALID = 'invalid'
export const DISABLED = 'disabled'

export const QUOTA_CODE = 'QUOTA'
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const AUTH_CODE = 'AUTH'
export const RATE_LIMIT_CODE = 'RATE_LIMIT'
export const SERVER_CODE = 'SERVER'
export const TRANSPORT_CODE = 'TRANSPORT'

/** Normalize a failure code onto the pool's rotation rules. */
export function classifyCode(code) {
  const value = String(code ?? '').toUpperCase()
  if (value === 'QUOTA' || value === 'QUOTA_EXCEEDED' || value === 'INSUFFICIENT_QUOTA' || value === '402') return QUOTA_CODE
  if (value === 'INVALID_CREDENTIAL' || value === 'AUTH' || value === '401' || value === '403') return INVALID_CREDENTIAL_CODE
  if (value === 'RATE_LIMIT' || value === '429') return RATE_LIMIT_CODE
  if (value === 'SERVER' || value === '500' || value === '502' || value === '503' || value === '504') return SERVER_CODE
  return value || TRANSPORT_CODE
}

export class Pool {
  /**
   * @param {object} options
   * @param {object} options.state - the store's live state object (accounts/settings/activeId).
   * @param {() => number} [options.now]
   * @param {number} [options.reviveThresholdPercent]
   */
  constructor({ state, now = () => Date.now(), reviveThresholdPercent = 98 }) {
    this.state = state
    this.now = now
    this.reviveThresholdPercent = reviveThresholdPercent
    this.onChange = null
  }

  get accounts() {
    return this.state.accounts
  }

  get settings() {
    return this.state.settings
  }

  touch() {
    this.onChange?.()
  }

  /**
   * Usable = healthy, not disabled, and not over any usage threshold while a
   * preemption threshold below 100 is configured.
   */
  usable(account) {
    if (!account || account.state !== HEALTHY) return false
    const threshold = Number(this.settings.preemptAtPercent)
    if (!(threshold < 100) || !account.usage) return true
    for (const name of ['rolling', 'weekly', 'monthly']) {
      const window = account.usage[name]
      if (window && typeof window.percent === 'number' && window.percent >= threshold) return false
    }
    return true
  }

  firstUsable(excludeId = null) {
    return this.accounts.find(account => account.id !== excludeId && this.usable(account)) ?? null
  }

  /** Next usable account in list order after `afterId`, wrapping once. */
  nextUsableAfter(afterId) {
    const index = this.accounts.findIndex(account => account.id === afterId)
    if (index < 0) return this.firstUsable()
    for (let step = 1; step <= this.accounts.length; step++) {
      const account = this.accounts[(index + step) % this.accounts.length]
      if (this.usable(account)) return account
    }
    return null
  }

  /**
   * The account a request should use. A sticky active account wins; otherwise
   * the first usable one is adopted without logging a manual switch.
   */
  current() {
    const active = this.accounts.find(account => account.id === this.state.activeId)
    if (active && this.usable(active)) return active
    const next = this.firstUsable()
    if (next) {
      this.state.activeId = next.id
      this.touch()
      return next
    }
    this.state.activeId = null
    return null
  }

  setActive(id) {
    const account = this.accounts.find(item => item.id === id)
    if (!account) throw new Error(`unknown account "${id}"`)
    if (!this.usable(account)) throw new Error('该账号当前不可用（额度耗尽、已失效、已停用或已达避让阈值）')
    if (this.state.activeId === id) return false
    this.state.lastSwitch = { from: this.state.activeId, to: id, reason: 'manual', at: new Date(this.now()).toISOString() }
    this.state.activeId = id
    this.touch()
    return true
  }

  /** Tray/hotkey rotation: move to the next usable account. */
  cycle() {
    const current = this.current()
    if (!current) return null
    const next = this.nextUsableAfter(current.id)
    if (!next || next.id === current.id) return null
    this.state.lastSwitch = { from: current.id, to: next.id, reason: 'manual', at: new Date(this.now()).toISOString() }
    this.state.activeId = next.id
    this.touch()
    return { from: current.id, to: next.id, reason: 'manual' }
  }

  setDisabled(id, disabled) {
    const account = this.accounts.find(item => item.id === id)
    if (!account) throw new Error(`unknown account "${id}"`)
    if (disabled) {
      account.disabled = true
      account.state = DISABLED
      account.failureStreak = 0
      if (this.state.activeId === id) this.state.activeId = null
    } else {
      account.disabled = false
      account.state = HEALTHY
      account.failureStreak = 0
      account.lastFailure = null
    }
    if (this.state.activeId === null) this.state.activeId = this.firstUsable()?.id ?? null
    this.touch()
    return true
  }

  /**
   * Record a classified failure and rotate when the rule says so.
   * @returns {{from: string, to: string|null, reason: string}|null}
   */
  onFailure(id, code, message = '') {
    const account = this.accounts.find(item => item.id === id)
    if (!account) return null
    const normalized = classifyCode(code)
    account.lastFailure = { code: normalized, message: String(message).slice(0, 300), at: new Date(this.now()).toISOString() }

    if (normalized === QUOTA_CODE || normalized === INVALID_CREDENTIAL_CODE) {
      account.state = normalized === QUOTA_CODE ? EXHAUSTED : INVALID
      account.failureStreak = 0
      const rotation = this.rotate(id, normalized === QUOTA_CODE ? 'quota' : 'invalid')
      this.touch()
      return rotation
    }

    account.failureStreak = (account.failureStreak ?? 0) + 1
    const threshold = Number(this.settings.switchAfterConsecutiveFailures)
    if (threshold > 0 && account.failureStreak >= threshold) {
      account.failureStreak = 0
      const next = this.nextUsableAfter(id)
      if (next && next.id !== id) {
        const rotation = this.rotate(id, 'consecutive')
        this.touch()
        return rotation
      }
    }
    this.touch()
    return null
  }

  rotate(fromId, reason) {
    const next = this.nextUsableAfter(fromId)
    const to = next ? next.id : null
    if (to === this.state.activeId && to === fromId) return null
    this.state.activeId = to
    this.state.lastSwitch = { from: fromId, to, reason, at: new Date(this.now()).toISOString() }
    return { from: fromId, to, reason }
  }

  onSuccess(id) {
    const account = this.accounts.find(item => item.id === id)
    if (!account || account.failureStreak === 0) return
    account.failureStreak = 0
    this.touch()
  }

  /** Feed a fresh usage report; revive an exhausted account when every window recovered. */
  onUsage(id, usage) {
    const account = this.accounts.find(item => item.id === id)
    if (!account) return
    account.usage = usage ?? null
    account.usageAt = new Date(this.now()).toISOString()
    account.usageError = null
    if (account.state === EXHAUSTED && usage && this.recovered(usage)) {
      account.state = HEALTHY
      account.lastFailure = null
      account.failureStreak = 0
      if (this.state.activeId === null) this.state.activeId = this.firstUsable()?.id ?? null
    }
    this.touch()
  }

  recovered(usage) {
    let sawWindow = false
    for (const name of ['rolling', 'weekly', 'monthly']) {
      const window = usage[name]
      if (!window) continue
      sawWindow = true
      if (window.status === 'error') return false
      if (typeof window.percent === 'number' && window.percent >= this.reviveThresholdPercent) return false
    }
    return sawWindow
  }

  onUsageError(id, code) {
    const account = this.accounts.find(item => item.id === id)
    if (!account) return
    account.usageError = String(code)
    this.touch()
  }

  markInvalid(id, message = 'usage endpoint rejected the key (401)') {
    const account = this.accounts.find(item => item.id === id)
    if (!account || account.state === INVALID) return null
    account.state = INVALID
    account.failureStreak = 0
    account.lastFailure = { code: INVALID_CREDENTIAL_CODE, message, at: new Date(this.now()).toISOString() }
    const rotation = this.rotate(id, 'invalid')
    this.touch()
    return rotation
  }

  /** Remove an account and keep the active pointer valid. */
  remove(id) {
    const index = this.accounts.findIndex(item => item.id === id)
    if (index < 0) return false
    this.accounts.splice(index, 1)
    if (this.state.activeId === id) this.state.activeId = this.firstUsable()?.id ?? null
    this.touch()
    return true
  }
}
