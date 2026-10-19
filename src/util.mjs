/**
 * Shared plumbing: paths, atomic JSON, tokens, CIDR gates, logging.
 * Zero dependencies — Node >= 20 built-ins only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BlockList, isIPv4, isIPv6 } from 'node:net'

export class GatewayError extends Error {
  constructor(message, { status = 500, code = 'GATEWAY_ERROR', type = 'api_error', detail = null } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.type = type
    this.detail = detail
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function aipoolHome() {
  const override = process.env.AIPOOL_HOME
  return override ? resolve(expandHome(override)) : join(homedir(), '.aipool')
}

export function configPath() {
  const override = process.env.AIPOOL_CONFIG
  return override ? resolve(expandHome(override)) : join(aipoolHome(), 'config.json')
}

export function logPath() {
  return join(aipoolHome(), 'aipool.log')
}

export function pidPath() {
  return join(aipoolHome(), 'aipool.pid')
}

export function statsPath() {
  return join(aipoolHome(), 'stats.json')
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

export function readJSON(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Atomic JSON write; 0600 by default because configs hold credentials. */
export function writeJSON(path, value, mode = 0o600) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

export function writeText(path, text, mode = 0o600) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

export function randomToken(prefix) {
  return `${prefix}${randomBytes(24).toString('base64url')}`
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** `sk-abcd…wxyz` — enough to recognize a key, useless to an attacker. */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  if (secret.length <= 10) return `${secret.slice(0, 2)}…`
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`
}

export function nowISO(now = Date.now()) {
  return new Date(now).toISOString()
}

export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise()
    }
    function onAbort() {
      finish()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * CIDR allow-list gate. Node's BlockList handles IPv4/IPv6 subnets; plain
 * addresses are accepted too. `::ffff:192.168.1.5` is normalized to IPv4 so a
 * LAN client behind a dual-stack listener still matches an IPv4 rule.
 */
export function compileAllowList(entries = []) {
  const list = new BlockList()
  let allowAll = false
  for (const raw of entries) {
    const entry = String(raw).trim()
    if (entry === '' ) continue
    if (entry === '*' || entry === '0.0.0.0/0' || entry === '::/0') {
      allowAll = true
      continue
    }
    const [base, bits] = entry.split('/')
    const type = isIPv4(base) ? 'ipv4' : isIPv6(base) ? 'ipv6' : null
    if (type === null) continue
    try {
      if (bits === undefined) list.addAddress(base, type)
      else {
        const prefix = Number(bits)
        if (!Number.isInteger(prefix)) continue
        list.addSubnet(base, prefix, type)
      }
    } catch {
      // normalizeConfig rejects malformed entries up front; a defensive skip
      // here keeps a hand-edited config from crashing the listener.
    }
  }
  return {
    allowAll,
    check(address) {
      if (allowAll) return true
      if (typeof address !== 'string' || address === '') return false
      const normalized = address.startsWith('::ffff:') && isIPv4(address.slice(7)) ? address.slice(7) : address
      const type = isIPv4(normalized) ? 'ipv4' : isIPv6(normalized) ? 'ipv6' : null
      if (type === null) return false
      try {
        return list.check(normalized, type)
      } catch {
        return false
      }
    },
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
let currentLevel = LEVELS[process.env.AIPOOL_LOG_LEVEL] ?? LEVELS.info

export function setLogLevel(name) {
  if (LEVELS[name]) currentLevel = LEVELS[name]
}

/** One-line logs. Never pass a secret here; use maskSecret() first. */
export function log(level, message, extra) {
  if ((LEVELS[level] ?? 20) < currentLevel) return
  const stamp = new Date().toISOString()
  const line = extra === undefined ? `${stamp} ${level.toUpperCase()} ${message}` : `${stamp} ${level.toUpperCase()} ${message} ${formatExtra(extra)}`
  process.stderr.write(`${line}\n`)
}

function formatExtra(extra) {
  if (extra instanceof Error) return `${extra.name}: ${extra.message}`
  try {
    return JSON.stringify(extra)
  } catch {
    return String(extra)
  }
}

export function redactHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = /authorization|api-key|x-api-key|cookie/i.test(key) ? '***' : value
  }
  return out
}

/** Best-effort LAN address for the "open this on your phone" hint. */
export function lanAddressHint(host) {
  if (host && host !== '0.0.0.0' && host !== '::') return host
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family === 'IPv4' || entry.family === 4) return entry.address
    }
  }
  return '127.0.0.1'
}

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`
}
