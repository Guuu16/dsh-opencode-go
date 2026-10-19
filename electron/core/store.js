/**
 * Persistent pool state: accounts, encrypted secrets, settings.
 *
 * Encryption is injected so the store runs under plain Node in tests and under
 * Electron's `safeStorage` (DPAPI on Windows) in the app. The secret never
 * leaves the main process: the renderer only receives a masked hint.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_SETTINGS = Object.freeze({
  preemptAtPercent: 95,
  switchAfterConsecutiveFailures: 2,
  usageRefreshMs: 30000,
  proxyEnabled: true,
  proxyPort: 8787,
  launchAtLogin: false,
  closeToTray: true,
  autoMarkInvalid: true,
})

const STATES = new Set(['healthy', 'exhausted', 'invalid', 'disabled'])
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export function newId() {
  return 'k-' + randomUUID().replace(/-/g, '').slice(0, 10)
}

/** `sk-abc...wxyz` → `sk-…wxyz`; never reveal the middle. */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`
}

export function defaultState() {
  return {
    version: 1,
    activeId: null,
    accounts: [],
    settings: { ...DEFAULT_SETTINGS },
    lastSwitch: null,
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Merge persisted data with defaults, dropping anything malformed. */
export function normalizeState(raw) {
  const state = defaultState()
  if (!raw || typeof raw !== 'object') return state

  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  state.settings = {
    preemptAtPercent: clampNumber(settings.preemptAtPercent, 0, 100, DEFAULT_SETTINGS.preemptAtPercent),
    switchAfterConsecutiveFailures: clampNumber(settings.switchAfterConsecutiveFailures, 0, 20, DEFAULT_SETTINGS.switchAfterConsecutiveFailures),
    usageRefreshMs: clampNumber(settings.usageRefreshMs, 5000, 300000, DEFAULT_SETTINGS.usageRefreshMs),
    proxyEnabled: settings.proxyEnabled !== false,
    proxyPort: clampNumber(settings.proxyPort, 1024, 65535, DEFAULT_SETTINGS.proxyPort),
    launchAtLogin: settings.launchAtLogin === true,
    closeToTray: settings.closeToTray !== false,
    autoMarkInvalid: settings.autoMarkInvalid !== false,
  }

  const seen = new Set()
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : []
  for (const item of accounts) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && ID_PATTERN.test(item.id) ? item.id : newId()
    if (seen.has(id)) continue
    seen.add(id)
    const label = typeof item.label === 'string' && item.label.trim().length > 0
      ? item.label.trim().slice(0, 60)
      : `账号 ${seen.size}`
    const stateValue = STATES.has(item.state) ? item.state : 'healthy'
    const account = {
      id,
      label,
      hint: typeof item.hint === 'string' ? item.hint : '',
      cipher: typeof item.cipher === 'string' ? item.cipher : '',
      scheme: item.scheme === 'plain' ? 'plain' : 'dpapi',
      state: stateValue,
      disabled: stateValue === 'disabled',
      failureStreak: Number.isFinite(item.failureStreak) ? Math.max(0, Math.floor(item.failureStreak)) : 0,
      lastFailure: item.lastFailure && typeof item.lastFailure === 'object' ? {
        code: String(item.lastFailure.code ?? ''),
        message: String(item.lastFailure.message ?? '').slice(0, 300),
        at: typeof item.lastFailure.at === 'string' ? item.lastFailure.at : null,
      } : null,
      usage: item.usage && typeof item.usage === 'object' ? item.usage : null,
      usageAt: typeof item.usageAt === 'string' ? item.usageAt : null,
      usageError: typeof item.usageError === 'string' ? item.usageError : null,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    }
    state.accounts.push(account)
  }

  state.activeId = typeof raw.activeId === 'string' && seen.has(raw.activeId) ? raw.activeId : null
  if (raw.lastSwitch && typeof raw.lastSwitch === 'object') {
    state.lastSwitch = {
      from: raw.lastSwitch.from ?? null,
      to: raw.lastSwitch.to ?? null,
      reason: String(raw.lastSwitch.reason ?? 'manual'),
      at: typeof raw.lastSwitch.at === 'string' ? raw.lastSwitch.at : new Date().toISOString(),
    }
  }
  return state
}

export class Store {
  /**
   * @param {object} options
   * @param {string} options.file - JSON state path.
   * @param {(plain: string) => string} options.encrypt - returns cipher text.
   * @param {(cipher: string) => string} options.decrypt - returns the plain secret.
   * @param {'dpapi'|'plain'} [options.scheme] - encryption scheme label.
   * @param {{warn: Function}} [options.logger]
   */
  constructor({ file, encrypt, decrypt, scheme = 'dpapi', logger = console }) {
    this.file = file
    this.encrypt = encrypt
    this.decrypt = decrypt
    this.scheme = scheme
    this.logger = logger
    this.state = defaultState()
  }

  load() {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = null
    }
    this.state = normalizeState(raw)
    return this.state
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
      return true
    } catch (error) {
      this.logger?.warn?.(`[store] save failed: ${String((error && error.message) || error)}`)
      return false
    }
  }

  account(id) {
    return this.state.accounts.find(account => account.id === id)
  }

  /** Decrypt one account's secret; throws a coded error when it cannot. */
  secretOf(id) {
    const account = this.account(id)
    if (!account) throw Object.assign(new Error(`unknown account "${id}"`), { code: 'UNKNOWN_ACCOUNT' })
    if (!account.cipher) throw Object.assign(new Error('no secret stored for this account'), { code: 'MISSING_CREDENTIAL' })
    try {
      const value = this.decrypt(account.cipher)
      if (!value) throw new Error('empty secret')
      return value
    } catch {
      throw Object.assign(new Error('stored secret cannot be decrypted on this Windows account'), { code: 'SECRET_UNREADABLE' })
    }
  }

  addAccount({ label, secret }) {
    const trimmedSecret = String(secret ?? '').trim()
    if (trimmedSecret.length < 8) throw new Error('密钥太短，请粘贴完整的 OpenCode Go API Key')
    const name = String(label ?? '').trim()
    const account = {
      id: newId(),
      label: name.length > 0 ? name.slice(0, 60) : `账号 ${this.state.accounts.length + 1}`,
      hint: maskSecret(trimmedSecret),
      cipher: this.encrypt(trimmedSecret),
      scheme: this.scheme,
      state: 'healthy',
      disabled: false,
      failureStreak: 0,
      lastFailure: null,
      usage: null,
      usageAt: null,
      usageError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.state.accounts.push(account)
    if (this.state.activeId === null) this.state.activeId = account.id
    this.save()
    return account
  }

  updateAccount(id, { label, secret } = {}) {
    const account = this.account(id)
    if (!account) throw new Error(`unknown account "${id}"`)
    if (typeof label === 'string' && label.trim().length > 0) account.label = label.trim().slice(0, 60)
    if (typeof secret === 'string' && secret.trim().length > 0) {
      const trimmed = secret.trim()
      if (trimmed.length < 8) throw new Error('密钥太短，请粘贴完整的 OpenCode Go API Key')
      account.cipher = this.encrypt(trimmed)
      account.scheme = this.scheme
      account.hint = maskSecret(trimmed)
      // A fresh secret may repair an invalid-marked account.
      if (account.state === 'invalid') {
        account.state = 'healthy'
        account.lastFailure = null
      }
      account.failureStreak = 0
    }
    account.updatedAt = new Date().toISOString()
    this.save()
    return account
  }

  removeAccount(id) {
    const index = this.state.accounts.findIndex(account => account.id === id)
    if (index < 0) return false
    this.state.accounts.splice(index, 1)
    if (this.state.activeId === id) this.state.activeId = null
    this.save()
    return true
  }
}
