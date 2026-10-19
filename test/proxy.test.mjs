import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createProxyServer, isLoopbackOrigin, upstreamPathFor } from '../electron/core/proxy.js'

async function startUpstream(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

async function startProxy(options) {
  const proxy = createProxyServer(options)
  const info = await proxy.start(0)
  return { proxy, info }
}

function bodyText(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

test('path mapping accepts both /v1-prefixed and bare paths', () => {
  assert.equal(upstreamPathFor('/v1/chat/completions'), '/chat/completions')
  assert.equal(upstreamPathFor('/chat/completions'), '/chat/completions')
  assert.equal(upstreamPathFor('/v1'), '/')
  assert.equal(upstreamPathFor('/v1/models'), '/models')
})

test('a quota 429 rotates accounts and the streaming reply still arrives', async t => {
  const seen = []
  const upstream = await startUpstream(async (req, res) => {
    const auth = req.headers.authorization
    const body = await bodyText(req)
    seen.push({ url: req.url, auth, body })
    if (auth === 'Bearer key-one') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'quota exceeded for this account' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"delta":"hi"}\n\n')
    setTimeout(() => { res.write('data: [DONE]\n\n'); res.end() }, 20)
  })
  const keys = {
    one: { id: 'one', label: '主号', secret: 'key-one' },
    two: { id: 'two', label: '备用', secret: 'key-two' },
  }
  let active = 'one'
  const rotations = []
  const { proxy, info } = await startProxy({
    upstreamBase: upstream.base,
    resolveKey: async () => keys[active],
    onFailure: async (id, code) => {
      if (code === 'QUOTA' && id === 'one') {
        active = 'two'
        const rotation = { from: id, to: 'two', reason: 'quota' }
        rotations.push(rotation)
        return rotation
      }
      return null
    },
  })
  t.after(async () => { await proxy.stop(); await upstream.close() })

  const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
    body: JSON.stringify({ model: 'test', messages: [] }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-pool-key-id'), 'two')
  const text = await response.text()
  assert.match(text, /\[DONE\]/)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].url, '/v1/chat/completions')
  assert.equal(seen[0].auth, 'Bearer key-one')
  assert.equal(seen[1].auth, 'Bearer key-two')
  assert.equal(seen[0].body, JSON.stringify({ model: 'test', messages: [] }))
  assert.equal(rotations.length, 1)
})

test('an empty pool answers 503 with a coded error', async t => {
  const upstream = await startUpstream((req, res) => res.end('never'))
  const { proxy, info } = await startProxy({
    upstreamBase: upstream.base,
    resolveKey: async () => null,
    onFailure: async () => null,
  })
  t.after(async () => { await proxy.stop(); await upstream.close() })

  const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, { method: 'POST' })
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.error.code, 'no_usable_key')
})

test('a 400 client error is passed straight through and does not rotate', async t => {
  let calls = 0
  const upstream = await startUpstream((req, res) => {
    calls += 1
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad request' } }))
  })
  let rotations = 0
  const { proxy, info } = await startProxy({
    upstreamBase: upstream.base,
    resolveKey: async () => ({ id: 'one', label: '主号', secret: 'key' }),
    onFailure: async () => { rotations += 1; return null },
  })
  t.after(async () => { await proxy.stop(); await upstream.close() })

  const response = await fetch(`http://127.0.0.1:${info.port}/v1/models`, { method: 'GET' })
  assert.equal(response.status, 400)
  assert.equal(calls, 1)
  assert.equal(rotations, 0)
  const body = await response.json()
  assert.match(body.error.message, /bad request/)
})

test('a rate-limit 429 is retried on the same key before failing', async t => {
  let calls = 0
  const upstream = await startUpstream((req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded, please slow down' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const { proxy, info } = await startProxy({
    upstreamBase: upstream.base,
    resolveKey: async () => ({ id: 'one', label: '主号', secret: 'key' }),
    onFailure: async () => null,
  })
  t.after(async () => { await proxy.stop(); await upstream.close() })

  const response = await fetch(`http://127.0.0.1:${info.port}/v1/models`)
  assert.equal(response.status, 200)
  assert.equal(calls, 2)
})

test('local health endpoint reports the pool', async t => {
  const upstream = await startUpstream((req, res) => res.end())
  const { proxy, info } = await startProxy({
    upstreamBase: upstream.base,
    resolveKey: async () => null,
    onFailure: async () => null,
    status: () => ({ activeId: 'one', accounts: [{ id: 'one', label: '主号' }] }),
  })
  t.after(async () => { await proxy.stop(); await upstream.close() })

  const response = await fetch(`http://127.0.0.1:${info.port}/pool/health`)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.activeId, 'one')
  assert.equal(body.accounts.length, 1)
})

test('only loopback web origins get CORS', () => {
  assert.equal(isLoopbackOrigin('http://localhost:5173'), true)
  assert.equal(isLoopbackOrigin('http://127.0.0.1:3000'), true)
  assert.equal(isLoopbackOrigin('https://evil.example'), false)
  assert.equal(isLoopbackOrigin('null'), false)
})

test('a cross-origin preflight from a website is rejected', async t => {
  const upstream = await startUpstream((req, res) => res.end())
  const { proxy, info } = await startProxy({
    upstreamBase: upstream.base,
    resolveKey: async () => ({ id: 'one', label: 'x', secret: 'k' }),
    onFailure: async () => null,
  })
  t.after(async () => { await proxy.stop(); await upstream.close() })

  const evil = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  })
  assert.equal(evil.status, 403)

  const local = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  })
  assert.equal(local.status, 204)
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173')
})
