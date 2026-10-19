/**
 * HTTP gateway: OpenAI `/v1/*` + Anthropic `/v1/messages` in, one pool out.
 *
 * Auth model: every client presents one `sk-aipool-…` token. The dashboard
 * uses the separate admin token. Upstream keys never leave the daemon.
 */

import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { Router, UsagePoller } from './router.mjs'
import { persistConfig } from './config.mjs'
import {
  GatewayError,
  compileAllowList,
  humanDuration,
  lanAddressHint,
  log,
  maskSecret,
  nowISO,
  safeEqual,
  sha256,
} from './util.mjs'
import {
  anthropicRequestToCanonical,
  anthropicStreamToOpenAI,
  canonicalToAnthropicResponse,
  emptyStreamContext,
  normalizeResponse,
  openAIStreamToAnthropic,
  passthroughStream,
  sseData,
  sseEvent,
} from './protocol.mjs'

const VERSION = '0.1.0'
const MODELS_CREATED = Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000)

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      // Drain instead of destroying: a destroyed socket cannot carry the 413
      // back to the client, and callers see a reset instead of an error body.
      req.resume()
      reject(error)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new GatewayError(`请求体超过 ${limit} 字节上限`, { status: 413, code: 'PAYLOAD_TOO_LARGE', type: 'invalid_request_error' }))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function parseJSONBody(raw, what = '请求体') {
  try {
    return JSON.parse(raw)
  } catch {
    throw new GatewayError(`${what}不是合法 JSON`, { status: 400, code: 'INVALID_JSON', type: 'invalid_request_error' })
  }
}

/** reader.read() bounded by the stream idle timeout, not just the request one. */
function readWithIdle(reader, timeoutMs, onIdle) {
  if (!(timeoutMs > 0)) return reader.read()
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      onIdle?.()
      reject(new GatewayError(`上游流 ${timeoutMs}ms 没有新数据`, { status: 504, code: 'STREAM_IDLE_TIMEOUT', type: 'api_error' }))
    }, timeoutMs)
    reader.read().then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function sendJSON(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function dialectOf(pathname) {
  return pathname.startsWith('/v1/messages') ? 'anthropic' : 'openai'
}

function errorPayload(dialect, error) {
  const message = error?.message ?? 'internal error'
  if (dialect === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: error?.type === 'invalid_request_error' ? 'invalid_request_error' : error?.type ?? 'api_error',
        message,
      },
    }
  }
  return {
    error: {
      message,
      type: error?.type ?? 'api_error',
      code: error?.code ?? null,
      param: null,
    },
  }
}

function headerValue(headers, name) {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function bearerOf(req) {
  const authorization = headerValue(req.headers, 'authorization') ?? ''
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim()
  const apiKey = headerValue(req.headers, 'x-api-key')
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
  return null
}

function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = headerValue(req.headers, 'x-forwarded-for')
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? ''
}


/**
 * Build the gateway. `start()` binds; `stop()` closes; `reload(config)`
 * hot-applies a new config without dropping the listener.
 */
export async function createGateway({ config, log: logger = log, restoreState = true }) {
  let dashboardHtml = null
  try {
    const module = await import('./dashboard.mjs')
    dashboardHtml = typeof module.renderDashboard === 'function' ? module.renderDashboard : (() => null)
  } catch (error) {
    logger('debug', `dashboard module unavailable: ${error.message}`)
  }

  const router = new Router({ config, restoreState })
  const poller = new UsagePoller({ router, intervalMs: 60_000 })
  let allowList = compileAllowList(config.server.allowFrom)
  const rateWindows = new Map()
  const startedAt = Date.now()
  let stateTimer = null

  router.versionString = VERSION

  function rateLimited(token) {
    if (!token.rpm) return false
    const now = Date.now()
    const window = rateWindows.get(token.id) ?? []
    const fresh = window.filter(stamp => now - stamp < 60_000)
    if (fresh.length >= token.rpm) {
      rateWindows.set(token.id, fresh)
      return true
    }
    fresh.push(now)
    rateWindows.set(token.id, fresh)
    return false
  }

  function authenticate(req, url, { requireAdmin = false } = {}) {
    // Header only. A token in the query string ends up in access logs, shell
    // history and referrers; the dashboard reads its own ?token= client-side.
    const supplied = bearerOf(req)
    if (!supplied) {
      throw new GatewayError('缺少凭证：用 `Authorization: Bearer sk-aipool-…` 访问', {
        status: 401,
        code: 'MISSING_TOKEN',
        type: 'authentication_error',
      })
    }
    if (safeEqual(supplied, config.auth.adminToken)) return { kind: 'admin', token: null }
    if (requireAdmin) {
      throw new GatewayError('这个接口需要 admin token（config.auth.adminToken）', {
        status: 401,
        code: 'ADMIN_TOKEN_REQUIRED',
        type: 'authentication_error',
      })
    }
    const digest = sha256(supplied)
    const token = config.auth.tokens.find(entry => entry.hash === digest)
    if (!token) {
      throw new GatewayError('token 无效或已被撤销', { status: 401, code: 'INVALID_TOKEN', type: 'authentication_error' })
    }
    if (token.disabled) {
      throw new GatewayError('这个 token 已被停用', { status: 403, code: 'TOKEN_DISABLED', type: 'permission_error' })
    }
    if (rateLimited(token)) {
      throw new GatewayError(`token 超过每分钟 ${token.rpm} 次请求上限`, {
        status: 429,
        code: 'RATE_LIMITED',
        type: 'rate_limit_error',
      })
    }
    return { kind: 'client', token }
  }

  function checkModelAllowed(auth, requestedModel) {
    if (!auth.token?.models || auth.token.models.length === 0) return
    if (!requestedModel) return
    if (!auth.token.models.includes(requestedModel)) {
      throw new GatewayError(`这个 token 只允许模型：${auth.token.models.join(', ')}`, {
        status: 403,
        code: 'MODEL_NOT_ALLOWED',
        type: 'permission_error',
      })
    }
  }

  function modelList() {
    const entries = new Map()
    const add = (id, ownedBy, name) => {
      if (!id || entries.has(id)) return
      entries.set(id, { id, object: 'model', created: MODELS_CREATED, owned_by: ownedBy, name: name ?? id })
    }
    for (const provider of config.providers) {
      if (!provider.enabled) continue
      for (const model of router.catalogFor(provider.id)) {
        add(`${provider.id}/${model.id}`, provider.id, model.name)
        if (config.routing.exposeModels === 'all') add(model.id, provider.id, model.name)
      }
    }
    for (const name of Object.keys(config.aliases)) add(name, 'aipool', name)
    add('auto', 'aipool', 'Auto (priority order)')
    return [...entries.values()]
  }

  async function handleCompletions(req, res, auth, canonical, dialect, { clientModel = null } = {}) {
    const stream = canonical.stream === true
    // Only a model the client named is policed: an omitted model falls back to
    // routing.defaultModel, which the token should not have to list.
    checkModelAllowed(auth, clientModel)
    router.beginRequest()
    const clientAbort = new AbortController()
    let completed = false
    res.on('close', () => {
      if (!completed) clientAbort.abort()
    })

    const overallTimer = setTimeout(() => clientAbort.abort(), config.routing.requestTimeoutMs)

    let candidate = null
    let countingStream = false
    let upstreamReader = null
    try {
      candidate = await router.open({ canonical, stream, clientSignal: clientAbort.signal })

      if (!stream) {
        const raw = await candidate.response.text()
        let json
        try {
          json = JSON.parse(raw)
        } catch {
          throw new GatewayError(
            `上游 ${candidate.provider.id}/${candidate.key.id} 返回了非 JSON 响应：${raw.slice(0, 200)}`,
            { status: 502, code: 'UPSTREAM_NOT_JSON', type: 'api_error' },
          )
        }
        const normalized = normalizeResponse({ providerType: candidate.provider.type, json, requestedModel: candidate.requestedModel })
        const body = dialect === 'anthropic'
          ? canonicalToAnthropicResponse(normalized.body, candidate.requestedModel)
          : normalized.body
        const headers = {
          'x-aipool-route': `${candidate.provider.id}/${candidate.key.id}`,
          'x-aipool-attempts': String(candidate.attempts.length + 1),
        }
        sendJSON(res, 200, body, headers)
        router.finish({ candidate, usage: normalized.usage, startedAt: candidate.attemptStartedAt, streamed: false })
        completed = true
        return
      }

      // Router.open() already peeked the first SSE chunk and rotated on an
      // early error, so the attempt budget is exactly maxAttempts.
      const reader = candidate.reader ?? candidate.response.body.getReader()
      const first = candidate.first ?? { done: true, value: undefined }
      upstreamReader = reader

      res.writeHead(200, {
        'content-type': dialect === 'anthropic' ? 'text/event-stream; charset=utf-8' : 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-aipool-route': `${candidate.provider.id}/${candidate.key.id}`,
        'x-aipool-attempts': String(candidate.attempts.length + 1),
      })
      res.flushHeaders?.()

      router.counters.activeStreams += 1
      countingStream = true
      const sameDialect = candidate.dialect === dialect
      const ctx = emptyStreamContext()

      const idleMs = config.routing.streamIdleTimeoutMs
      const upstreamStream = (async function* () {
        if (!first.done) yield first.value
        while (true) {
          const next = await readWithIdle(reader, idleMs, () => candidate.abort?.())
          if (next.done) break
          yield next.value
        }
      })()

      const out = sameDialect
        ? passthroughStream(upstreamStream, { providerType: candidate.provider.type, ctx })
        : candidate.provider.type === 'anthropic'
          ? anthropicStreamToOpenAI(upstreamStream, { model: candidate.requestedModel, ctx })
          : openAIStreamToAnthropic(upstreamStream, { model: candidate.requestedModel, ctx })

      for await (const piece of out) {
        if (res.writableEnded) break
        res.write(piece)
      }
      completed = true
      if (ctx.error) {
        router.finish({ candidate, usage: ctx.usage, error: Object.assign(new Error(ctx.error.message), { code: 'STREAM_ERROR' }), startedAt: candidate.attemptStartedAt, streamed: true })
        // The dialect translators already emitted the error frame; only the
        // paths that swallowed it need one synthesized here.
        if (!res.writableEnded && !ctx.errorForwarded) {
          if (dialect === 'anthropic') {
            res.write(sseEvent('error', { type: 'error', error: { type: 'api_error', message: ctx.error.message } }))
          } else {
            res.write(sseData({ error: { message: ctx.error.message, type: 'api_error' } }))
            res.write(sseData('[DONE]'))
          }
        }
      } else {
        router.finish({ candidate, usage: ctx.usage, startedAt: candidate.attemptStartedAt, streamed: true })
      }
      res.end()
    } catch (error) {
      completed = true
      // Release the upstream socket: an idle stream that we gave up on would
      // otherwise keep the connection (and the test process) alive.
      await upstreamReader?.cancel?.().catch(() => {})
      const err = error instanceof GatewayError ? error : new GatewayError(error.message, { status: 502, code: 'UPSTREAM_ERROR', type: 'api_error' })
      if (candidate) {
        router.finish({ candidate, error: err, startedAt: candidate.attemptStartedAt, streamed: stream })
      } else {
        router.counters.failed += 1
        router.record({
          at: nowISO(),
          model: canonical.model ?? null,
          requested: canonical.model ?? null,
          status: 'error',
          ms: 0,
          attempts: 0,
          route: null,
          error: err.code,
          streamed: stream,
        })
      }
      const retryAfterMs = Number(err.detail?.retryAfterMs) || 0
      if (!res.headersSent) {
        sendJSON(res, err.status, errorPayload(dialect, err), {
          'x-aipool-error': err.code,
          ...(retryAfterMs > 0 ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {}),
        })
      }
      else if (!res.writableEnded) {
        if (dialect === 'anthropic') {
          res.write(sseEvent('error', { type: 'error', error: { type: 'api_error', message: err.message } }))
        } else {
          res.write(sseData({ error: { message: err.message, type: 'api_error' } }))
          res.write(sseData('[DONE]'))
        }
        res.end()
      }
    } finally {
      clearTimeout(overallTimer)
      candidate?.releaseAbort?.()
      if (countingStream) {
        countingStream = false
        router.counters.activeStreams = Math.max(0, router.counters.activeStreams - 1)
      }
    }
  }

  async function handleAdminAction(req, res) {
    const body = parseJSONBody(await readBody(req, config.server.maxBodyBytes))
    const action = body?.action
    const providerId = body?.provider
    const keyId = body?.key
    const tokenId = body?.token
    let changed = false

    if (action === 'resetKey' || action === 'disableKey' || action === 'enableKey') {
      const pool = router.pool(providerId)
      const provider = config.providers.find(item => item.id === providerId)
      if (!pool || !provider) throw new GatewayError(`unknown provider "${providerId}"`, { status: 404, code: 'PROVIDER_NOT_FOUND', type: 'invalid_request_error' })
      const entry = pool.entry(keyId)
      if (!entry) throw new GatewayError(`unknown key "${keyId}"`, { status: 404, code: 'KEY_NOT_FOUND', type: 'invalid_request_error' })
      if (action === 'resetKey') pool.reset(keyId)
      else {
        const on = action === 'enableKey'
        pool.setEnabled(keyId, on)
        const stored = provider.keys.find(item => item.id === keyId)
        if (stored) stored.enabled = on
        changed = true
      }
      if (changed) persistConfig(config)
      return sendJSON(res, 200, { ok: true })
    }

    if (action === 'probeKey') {
      const provider = config.providers.find(item => item.id === providerId)
      const pool = router.pool(providerId)
      const entry = pool?.entry(keyId)
      if (!provider || !entry) throw new GatewayError('unknown provider or key', { status: 404, code: 'NOT_FOUND', type: 'invalid_request_error' })
      const model = provider.models[0]?.id ?? router.catalogFor(provider.id)[0]?.id
      if (!model) return sendJSON(res, 200, { ok: false, error: 'no model configured for this provider' })
      const started = Date.now()
      try {
        const { buildUpstreamRequest } = await import('./protocol.mjs')
        const request = buildUpstreamRequest({
          provider,
          apiKey: entry.key,
          modelId: model,
          canonical: { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], stream: false },
          signal: AbortSignal.timeout(30_000),
        })
        const response = await fetch(request.url, request.init)
        const text = await response.text()
        const ok = response.ok
        if (ok) pool.reset(keyId)
        return sendJSON(res, 200, { ok, status: response.status, ms: Date.now() - started, model, error: ok ? null : text.slice(0, 300) })
      } catch (error) {
        return sendJSON(res, 200, { ok: false, status: 0, ms: Date.now() - started, model, error: error.message })
      }
    }

    if (action === 'disableToken' || action === 'enableToken') {
      const token = config.auth.tokens.find(item => item.id === tokenId)
      if (!token) throw new GatewayError(`unknown token "${tokenId}"`, { status: 404, code: 'TOKEN_NOT_FOUND', type: 'invalid_request_error' })
      token.disabled = action === 'disableToken'
      persistConfig(config)
      return sendJSON(res, 200, { ok: true })
    }

    throw new GatewayError(`unknown action "${action}"`, { status: 400, code: 'UNKNOWN_ACTION', type: 'invalid_request_error' })
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const dialect = dialectOf(pathname)
    const address = clientAddress(req, config.server.trustProxy)

    if (!allowList.check(address) && !allowList.allowAll) {
      sendJSON(res, 403, errorPayload(dialect, new GatewayError(`来源地址 ${address} 不在 server.allowFrom 里`, { status: 403, code: 'IP_NOT_ALLOWED', type: 'permission_error' })))
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '86400',
      })
      res.end()
      return
    }

    if (pathname === '/healthz') {
      sendJSON(res, 200, { ok: true, version: VERSION, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), providers: config.providers.length })
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (config.server.dashboard === false) {
        sendJSON(res, 404, { error: { message: 'dashboard disabled (server.dashboard=false)', type: 'api_error' } })
        return
      }
      const html = dashboardHtml ? dashboardHtml() : null
      if (!html) {
        sendJSON(res, 404, { error: { message: 'dashboard module missing (src/dashboard.mjs)', type: 'api_error' } })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(html)
      return
    }

    if (pathname === '/admin/status') {
      authenticate(req, url, { requireAdmin: true })
      sendJSON(res, 200, router.snapshot())
      return
    }

    if (pathname === '/admin/action' && req.method === 'POST') {
      authenticate(req, url, { requireAdmin: true })
      await handleAdminAction(req, res)
      return
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      const auth = authenticate(req, url)
      const allowed = auth.token?.models?.length ? auth.token.models : null
      const data = modelList().filter(entry => allowed === null || allowed.includes(entry.id))
      sendJSON(res, 200, { object: 'list', data })
      return
    }

    if (pathname === '/v1/usage' && req.method === 'GET') {
      // Key ids, labels and last errors are operator data, not client data.
      authenticate(req, url, { requireAdmin: true })
      const snapshot = router.snapshot()
      sendJSON(res, 200, {
        counters: snapshot.counters,
        providers: snapshot.providers.map(provider => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          keys: provider.keys.map(key => ({
            id: key.id,
            label: key.label,
            state: key.state,
            cooldownUntil: key.cooldownUntil,
            quota: key.quota,
            requests: key.requests,
            errors: key.errors,
          })),
        })),
      })
      return
    }

    if (pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
      const auth = authenticate(req, url)
      const raw = await readBody(req, config.server.maxBodyBytes)
      const body = parseJSONBody(raw)
      const text = JSON.stringify(body.messages ?? '') + JSON.stringify(body.system ?? '')
      // Deliberately rough: tokenizers differ per upstream and clients use this
      // only for budgeting. ~3.5 chars/token is closer than chars/4 for CJK.
      const inputTokens = Math.ceil(text.length / 3.5)
      sendJSON(res, 200, { input_tokens: inputTokens })
      auth.token && (auth.token.requests += 1)
      return
    }

    if ((pathname === '/v1/chat/completions' || pathname === '/v1/messages') && req.method === 'POST') {
      const auth = authenticate(req, url)
      const raw = await readBody(req, config.server.maxBodyBytes)
      const body = parseJSONBody(raw)
      if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
        throw new GatewayError('缺少 messages 数组', { status: 400, code: 'INVALID_REQUEST', type: 'invalid_request_error' })
      }
      const clientModel = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null
      const canonical = pathname === '/v1/messages' ? anthropicRequestToCanonical(body) : body
      if (!canonical.model) canonical.model = config.routing.defaultModel
      if (auth.token) {
        auth.token.requests += 1
        auth.token.lastUsedAt = nowISO()
      }
      await handleCompletions(req, res, auth, canonical, dialect, { clientModel })
      return
    }

    sendJSON(res, 404, errorPayload(dialect, new GatewayError(`没有这个路由：${req.method} ${pathname}`, { status: 404, code: 'NOT_FOUND', type: 'invalid_request_error' })))
  }

  const server = createServer((req, res) => {
    const started = Date.now()
    const pathname = (() => {
      try {
        return new URL(req.url ?? '/', 'http://localhost').pathname
      } catch {
        return '/'
      }
    })()
    res.on('finish', () => {
      if (pathname === '/healthz' || pathname === '/admin/status') return
      logger('debug', `${req.method} ${pathname} → ${res.statusCode} ${Date.now() - started}ms`)
    })
    route(req, res).catch(error => {
      const err = error instanceof GatewayError ? error : new GatewayError(error?.message ?? 'internal error', { status: 500, code: 'INTERNAL', type: 'api_error' })
      if (err.status >= 500) logger('error', `${req.method} ${pathname} → ${err.code}: ${err.message}`)
      if (!res.headersSent) {
        const dialect = dialectOf(new URL(req.url ?? '/', 'http://localhost').pathname)
        sendJSON(res, err.status, errorPayload(dialect, err), { 'x-aipool-error': err.code })
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })

  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000

  return {
    server,
    router,
    poller,
    get config() {
      return config
    },
    /** Hot-apply a new config (SIGHUP / `aipool key add` while running). */
    reload(nextConfig) {
      // Compile and validate before touching live state: a bad entry must
      // leave the running gateway untouched, not half-switched.
      const nextAllowList = compileAllowList(nextConfig.server.allowFrom)
      router.updateConfig(nextConfig)
      config = nextConfig
      allowList = nextAllowList
      poller.router = router
      return config
    },
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.server.port, config.server.host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      poller.start()
      stateTimer = setInterval(() => router.saveState(), 5_000)
      stateTimer.unref?.()
      router.refreshCatalog().catch(() => {})
      const address = server.address()
      // port 0 lets the OS choose; snapshots and the dashboard must show the
      // port that is actually listening, not the request.
      config.server.port = address.port
      const host = lanAddressHint(config.server.host)
      logger('info', `aipool listening on http://${config.server.host}:${address.port}  →  http://${host}:${address.port}/v1`)
      logger('info', `dashboard: http://${host}:${address.port}/?token=<admin token>`)
      return { host, port: address.port }
    },
    async stop() {
      poller.stop()
      if (stateTimer) clearInterval(stateTimer)
      stateTimer = null
      router.saveState()
      const closing = new Promise(resolve => server.close(() => resolve()))
      // Keep-alive sockets would otherwise hold close() open for the full
      // timeout after the last client response.
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      await closing
    },
    describe() {
      return {
        host: lanAddressHint(config.server.host),
        port: config.server.port,
        baseUrl: `http://${lanAddressHint(config.server.host)}:${config.server.port}/v1`,
        hostname: hostname(),
      }
    },
  }
}
