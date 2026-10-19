/**
 * Local OpenAI-compatible proxy in front of the OpenCode Go API.
 *
 * Clients point their Base URL at http://127.0.0.1:<port>/v1 and send any
 * placeholder key. Every request is forwarded with the pool's active key; a
 * 401/403/402/429/5xx before the response starts rotates the account and
 * retries, so chats survive a quota wall. Streaming responses are piped, never
 * buffered.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  classifyNetworkError,
  classifyResponse,
  describeFailure,
  REGION_CODE,
} from './failures.js'

const HOP_BY_HOP = new Set([
  'host', 'authorization', 'content-length', 'connection', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
  'transfer-encoding', 'upgrade', 'accept-encoding', 'x-api-key', 'x-goog-api-key',
])

const OPENCODE_ORIGIN = 'https://opencode.ai'
const GENERIC_USER_AGENT = /^(curl|wget|python-requests|python-urllib|node|undici|go-http-client|okhttp|axios|powershell|java|libwww)/i

/**
 * Resolve one incoming path to the OpenCode origin.
 *
 * The gateway speaks the four native protocols by path, no body rewriting:
 *   /openai/v1/...     -> /inference/go/openai/v1/...
 *   /anthropic/v1/...  -> /inference/go/anthropic/v1/...
 *   /google/v1beta/... -> /inference/go/google/v1beta/...
 *   /inference/go/...  -> forwarded verbatim
 *   /v1/...            -> legacy alias for /inference/go/openai/v1/...
 */
export function gatewayTarget(pathname, search = '') {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.delete('key') // Google SDKs put the key in the query; the gateway injects a header instead
  const qs = params.toString() ? `?${params.toString()}` : ''
  let path = pathname || '/'

  // One documented catalog endpoint serves every protocol; keep /models
  // working on each protocol base instead of letting it 404 upstream.
  if (path === '/openai/v1/models' || path === '/anthropic/v1/models' || path === '/google/v1beta/models') {
    return `${OPENCODE_ORIGIN}/inference/go/v1/models${qs}`
  }
  if (path.startsWith('/inference/go/') || path.startsWith('/zen/go/')) {
    return `${OPENCODE_ORIGIN}${path}${qs}`
  }
  if (path === '/openai' || path === '/openai/') path = '/openai/v1'
  if (path.startsWith('/openai/')) return `${OPENCODE_ORIGIN}/inference/go${path}${qs}`
  if (path === '/anthropic' || path === '/anthropic/') path = '/anthropic/v1'
  if (path.startsWith('/anthropic/')) return `${OPENCODE_ORIGIN}/inference/go${path}${qs}`
  if (path === '/google' || path === '/google/') path = '/google/v1beta'
  if (path.startsWith('/google/')) return `${OPENCODE_ORIGIN}/inference/go${path}${qs}`

  if (path === '/v1' || path === '/v1/') path = '/v1/models'
  const rest = path.startsWith('/v1/') ? path.slice(3) : path
  return `${OPENCODE_ORIGIN}/inference/go/openai/v1${rest}${qs}`
}

/**
 * Build upstream headers for one attempt: the active key, the session header
 * OpenCode Go requires, and a non-generic user agent when the client sent one
 * of the library defaults OpenCode's abuse filter dislikes.
 */
export function gatewayHeaders(input, secret, sessionId, pathname = '') {
  const headers = { ...input }
  headers.authorization = `Bearer ${secret}`
  const anthropic = pathname.includes('/anthropic')
  const google = pathname.includes('/google')
  if (anthropic) {
    headers['x-api-key'] = secret
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  }
  if (google) headers['x-goog-api-key'] = secret
  if (!headers['x-opencode-session']) headers['x-opencode-session'] = sessionId
  const ua = String(headers['user-agent'] || '')
  if (ua.length === 0 || GENERIC_USER_AGENT.test(ua)) headers['user-agent'] = 'opencode-go-pool/1.0'
  return headers
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Read an upstream error body, but never let a stuck body hang the client. */
async function readTextSafely(response, timeoutMs = 5000) {
  let timer
  try {
    const text = await Promise.race([
      response.text(),
      new Promise(resolve => {
        timer = setTimeout(async () => {
          try {
            await response.body?.cancel?.()
          } catch {
            // ignore
          }
          resolve('')
        }, timeoutMs)
      }),
    ])
    return text
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

function readBody(req, limit = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Only loopback web origins may read proxy responses (blocks drive-by quota use). */
export function isLoopbackOrigin(origin) {
  try {
    const url = new URL(String(origin))
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
      : false
  } catch {
    return false
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && isLoopbackOrigin(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    return true
  }
  return false
}

function errorPayload(code, message, extra = {}) {
  return {
    error: {
      message,
      type: code,
      code: code.toLowerCase(),
      ...extra,
    },
  }
}

/** Map a client path onto the upstream base, accepting /v1-prefixed and bare paths. */
export function upstreamPathFor(pathname) {
  if (pathname === '/' || pathname === '/v1' || pathname === '/v1/') return '/'
  if (pathname.startsWith('/v1/')) return pathname.slice(3)
  return pathname
}

/**
 * @param {object} options
 * @param {string} [options.upstreamBase] - fixed upstream base for tests; when omitted the native OpenCode gateway is used.
 * @param {() => Promise<{id: string, label: string, secret: string}|null>} options.resolveKey
 * @param {(id: string, code: string, message: string) => Promise<object|null>} options.onFailure
 * @param {(id: string) => void} [options.onSuccess]
 * @param {(entry: object) => void} [options.onEvent]
 * @param {() => object} [options.status]
 * @param {(id: string) => object} [options.switchTo]
 * @param {() => object} [options.cycle]
 * @param {number} [options.maxAttempts]
 * @param {number} [options.headersTimeoutMs]
 * @param {string} [options.sessionId]
 */
export function createProxyServer({
  upstreamBase = null,
  resolveKey,
  onFailure,
  onSuccess = () => {},
  onEvent = () => {},
  status = () => ({}),
  switchTo = () => null,
  cycle = () => null,
  maxAttempts = 8,
  headersTimeoutMs = 120000,
  sessionId = `sess-${randomUUID()}`,
}) {
  let startedAt = null

  function log(message, level = 'info') {
    if (process.env.POOL_DEBUG) console.log(`[proxy:${level}] ${message}`)
    onEvent({ level, message, at: new Date().toISOString() })
  }

  async function forward(req, url, body, key, signal) {
    const base = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name)) continue
      base[name] = value
    }
    const headers = gatewayHeaders(base, key.secret, sessionId, url.pathname)
    headers['accept-encoding'] = 'identity'
    if (body.length > 0) headers['content-length'] = String(body.length)
    const target = upstreamBase
      ? `${upstreamBase.replace(/\/+$/, '')}${upstreamPathFor(url.pathname)}${url.search}`
      : gatewayTarget(url.pathname, url.search)
    const timer = setTimeout(() => signal.controller.abort(), headersTimeoutMs)
    if (process.env.POOL_DEBUG) {
      const redacted = { ...headers, authorization: 'Bearer ***', 'x-api-key': '***', 'x-goog-api-key': '***' }
      console.log('[proxy:debug] ->', req.method, target, JSON.stringify(redacted))
      console.log('[proxy:debug] body', body.length, JSON.stringify(body.toString('utf8').slice(0, 300)))
    }
    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
        signal: signal.controller.signal,
        redirect: 'manual',
      })
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  async function pipeResponse(response, res, key, attempts) {
    if (res.writableEnded) return
    const headers = {
      'content-type': response.headers.get('content-type') || 'application/json',
      'cache-control': response.headers.get('cache-control') || 'no-cache',
      'x-pool-key-id': key.id,
      'x-pool-key-label': encodeURIComponent(key.label),
      'x-pool-attempts': String(attempts),
    }
    const type = headers['content-type']
    if (type.includes('text/event-stream')) {
      headers['cache-control'] = 'no-cache, no-transform'
      headers.connection = 'keep-alive'
      headers['x-accel-buffering'] = 'no'
    }
    res.writeHead(response.status, headers)
    if (!response.body) {
      res.end()
      return
    }
    const stream = Readable.fromWeb(response.body)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const method = req.method || 'GET'
    const corsAllowed = applyCors(req, res)

    if (method === 'OPTIONS') {
      if (!corsAllowed) {
        writeJson(res, 403, errorPayload('CORS_DENIED', 'cross-origin callers must be loopback web apps'))
        return
      }
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, x-pool-token',
        'access-control-max-age': '600',
      })
      res.end()
      return
    }

    if (url.pathname === '/pool/health') {
      writeJson(res, 200, {
        ok: true,
        name: 'opencode-go-pool',
        uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        ...status(),
      })
      return
    }

    if (url.pathname === '/pool/usage') {
      writeJson(res, 200, status())
      return
    }

    if (url.pathname === '/pool/switch' && method === 'POST') {
      let payload = {}
      try {
        const raw = await readBody(req, 64 * 1024)
        if (raw.length > 0) payload = JSON.parse(raw.toString('utf8'))
      } catch {
        writeJson(res, 400, errorPayload('BAD_REQUEST', 'request body must be JSON'))
        return
      }
      try {
        const result = payload && payload.direction === 'next'
          ? cycle()
          : switchTo(String(payload?.id ?? ''))
        writeJson(res, 200, { ok: true, activeId: result?.to ?? status()?.activeId ?? null, switch: result ?? null })
      } catch (error) {
        writeJson(res, 409, errorPayload('SWITCH_FAILED', String((error && error.message) || error)))
      }
      return
    }

    if (url.pathname === '/') {
      writeJson(res, 200, {
        name: 'OpenCode Go Pool proxy',
        usage: 'point your client Base URL at /v1',
        health: '/pool/health',
        usageReport: '/pool/usage',
      })
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      writeJson(res, 413, errorPayload('BODY_TOO_LARGE', String((error && error.message) || error)))
      return
    }

    const clientClosed = new AbortController()
    let closed = false
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true
        clientClosed.abort()
      }
    })

    let sameKeyRetries = 0
    let lastCode = 'QUOTA'
    let lastMessage = 'no usable account in the pool'

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (closed) return
      let key
      try {
        key = await resolveKey()
      } catch (error) {
        writeJson(res, 500, errorPayload('POOL_ERROR', String((error && error.message) || error)))
        return
      }
      if (!key) {
        log(`请求被拒绝：池中没有可用账号（${describeFailure(lastCode)}）`, 'warn')
        writeJson(res, 503, errorPayload(
          'NO_USABLE_KEY',
          `OpenCode Go Pool: 没有可用账号（最后一个失败：${describeFailure(lastCode)} — ${lastMessage}）`,
          { lastFailure: lastCode, lastMessage },
        ))
        return
      }

      let response
      try {
        response = await forward(req, url, body, key, { controller: clientClosed })
      } catch (error) {
        if (closed) return
        lastCode = classifyNetworkError()
        lastMessage = String((error && error.message) || error)
        log(`账号 ${key.label} 网络失败：${lastMessage}`, 'warn')
        const rotation = await onFailure(key.id, lastCode, lastMessage)
        if (rotation) {
          log(`已切换 ${key.label} → ${rotation.to ?? '（无可用）'}（${describeFailure(lastCode)}）`, 'warn')
          sameKeyRetries = 0
          continue
        }
        if (sameKeyRetries++ >= 1) {
          writeJson(res, 502, errorPayload('UPSTREAM_UNREACHABLE', lastMessage))
          return
        }
        await sleep(400)
        continue
      }

      if (response.status < 400) {
        onSuccess(key.id)
        await pipeResponse(response, res, key, attempt + 1)
        return
      }

      const text = await readTextSafely(response)
      if (process.env.POOL_DEBUG) {
        console.log('[proxy:debug] <-', response.status, JSON.stringify(Object.fromEntries(response.headers.entries())))
      }
      log(`上游 HTTP ${response.status}（${response.headers.get('content-type') || '无 content-type'}）：${text.slice(0, 300) || '(空响应)'}`, 'warn')
      const code = classifyResponse(response.status, text)
      // REGION is a model-level restriction: pass it through untouched, do not
      // burn the account or rotate to another key (the next key is just as
      // blocked in this country).
      if (code === null || code === REGION_CODE) {
        if (!res.writableEnded) {
          res.writeHead(response.status, {
            'content-type': response.headers.get('content-type') || 'application/json',
            'cache-control': 'no-store',
          })
          res.end(text)
        }
        return
      }

      lastCode = code
      lastMessage = text.slice(0, 300) || `HTTP ${response.status}`
      log(`账号 ${key.label} 失败 HTTP ${response.status}：${describeFailure(code)}`, 'warn')
      const rotation = await onFailure(key.id, code, lastMessage)
      if (rotation) {
        log(`已切换 ${key.label} → ${rotation.to ?? '（无可用）'}（${describeFailure(code)}）`, 'warn')
        sameKeyRetries = 0
        continue
      }
      // Transient codes can be retried on the same key when the pool's
      // consecutive-failure threshold has not tripped yet.
      if ((code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TRANSPORT') && sameKeyRetries < 1) {
        sameKeyRetries += 1
        await sleep(600)
        continue
      }
      writeJson(res, response.status, {
        error: {
          message: lastMessage,
          type: code,
          pool: 'opencode-go-pool',
        },
      })
      return
    }

    writeJson(res, 502, errorPayload(
      'POOL_EXHAUSTED',
      `OpenCode Go Pool: 尝试了 ${maxAttempts} 次仍未成功（最后失败：${describeFailure(lastCode)}）`,
      { lastFailure: lastCode },
    ))
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      log(`代理内部错误：${String((error && error.stack) || error)}`, 'error')
      writeJson(res, 500, errorPayload('PROXY_ERROR', String((error && error.message) || error)))
    })
  })
  // Long generations can idle; keep the socket alive but bounded.
  server.requestTimeout = 0
  server.headersTimeout = 65000

  return {
    server,
    /** @returns {Promise<{port: number, host: string}>} */
    start(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening)
          reject(Object.assign(error, { code: error.code || 'LISTEN_FAILED' }))
        }
        const onListening = () => {
          server.off('error', onError)
          startedAt = Date.now()
          const address = server.address()
          const actualPort = typeof address === 'object' && address ? address.port : port
          log(`本地代理已启动：http://${host}:${actualPort}/v1`)
          resolve({ port: actualPort, host })
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    stop() {
      return new Promise(resolve => {
        startedAt = null
        try {
          server.closeAllConnections?.()
        } catch {
          // best effort
        }
        server.close(() => resolve())
      })
    },
  }
}
