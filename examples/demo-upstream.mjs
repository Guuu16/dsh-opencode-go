#!/usr/bin/env node
/**
 * 零 Key 试跑用的假上游：同时说 OpenAI 和 Anthropic 两种协议。
 *
 *   node examples/demo-upstream.mjs --port 18081
 *
 * Key 策略（故意做出来演示自动切换）：
 *   含 "exhausted" → 429（配额耗尽，aipool 会切到下一个 key）
 *   含 "invalid"   → 401（凭据失效，aipool 会标记 invalid 并切走）
 *   其它            → 正常回复，回显最后一条用户消息
 *
 * 端点：
 *   GET  /v1/models              列表
 *   POST /v1/chat/completions    OpenAI（stream 支持）
 *   POST /v1/messages            Anthropic（stream 支持）
 *   GET  /v1/usage               配额（滚动窗口随机 0–100%）
 */

import { createServer } from 'node:http'

const portIndex = process.argv.indexOf('--port')
const PORT = portIndex > -1 ? Number(process.argv[portIndex + 1]) : 18081

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
  })
}

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content.filter(part => part?.type === 'text').map(part => part.text).join(' ')
    }
  }
  return ''
}

function keyOf(req) {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
}

function reject(res, key, dialect) {
  if (key.includes('exhausted')) {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify(dialect === 'anthropic'
      ? { type: 'error', error: { type: 'rate_limit_error', message: 'demo: quota exhausted for this key' } }
      : { error: { message: 'demo: quota exhausted for this key', type: 'rate_limit_error' } }))
    return true
  }
  if (key.includes('invalid')) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify(dialect === 'anthropic'
      ? { type: 'error', error: { type: 'authentication_error', message: 'demo: invalid api key' } }
      : { error: { message: 'demo: invalid api key', type: 'authentication_error' } }))
    return true
  }
  return false
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const key = keyOf(req)
  const tag = key ? `${key.slice(0, 10)}…` : 'no-key'
  process.stdout.write(`${new Date().toISOString()} ${req.method} ${url.pathname} key=${tag}\n`)

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'demo-model', object: 'model', owned_by: 'demo' }],
    }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/v1/usage') {
    const percent = Math.floor(Math.random() * 100)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        weekly: { status: 'ok', percent: Math.floor(percent / 2), resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
        monthly: { status: 'ok', percent: Math.floor(percent / 4), resetsAt: new Date(Date.now() + 15 * 86_400_000).toISOString() },
      },
    }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  const body = await readBody(req)
  const dialect = url.pathname === '/v1/messages' ? 'anthropic' : 'openai'
  if (reject(res, key, dialect)) return

  const prompt = lastUserText(body)
  const reply = `demo(${body.model ?? 'unknown'}) 收到：${prompt.slice(0, 120)}`

  if (dialect === 'openai') {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const id = `chatcmpl-demo-${Date.now()}`
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`)
      for (const piece of reply.match(/.{1,12}/gs) ?? []) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: prompt.length, completion_tokens: reply.length, total_tokens: prompt.length + reply.length } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-demo',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: prompt.length, completion_tokens: reply.length, total_tokens: prompt.length + reply.length },
    }))
    return
  }

  // Anthropic dialect
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const id = `msg_demo_${Date.now()}`
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: prompt.length, output_tokens: 0 } } })}\n\n`)
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
    for (const piece of reply.match(/.{1,12}/gs) ?? []) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })}\n\n`)
    }
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: reply.length } })}\n\n`)
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    id: 'msg_demo',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text: reply }],
    stop_reason: 'end_turn',
    usage: { input_tokens: prompt.length, output_tokens: reply.length },
  }))
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`demo upstream: http://127.0.0.1:${PORT}/v1  (models: demo-model)\n`)
  process.stdout.write(`try keys: sk-good / sk-exhausted / sk-invalid\n`)
})
