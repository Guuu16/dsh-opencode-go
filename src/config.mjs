/**
 * Config load / normalize / persist, and the client-token store.
 *
 * The config file is the whole product state: providers, keys, client tokens
 * (hashed), routing policy. It lives at ~/.aipool/config.json with mode 0600.
 * Environment references are resolved on every load, so a key can stay out of
 * the file entirely:  "key": "${OPENCODE_GO_KEY_A}"  or  "env:OPENCODE_GO_KEY_A".
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  ConfigError,
  configPath,
  ensureDir,
  randomToken,
  readJSON,
  sha256,
  writeJSON,
} from './util.mjs'

export const CONFIG_VERSION = 1
export const DEFAULT_PORT = 8787
export const PROVIDER_TYPES = ['openai', 'anthropic']

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/

const DEFAULT_ALLOW_FROM = [
  '127.0.0.1/32',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
]

export const DEFAULT_COOLDOWNS = {
  // A busy account cools down briefly: 429s are shared across every client.
  rateLimitMs: 20_000,
  // Upstream is sick, not the key: short cooldown, try the next one.
  serverMs: 15_000,
  // Network/DNS blip.
  transportMs: 8_000,
  // A rejected credential needs a human, but a rotation of the key on the
  // provider side should recover on its own within a quarter hour.
  authMs: 900_000,
  // Quota can come back without warning; the usage probe revives earlier.
  quotaMs: 600_000,
}

export const DEFAULT_ROUTING = {
  defaultModel: 'auto',
  maxAttempts: 4,
  retryDelaysMs: [150, 500, 1200, 2000],
  streamIdleTimeoutMs: 300_000,
  requestTimeoutMs: 600_000,
  exposeModels: 'all', // all | aliases
}

export const DEFAULT_SERVER = {
  host: '0.0.0.0',
  port: DEFAULT_PORT,
  allowFrom: DEFAULT_ALLOW_FROM,
  trustProxy: false,
  maxBodyBytes: 64 * 1024 * 1024,
  dashboard: true,
}

function envRefValue(raw, where) {
  if (typeof raw !== 'string' || raw.length === 0) return raw
  const direct = raw.startsWith('env:') ? raw.slice(4) : null
  const braced = raw.startsWith('${') && raw.endsWith('}') ? raw.slice(2, -1) : null
  const name = direct ?? braced
  if (name === null) return raw
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new ConfigError(`${where}: environment variable "${name}" is not set (or empty)`)
  }
  return value
}

function numberIn(value, fallback, min, max, where) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${where} must be a number in [${min}, ${max}] (got ${JSON.stringify(value)})`)
  }
  return n
}

function stringOr(value, fallback, where) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${where} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeProvider(raw, index, seenIds) {
  const where = `providers[${index}]`
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${where} must be an object`)
  const id = stringOr(raw.id, '', `${where}.id`)
  if (!ID_RE.test(id)) throw new ConfigError(`${where}.id must match ${ID_RE} (got "${id}")`)
  if (seenIds.has(id)) throw new ConfigError(`${where}.id "${id}" is duplicated`)
  seenIds.add(id)

  const type = raw.type ?? 'openai'
  if (!PROVIDER_TYPES.includes(type)) {
    throw new ConfigError(`${where}.type must be one of ${PROVIDER_TYPES.join(', ')} (got "${type}")`)
  }
  const baseUrl = stringOr(raw.baseUrl, '', `${where}.baseUrl`)
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new ConfigError(`${where}.baseUrl is not a valid URL (got "${baseUrl}")`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${where}.baseUrl must be http(s)`)
  }

  const chatPath = stringOr(raw.chatPath, type === 'anthropic' ? '/v1/messages' : '/chat/completions', `${where}.chatPath`)
  const modelsPath = stringOr(raw.modelsPath, type === 'anthropic' ? '/v1/models' : '/models', `${where}.modelsPath`)
  const authHeader = raw.authHeader ?? (type === 'anthropic' ? 'x-api-key' : 'bearer')
  if (!['bearer', 'x-api-key', 'both'].includes(authHeader)) {
    throw new ConfigError(`${where}.authHeader must be bearer, x-api-key or both`)
  }

  const keysRaw = raw.keys ?? []
  if (!Array.isArray(keysRaw)) throw new ConfigError(`${where}.keys must be an array`)
  const seenKeyIds = new Set()
  const keys = keysRaw.map((entry, kIndex) => {
    const kWhere = `${where}.keys[${kIndex}]`
    if (!entry || typeof entry !== 'object') throw new ConfigError(`${kWhere} must be an object`)
    const keyId = stringOr(entry.id, `k${kIndex + 1}`, `${kWhere}.id`)
    if (!ID_RE.test(keyId)) throw new ConfigError(`${kWhere}.id must match ${ID_RE} (got "${keyId}")`)
    if (seenKeyIds.has(keyId)) throw new ConfigError(`${kWhere}.id "${keyId}" is duplicated`)
    seenKeyIds.add(keyId)
    const rawKey = envRefValue(entry.key ?? entry.apiKey ?? '', `${kWhere}.key`)
    const label = stringOr(entry.label, keyId, `${kWhere}.label`)
    return {
      id: keyId,
      label,
      key: rawKey,
      enabled: entry.enabled !== false,
      weight: numberIn(entry.weight, 1, 0.1, 100, `${kWhere}.weight`),
    }
  })

  const models = Array.isArray(raw.models)
    ? raw.models.map((model, mIndex) => {
        if (typeof model === 'string') return { id: model }
        if (!model || typeof model !== 'object' || typeof model.id !== 'string' || model.id === '') {
          throw new ConfigError(`${where}.models[${mIndex}] must be a model id or {id, name}`)
        }
        return {
          id: model.id,
          name: typeof model.name === 'string' ? model.name : model.id,
          contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : undefined,
          maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : undefined,
        }
      })
    : []

  const headers = {}
  if (raw.headers !== undefined) {
    if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
      throw new ConfigError(`${where}.headers must be an object of string values`)
    }
    for (const [name, value] of Object.entries(raw.headers)) {
      headers[name] = String(envRefValue(String(value), `${where}.headers.${name}`))
    }
  }

  return {
    id,
    name: stringOr(raw.name, id, `${where}.name`),
    type,
    baseUrl,
    chatPath,
    modelsPath,
    authHeader,
    anthropicVersion: stringOr(raw.anthropicVersion, '2023-06-01', `${where}.anthropicVersion`),
    priority: numberIn(raw.priority, 100, 1, 10_000, `${where}.priority`),
    enabled: raw.enabled !== false,
    timeoutMs: numberIn(raw.timeoutMs, 300_000, 1_000, 3_600_000, `${where}.timeoutMs`),
    models,
    modelsUrl: raw.modelsUrl === undefined || raw.modelsUrl === null || raw.modelsUrl === '' ? null : stringOr(raw.modelsUrl, '', `${where}.modelsUrl`),
    usageUrl: raw.usageUrl === undefined || raw.usageUrl === null || raw.usageUrl === '' ? null : stringOr(raw.usageUrl, '', `${where}.usageUrl`),
    usageRefreshMs: numberIn(raw.usageRefreshMs, 60_000, 15_000, 3_600_000, `${where}.usageRefreshMs`),
    preemptAtPercent: numberIn(raw.preemptAtPercent, 100, 1, 100, `${where}.preemptAtPercent`),
    // Ask the upstream for a final usage chunk in streams. Turn off for
    // OpenAI-compatible servers that reject unknown request fields.
    streamUsage: raw.streamUsage !== false,
    authHeaderName: authHeader === 'bearer' ? 'authorization' : 'x-api-key',
    headers,
    keys,
  }
}

function normalizeToken(raw, index, seenIds) {
  const where = `auth.tokens[${index}]`
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${where} must be an object`)
  const id = stringOr(raw.id, '', `${where}.id`)
  if (!ID_RE.test(id)) throw new ConfigError(`${where}.id must match ${ID_RE} (got "${id}")`)
  if (seenIds.has(id)) throw new ConfigError(`${where}.id "${id}" is duplicated`)
  seenIds.add(id)
  const hash = stringOr(raw.hash, '', `${where}.hash`)
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new ConfigError(`${where}.hash must be a sha256 hex digest (config stores tokens hashed, never in clear)`)
  }
  return {
    id,
    name: stringOr(raw.name, id, `${where}.name`),
    hash,
    createdAt: stringOr(raw.createdAt, new Date().toISOString(), `${where}.createdAt`),
    lastUsedAt: raw.lastUsedAt ?? null,
    requests: Number.isFinite(raw.requests) ? raw.requests : 0,
    disabled: raw.disabled === true,
    rpm: raw.rpm === undefined || raw.rpm === null ? null : numberIn(raw.rpm, null, 1, 100_000, `${where}.rpm`),
    models: Array.isArray(raw.models) ? raw.models.filter(item => typeof item === 'string') : null,
  }
}

function normalizeAliases(raw) {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('aliases must be an object: { "name": "provider/model" | ["provider/model", ...] }')
  }
  const out = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!ALIAS_RE.test(name)) throw new ConfigError(`aliases["${name}"]: name must match ${ALIAS_RE}`)
    if (name === 'auto') continue // reserved virtual model
    const list = Array.isArray(value) ? value : [value]
    if (list.length === 0 || list.some(item => typeof item !== 'string' || !item.includes('/'))) {
      throw new ConfigError(`aliases["${name}"] must be "provider/model" or an array of them`)
    }
    out[name] = list.map(item => item.trim())
  }
  return out
}

/** Normalize one raw config object into the shape the runtime trusts. */
export function normalizeConfig(raw, { source = 'config' } = {}) {
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${source}: root must be an object`)
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    throw new ConfigError(`${source}: unsupported version ${JSON.stringify(raw.version)} (expected ${CONFIG_VERSION})`)
  }

  const serverRaw = raw.server ?? {}
  const server = {
    host: stringOr(serverRaw.host, DEFAULT_SERVER.host, 'server.host'),
    // 0 = let the OS pick a free port (used by tests and by `aipool serve --port 0`).
    port: numberIn(serverRaw.port, DEFAULT_SERVER.port, 0, 65_535, 'server.port'),
    allowFrom: Array.isArray(serverRaw.allowFrom) ? serverRaw.allowFrom.map(item => String(item)) : DEFAULT_SERVER.allowFrom,
    trustProxy: serverRaw.trustProxy === true,
    maxBodyBytes: numberIn(serverRaw.maxBodyBytes, DEFAULT_SERVER.maxBodyBytes, 1024, 512 * 1024 * 1024, 'server.maxBodyBytes'),
    dashboard: serverRaw.dashboard !== false,
  }

  const authRaw = raw.auth ?? {}
  const adminToken = envRefValue(stringOr(authRaw.adminToken, '', 'auth.adminToken'), 'auth.adminToken')
  if (!adminToken.startsWith('adm_') || adminToken.length < 20) {
    throw new ConfigError('auth.adminToken must be a generated admin token (run `aipool init`)')
  }
  const tokensRaw = authRaw.tokens ?? []
  if (!Array.isArray(tokensRaw)) throw new ConfigError('auth.tokens must be an array')
  const seenTokenIds = new Set()
  const tokens = tokensRaw.map((entry, index) => normalizeToken(entry, index, seenTokenIds))

  const routingRaw = raw.routing ?? {}
  const routing = {
    defaultModel: stringOr(routingRaw.defaultModel, DEFAULT_ROUTING.defaultModel, 'routing.defaultModel'),
    maxAttempts: numberIn(routingRaw.maxAttempts, DEFAULT_ROUTING.maxAttempts, 1, 10, 'routing.maxAttempts'),
    retryDelaysMs: Array.isArray(routingRaw.retryDelaysMs)
      ? routingRaw.retryDelaysMs.map((value, index) => numberIn(value, 0, 0, 60_000, `routing.retryDelaysMs[${index}]`))
      : DEFAULT_ROUTING.retryDelaysMs,
    streamIdleTimeoutMs: numberIn(routingRaw.streamIdleTimeoutMs, DEFAULT_ROUTING.streamIdleTimeoutMs, 1_000, 3_600_000, 'routing.streamIdleTimeoutMs'),
    requestTimeoutMs: numberIn(routingRaw.requestTimeoutMs, DEFAULT_ROUTING.requestTimeoutMs, 1_000, 3_600_000, 'routing.requestTimeoutMs'),
    exposeModels: routingRaw.exposeModels === 'aliases' ? 'aliases' : 'all',
  }

  const cooldownRaw = raw.cooldown ?? {}
  const cooldown = {
    rateLimitMs: numberIn(cooldownRaw.rateLimitMs, DEFAULT_COOLDOWNS.rateLimitMs, 0, 3_600_000, 'cooldown.rateLimitMs'),
    serverMs: numberIn(cooldownRaw.serverMs, DEFAULT_COOLDOWNS.serverMs, 0, 3_600_000, 'cooldown.serverMs'),
    transportMs: numberIn(cooldownRaw.transportMs, DEFAULT_COOLDOWNS.transportMs, 0, 3_600_000, 'cooldown.transportMs'),
    authMs: numberIn(cooldownRaw.authMs, DEFAULT_COOLDOWNS.authMs, 0, 86_400_000, 'cooldown.authMs'),
    quotaMs: numberIn(cooldownRaw.quotaMs, DEFAULT_COOLDOWNS.quotaMs, 0, 86_400_000, 'cooldown.quotaMs'),
  }

  const providersRaw = raw.providers ?? []
  if (!Array.isArray(providersRaw)) throw new ConfigError('providers must be an array')
  const seenProviderIds = new Set()
  const providers = providersRaw
    .map((entry, index) => normalizeProvider(entry, index, seenProviderIds))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  return {
    version: CONFIG_VERSION,
    configPath: configPath(),
    server,
    auth: { adminToken, tokens },
    routing,
    cooldown,
    providers,
    aliases: normalizeAliases(raw.aliases),
  }
}

/** Read + normalize the config file. Throws ConfigError with a fixing hint. */
export function loadConfig(path = configPath()) {
  if (!existsSync(path)) {
    throw new ConfigError(`找不到配置文件 ${path} — 先运行 \`aipool init\` 生成一份`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigError(`${path} 不是合法 JSON: ${error.message}`)
  }
  try {
    return normalizeConfig(raw, { source: basename(path) })
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${path}: ${error.message}`)
    throw error
  }
}

export function persistConfig(config, path = config.configPath ?? configPath()) {
  writeJSON(path, {
    version: CONFIG_VERSION,
    server: config.server,
    auth: config.auth,
    routing: config.routing,
    cooldown: config.cooldown,
    providers: config.providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      chatPath: provider.chatPath,
      modelsPath: provider.modelsPath,
      authHeader: provider.authHeader,
      anthropicVersion: provider.anthropicVersion,
      priority: provider.priority,
      enabled: provider.enabled,
      timeoutMs: provider.timeoutMs,
      models: provider.models,
      modelsUrl: provider.modelsUrl,
      usageUrl: provider.usageUrl,
      usageRefreshMs: provider.usageRefreshMs,
      preemptAtPercent: provider.preemptAtPercent,
      streamUsage: provider.streamUsage,
      headers: provider.headers,
      keys: provider.keys,
    })),
    aliases: config.aliases,
  }, 0o600)
}

// ---- client tokens ---------------------------------------------------------

/**
 * Mint a client token. Returns the plaintext exactly once; only the sha256
 * digest is persisted, so `aipool token list` can never print it again.
 */
export function createClientToken(config, { name, rpm = null, models = null } = {}) {
  const plain = randomToken('sk-aipool-')
  const id = `tk_${randomBytes(4).toString('hex')}`
  const record = {
    id,
    name: name || id,
    hash: sha256(plain),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    requests: 0,
    disabled: false,
    rpm,
    models,
  }
  config.auth.tokens = [...(config.auth.tokens ?? []), record]
  return { plain, record }
}

export function findToken(config, plain) {
  if (typeof plain !== 'string' || plain.length < 8) return null
  const digest = sha256(plain)
  return (config.auth.tokens ?? []).find(token => token.hash === digest) ?? null
}

export function assertUniqueKeyLabel(config, providerId, label) {
  const provider = config.providers.find(item => item.id === providerId)
  if (!provider) throw new ConfigError(`unknown provider "${providerId}"`)
  if (provider.keys.some(key => key.label === label)) {
    throw new ConfigError(`provider "${providerId}" already has a key labelled "${label}"`)
  }
  return provider
}

/** Add a key to a provider, generating the next free id. */
export function addKey(config, providerId, { key, label, weight = 1 }) {
  const provider = assertUniqueKeyLabel(config, providerId, label)
  let index = provider.keys.length + 1
  while (provider.keys.some(entry => entry.id === `k${index}`)) index += 1
  const record = { id: `k${index}`, label, key, enabled: true, weight }
  provider.keys.push(record)
  return record
}

/** Remove a key by id (or by label when id misses). */
export function removeKey(config, providerId, idOrLabel) {
  const provider = config.providers.find(item => item.id === providerId)
  if (!provider) throw new ConfigError(`unknown provider "${providerId}"`)
  const index = provider.keys.findIndex(entry => entry.id === idOrLabel || entry.label === idOrLabel)
  if (index < 0) throw new ConfigError(`provider "${providerId}" has no key "${idOrLabel}"`)
  const [removed] = provider.keys.splice(index, 1)
  return removed
}

/** A commented starter config; the admin token is generated on `init`. */
export function starterConfig({ adminToken }) {
  return {
    version: CONFIG_VERSION,
    server: { ...DEFAULT_SERVER },
    auth: { adminToken, tokens: [] },
    routing: { ...DEFAULT_ROUTING },
    cooldown: { ...DEFAULT_COOLDOWNS },
    providers: [
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        type: 'openai',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        priority: 10,
        usageUrl: 'https://opencode.ai/zen/go/v1/usage',
        modelsUrl: 'https://opencode.ai/zen/go/v1/models',
        keys: [],
      },
      {
        id: 'ark-plan',
        name: 'Ark Agent Plan',
        type: 'anthropic',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
        chatPath: '/v1/messages',
        authHeader: 'bearer',
        priority: 50,
        models: [
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { id: 'doubao-seed-2.1-pro', name: 'Doubao Seed 2.1 Pro' },
          { id: 'glm-5.3', name: 'GLM 5.3' },
        ],
        keys: [],
      },
      {
        id: 'ollama',
        name: 'Ollama (本机)',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        priority: 900,
        keys: [{ id: 'local', label: 'local', key: 'ollama', enabled: false }],
      },
    ],
    aliases: {
      'auto': [],
    },
  }
}

export function ensureHome() {
  ensureDir(dirname(configPath()))
}
