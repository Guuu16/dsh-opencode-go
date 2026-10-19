import test from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '../src/util.mjs'
import {
  ADMIN_TOKEN,
  CLIENT_TOKEN,
  bootGateway,
  json,
  makeConfig,
  openAICompletion,
  openAIStreamEvents,
  sseWrite,
  startFake,
  tempHome,
} from './fake.mjs'

tempHome()

const MODELS = {
  'GET /v1/models': 'list',
}

function modelsRoute(items) {
  return ({ res }) => json(res, 200, { object: 'list', data: items.map(id => ({ id, object: 'model' })) })
}

function openAIUpstream({ keyBehaviour }) {
  return startFake({
    'GET /v1/models': modelsRoute(['test-model']),
    'POST /v1/chat/completions': ({ res, body, key }) => {
      const behaviour = keyBehaviour(key, body)
      if (behaviour === 'rate-limit') {
        json(res, 429, { error: { message: 'quota exhausted for this key', type: 'rate_limit_error' } })
        return
      }
      if (behaviour === 'server') {
        json(res, 503, { error: { message: 'upstream is down' } })
        return
      }
      if (behaviour === 'bad-request') {
        json(res, 400, { error: { message: 'tool schema invalid' } })
        return
      }
      if (behaviour === 'auth') {
        json(res, 401, { error: { message: 'invalid api key' } })
        return
      }
      if (body.stream) {
        sseWrite(res, openAIStreamEvents({ model: body.model, pieces: ['你', '好'] }))
        return
      }
      json(res, 200, openAICompletion({ model: body.model, content: `pong:${key}` }))
    },
  })
}

test('auth: missing, wrong, disabled tokens are rejected', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const anonymous = await gw.request('/v1/models', { token: null, method: 'GET' })
    assert.equal(anonymous.status, 401)

    const wrong = await gw.request('/v1/models', { token: 'sk-aipool-nope', method: 'GET' })
    assert.equal(wrong.status, 401)

    const client = await gw.request('/v1/models', { method: 'GET' })
    assert.equal(client.status, 200)
    const list = await client.json()
    const ids = list.data.map(entry => entry.id)
    assert.ok(ids.includes('test-model'))
    assert.ok(ids.includes('p1/test-model'))
    assert.ok(ids.includes('auto'))

    const adminWithout = await gw.request('/admin/status', { token: CLIENT_TOKEN })
    assert.equal(adminWithout.status, 401)
    const adminWith = await gw.request('/admin/status', { token: ADMIN_TOKEN })
    assert.equal(adminWith.status, 200)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('non-stream completion passes through with a route header and usage', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-aipool-route'), 'p1/k1')
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'pong:sk-a')
    assert.equal(upstream.requests.find(entry => entry.url === '/v1/chat/completions').body.model, 'test-model')
    assert.equal(gw.gateway.router.counters.ok, 1)
    assert.equal(gw.gateway.router.counters.tokensIn, 7)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a quota failure rotates to the next key inside one request', async () => {
  const upstream = await openAIUpstream({
    keyBehaviour: key => (key === 'sk-a' ? 'rate-limit' : 'ok'),
  })
  const config = makeConfig({
    providers: [{
      id: 'p1',
      type: 'openai',
      baseUrl: `${upstream.url}/v1`,
      models: [{ id: 'test-model' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-a' }, { id: 'k2', label: 'B', key: 'sk-b' }],
    }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-aipool-attempts'), '2')
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'pong:sk-b')

    const calls = upstream.requests.filter(entry => entry.url === '/v1/chat/completions')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].key, 'sk-a')
    assert.equal(calls[1].key, 'sk-b')
    assert.equal(gw.gateway.router.counters.retries, 1)
    const snapshot = gw.gateway.router.snapshot()
    assert.equal(snapshot.providers[0].keys[0].state, 'exhausted')
    assert.equal(snapshot.providers[0].keys[0].lastError.code, 'QUOTA')
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a bare model id fails over across providers', async () => {
  const bad = await openAIUpstream({ keyBehaviour: () => 'server' })
  const good = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [
      { id: 'primary', type: 'openai', priority: 10, baseUrl: `${bad.url}/v1`, models: [{ id: 'shared-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-bad' }] },
      { id: 'backup', type: 'openai', priority: 20, baseUrl: `${good.url}/v1`, models: [{ id: 'shared-model' }], keys: [{ id: 'k1', label: 'B', key: 'sk-good' }] },
    ],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-aipool-route'), 'backup/k1')
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'pong:sk-good')
    assert.equal(bad.requests.filter(entry => entry.method === 'POST').length, 1)
  } finally {
    await gw.close()
    await bad.close()
    await good.close()
  }
})

test('a client-side 400 is never retried', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'bad-request' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }, { id: 'k2', label: 'B', key: 'sk-b' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.match(body.error.message, /tool schema invalid/)
    assert.equal(upstream.requests.filter(entry => entry.method === 'POST').length, 1)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('openai streaming passes through and records usage', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /event-stream/)
    const text = await response.text()
    assert.match(text, /"content":"你"/)
    assert.match(text, /\[DONE\]/)
    assert.equal(gw.gateway.router.counters.ok, 1)
    assert.equal(gw.gateway.router.counters.tokensOut, 2)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('an Anthropic upstream serves an OpenAI client', async () => {
  const upstream = await startFake({
    'GET /v1/models': modelsRoute(['claude-test']),
    'POST /v1/messages': ({ res, body }) => {
      assert.equal(body.model, 'claude-test')
      if (body.stream) {
        sseWrite(res, [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":6}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ])
        return
      }
      json(res, 200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'from anthropic' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6, output_tokens: 3 },
      })
    },
  })
  const config = makeConfig({
    providers: [{
      id: 'anthropic-up',
      type: 'anthropic',
      baseUrl: upstream.url,
      chatPath: '/v1/messages',
      authHeader: 'x-api-key',
      models: [{ id: 'claude-test' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-ant' }],
    }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'claude-test', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'from anthropic')
    assert.equal(body.usage.prompt_tokens, 6)

    const upstreamCall = upstream.requests.find(entry => entry.url === '/v1/messages')
    assert.equal(upstreamCall.headers['x-api-key'], 'sk-ant')
    assert.equal(upstreamCall.body.system, 'be nice')

    const streamResponse = await gw.request('/v1/chat/completions', {
      body: { model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    const text = await streamResponse.text()
    assert.match(text, /"content":"hello"/)
    assert.match(text, /\[DONE\]/)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('an OpenAI upstream serves an Anthropic client, including streaming', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/messages', {
      body: { model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.type, 'message')
    assert.equal(body.content[0].text, 'pong:sk-a')
    assert.equal(body.usage.input_tokens, 7)

    const streamResponse = await gw.request('/v1/messages', {
      body: { model: 'test-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(streamResponse.status, 200)
    const text = await streamResponse.text()
    assert.match(text, /event: message_start/)
    assert.match(text, /event: content_block_delta/)
    assert.match(text, /"text":"你"/)
    assert.match(text, /event: message_stop/)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('admin actions reset and disable keys', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: key => (key === 'sk-a' ? 'rate-limit' : 'ok') })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }, { id: 'k2', label: 'B', key: 'sk-b' }] }],
  })
  const gw = await bootGateway(config)
  try {
    await gw.request('/v1/chat/completions', { body: { model: 'test-model', messages: [{ role: 'user', content: 'x' }] } })
    let status = await gw.json('/admin/status', { token: ADMIN_TOKEN, method: 'GET' })
    assert.equal(status.body.providers[0].keys[0].state, 'exhausted')

    const reset = await gw.json('/admin/action', {
      token: ADMIN_TOKEN,
      body: { action: 'resetKey', provider: 'p1', key: 'k1' },
    })
    assert.equal(reset.body.ok, true)
    status = await gw.json('/admin/status', { token: ADMIN_TOKEN, method: 'GET' })
    assert.equal(status.body.providers[0].keys[0].state, 'healthy')

    const disable = await gw.json('/admin/action', {
      token: ADMIN_TOKEN,
      body: { action: 'disableKey', provider: 'p1', key: 'k2' },
    })
    assert.equal(disable.body.ok, true)
    status = await gw.json('/admin/status', { token: ADMIN_TOKEN, method: 'GET' })
    assert.equal(status.body.providers[0].keys[1].state, 'disabled')
    assert.equal(status.body.providers[0].keys[1].enabled, false)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('an unknown model is a 404 with a hint, not a crash', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error.code, 'MODEL_NOT_FOUND')
    assert.match(body.error.message, /provider\/model/)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('the usage probe feeds quota into the pool and revives keys', async () => {
  const upstream = await startFake({
    'GET /v1/models': modelsRoute(['test-model']),
    'GET /v1/usage': ({ res }) => json(res, 200, {
      usage: { rolling: { status: 'ok', percent: 3, resetsAt: new Date(Date.now() + 3600_000).toISOString() }, weekly: { percent: 10 }, monthly: { percent: 1 } },
    }),
    'POST /v1/chat/completions': ({ res }) => json(res, 200, openAICompletion()),
  })
  const config = makeConfig({
    providers: [{
      id: 'p1',
      type: 'openai',
      baseUrl: `${upstream.url}/v1`,
      usageUrl: `${upstream.url}/v1/usage`,
      preemptAtPercent: 90,
      models: [{ id: 'test-model' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-a' }],
    }],
  })
  const gw = await bootGateway(config)
  try {
    const pool = gw.gateway.router.pool('p1')
    const key = pool.pick()
    pool.onFailure(key.id, { kind: 'quota', code: 'QUOTA', rotateKey: true, cooldownMs: 600_000, message: 'x' })
    assert.equal(pool.stateOf(key.id).state, 'exhausted')
    await gw.gateway.poller.run({ force: true })
    assert.equal(pool.stateOf(key.id).state, 'healthy')
    assert.equal(pool.stateOf(key.id).quota.rolling.percent, 3)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a scoped token sees and uses only its models', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{
      id: 'p1',
      type: 'openai',
      baseUrl: `${upstream.url}/v1`,
      models: [{ id: 'test-model' }, { id: 'other-model' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-a' }],
    }],
    routing: { defaultModel: 'test-model' },
    tokens: [{
      id: 'tk_scoped',
      name: 'scoped',
      hash: sha256(CLIENT_TOKEN),
      createdAt: new Date().toISOString(),
      requests: 0,
      disabled: false,
      models: ['test-model'],
    }],
  })
  const gw = await bootGateway(config)
  try {
    // Omitting the model must fall back to routing.defaultModel, not 403.
    const implicit = await gw.request('/v1/chat/completions', {
      body: { messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(implicit.status, 200)

    const denied = await gw.request('/v1/chat/completions', {
      body: { model: 'other-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'MODEL_NOT_ALLOWED')

    const list = await gw.json('/v1/models', { method: 'GET' })
    assert.deepEqual(list.body.data.map(entry => entry.id), ['test-model'])
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('an oversized body is a 413, not a reset connection', async () => {
  const upstream = await openAIUpstream({ keyBehaviour: () => 'ok' })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
    server: { maxBodyBytes: 1024 },
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(8000) }] },
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE')
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a stalled upstream stream times out instead of hanging the client', async () => {
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'start' }, finish_reason: null }] })}\n\n`)
      // …and then nothing. The socket stays open on purpose.
    },
  })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
    routing: { streamIdleTimeoutMs: 1000, requestTimeoutMs: 10_000 },
  })
  const gw = await bootGateway(config)
  try {
    const started = Date.now()
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      headers: {},
    })
    const text = await response.text()
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5000, `stream closed after ${elapsed}ms`)
    assert.match(text, /start/)
    assert.match(text, /没有新数据|error/)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a client disconnect stops the upstream stream', async () => {
  let upstreamClosed = false
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) return
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] })}\n\n`)
      }, 40)
      res.on('close', () => {
        upstreamClosed = true
        clearInterval(timer)
      })
    },
  })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const controller = new AbortController()
    const response = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CLIENT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    })
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    for (let i = 0; i < 40 && !upstreamClosed; i += 1) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(upstreamClosed, true, 'upstream socket was left open')
    assert.equal(gw.gateway.router.counters.ok, 0, 'aborted request counted as success')
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a 429 waits for the configured backoff before the next key', async () => {
  let calls = 0
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res, body, key }) => {
      calls += 1
      if (key === 'sk-a') return json(res, 429, { error: { message: 'rate limit: 20 rpm' } })
      return json(res, 200, openAICompletion({ model: body.model }))
    },
  })
  const config = makeConfig({
    providers: [{
      id: 'p1',
      type: 'openai',
      baseUrl: `${upstream.url}/v1`,
      models: [{ id: 'test-model' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-a' }, { id: 'k2', label: 'B', key: 'sk-b' }],
    }],
    routing: { retryDelaysMs: [300] },
  })
  const gw = await bootGateway(config)
  try {
    const started = Date.now()
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    const elapsed = Date.now() - started
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-aipool-route'), 'p1/k2')
    assert.ok(elapsed >= 280, `no backoff applied (${elapsed}ms, 2 calls=${calls})`)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('all keys cooling is a 429 with Retry-After, not a 503', async () => {
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res }) => json(res, 429, { error: { message: 'insufficient_quota' } }),
  })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
    routing: { maxAttempts: 1 },
    cooldown: { quotaMs: 60_000, rateLimitMs: 60_000, serverMs: 60_000, transportMs: 60_000, authMs: 60_000 },
  })
  const gw = await bootGateway(config)
  try {
    const first = await gw.request('/v1/chat/completions', { body: { model: 'test-model', messages: [{ role: 'user', content: 'x' }] } })
    assert.equal(first.status, 429)
    const callsAfterFirst = upstream.requests.filter(entry => entry.method === 'POST').length

    const second = await gw.request('/v1/chat/completions', { body: { model: 'test-model', messages: [{ role: 'user', content: 'x' }] } })
    assert.equal(second.status, 429)
    assert.equal((await second.json()).error.code, 'ALL_KEYS_COOLING')
    assert.ok(Number(second.headers.get('retry-after')) > 0)
    assert.equal(upstream.requests.filter(entry => entry.method === 'POST').length, callsAfterFirst, 'still hammering a cooling pool')
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('an upstream that answers 200 then an error still respects maxAttempts', async () => {
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ error: { message: 'upstream exploded', type: 'api_error' } })}\n\n`)
    },
  })
  const config = makeConfig({
    providers: [{
      id: 'p1',
      type: 'openai',
      baseUrl: `${upstream.url}/v1`,
      models: [{ id: 'test-model' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-a' }, { id: 'k2', label: 'B', key: 'sk-b' }, { id: 'k3', label: 'C', key: 'sk-c' }],
    }],
    routing: { maxAttempts: 2, retryDelaysMs: [0] },
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.status, 502)
    const posts = upstream.requests.filter(entry => entry.method === 'POST').length
    assert.equal(posts, 2, `maxAttempts=2 but ${posts} upstream calls were made`)
  } finally {
    await gw.close()
    await upstream.close()
  }
})

test('a mid-stream upstream error is forwarded exactly once', async () => {
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ error: { message: 'connection exploded', type: 'api_error' } })}\n\n`)
      res.end()
    },
  })
  const config = makeConfig({
    providers: [{ id: 'p1', type: 'openai', baseUrl: `${upstream.url}/v1`, models: [{ id: 'test-model' }], keys: [{ id: 'k1', label: 'A', key: 'sk-a' }] }],
  })
  const gw = await bootGateway(config)
  try {
    const response = await gw.request('/v1/chat/completions', {
      body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    const text = await response.text()
    assert.match(text, /half/)
    assert.equal((text.match(/"error"/g) ?? []).length, 1, `duplicate error frames:\n${text}`)
  } finally {
    await gw.close()
    await upstream.close()
  }
})
