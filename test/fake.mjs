/**
 * Test helpers: scripted fake upstreams, config factory, gateway bootstrap.
 * No network, no real keys.
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../src/config.mjs'
import { createGateway } from '../src/server.mjs'
import { sha256 } from '../src/util.mjs'

export const ADMIN_TOKEN = `adm_${'T'.repeat(32)}`
export const CLIENT_TOKEN = 'sk-aipool-test-token-123456'

export function makeConfig({ providers, routing = {}, server = {}, tokens = null, aliases = {} }) {
  return normalizeConfig({
    version: 1,
    server: { host: '127.0.0.1', port: 0, allowFrom: ['127.0.0.1/32'], ...server },
    auth: {
      adminToken: ADMIN_TOKEN,
      tokens: tokens ?? [{
        id: 'tk_test',
        name: 'test-client',
        hash: sha256(CLIENT_TOKEN),
        createdAt: new Date().toISOString(),
        requests: 0,
        disabled: false,
      }],
    },
    routing: { maxAttempts: 4, retryDelaysMs: [0], ...routing },
    cooldown: { rateLimitMs: 50, serverMs: 50, transportMs: 50, authMs: 50, quotaMs: 50 },
    providers,
    aliases,
  })
}

/**
 * Start a fake upstream. `script` maps "METHOD /path" to a handler
 * `({ req, res, body, key, requests }) => void|Promise`.
 */
export async function startFake(script) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
    const entry = { method: req.method, url: req.url, headers: req.headers, body, key }
    requests.push(entry)
    const handler = script[`${req.method} ${req.url}`]
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'no route', type: 'invalid_request_error' } }))
      return
    }
    try {
      await handler({ req, res, body, key, requests, entry })
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: error.message } }))
      }
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    requests,
    close: () => {
      server.closeAllConnections?.()
      return new Promise(resolve => server.close(resolve))
    },
  }
}

export function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function openAICompletion({ model = 'test-model', content = 'pong', usage = { prompt_tokens: 7, completion_tokens: 3 } } = {}) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  }
}

export function sseWrite(res, events, { delayMs = 0 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  let index = 0
  const push = () => {
    if (index >= events.length) {
      res.end()
      return
    }
    const event = events[index]
    index += 1
    res.write(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`)
    if (delayMs > 0) setTimeout(push, delayMs)
    else push()
  }
  push()
}

export function openAIStreamEvents({ model = 'test-model', pieces = ['hello'], usage = { prompt_tokens: 5, completion_tokens: 2 } } = {}) {
  const events = [
    { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  ]
  for (const piece of pieces) {
    events.push({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
  }
  events.push({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  })
  events.push('[DONE]')
  return events
}

export async function bootGateway(config, { restoreState = false } = {}) {
  const gateway = await createGateway({ config, restoreState })
  const address = await gateway.start()
  const base = `http://127.0.0.1:${address.port}`
  return {
    gateway,
    base,
    async close() {
      await gateway.stop()
    },
    async request(path, { method = 'POST', body = null, token = CLIENT_TOKEN, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      return response
    },
    async json(path, options) {
      const response = await this.request(path, options)
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = text
      }
      return { status: response.status, headers: response.headers, body: json }
    },
  }
}

export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'aipool-test-'))
  process.env.AIPOOL_HOME = dir
  return dir
}
