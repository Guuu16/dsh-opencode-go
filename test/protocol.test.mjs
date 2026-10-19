import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicRequestToCanonical,
  anthropicResponseToCanonical,
  anthropicStreamToOpenAI,
  buildUpstreamRequest,
  canonicalToAnthropicRequest,
  canonicalToAnthropicResponse,
  emptyStreamContext,
  normalizeResponse,
  openAIStreamToAnthropic,
  passthroughStream,
} from '../src/protocol.mjs'

function streamOf(text) {
  return new Response(text).body
}

async function collect(generator) {
  const parts = []
  for await (const part of generator) parts.push(typeof part === 'string' ? part : Buffer.from(part).toString('utf8'))
  return parts.join('')
}

test('inbound Anthropic request becomes a canonical OpenAI request', () => {
  const canonical = anthropicRequestToCanonical({
    model: 'claude-x',
    max_tokens: 100,
    system: [{ type: 'text', text: 'be brief' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'answer' }] },
    ],
    tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'tool', name: 'lookup' },
    stop_sequences: ['END'],
  })

  assert.equal(canonical.model, 'claude-x')
  assert.equal(canonical.max_tokens, 100)
  assert.deepEqual(canonical.stop, ['END'])
  assert.equal(canonical.messages[0].role, 'system')
  assert.equal(canonical.messages[0].content, 'be brief')
  const user = canonical.messages[1]
  assert.equal(user.content[0].text, 'what is this?')
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,AAA$/)
  const assistant = canonical.messages[2]
  assert.equal(assistant.tool_calls[0].function.name, 'lookup')
  assert.equal(assistant.tool_calls[0].function.arguments, '{"q":"x"}')
  assert.equal(canonical.messages[3].role, 'tool')
  assert.equal(canonical.messages[3].tool_call_id, 'toolu_1')
  assert.equal(canonical.tools[0].function.parameters.type, 'object')
  assert.deepEqual(canonical.tool_choice, { type: 'function', function: { name: 'lookup' } })
})

test('canonical request becomes an Anthropic request with merged turns', () => {
  const body = canonicalToAnthropicRequest({
    model: 'm',
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'sys one' },
      { role: 'system', content: 'sys two' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      { role: 'user', content: 'and?' },
    ],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'required',
  }, 'upstream-model')

  assert.equal(body.model, 'upstream-model')
  assert.equal(body.max_tokens, 256)
  assert.equal(body.system, 'sys one\n\nsys two')
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.messages[1].role, 'assistant')
  assert.equal(body.messages[1].content[1].type, 'tool_use')
  // tool_result and the following user turn merge into ONE user message,
  // because Anthropic rejects consecutive same-role turns.
  assert.equal(body.messages[2].role, 'user')
  assert.equal(body.messages[2].content[0].type, 'tool_result')
  assert.equal(body.messages[2].content[1].text, 'and?')
  assert.equal(body.tools[0].input_schema.type, 'object')
  assert.deepEqual(body.tool_choice, { type: 'any' })
})

test('anthropic responses translate both ways', () => {
  const upstream = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_9', name: 'calc', input: { x: 2 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 12, output_tokens: 5 },
  }
  const canonical = anthropicResponseToCanonical(upstream, 'requested')
  assert.equal(canonical.model, 'requested')
  assert.equal(canonical.choices[0].message.content, 'hello')
  assert.equal(canonical.choices[0].message.tool_calls[0].id, 'toolu_9')
  assert.equal(canonical.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(canonical.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })

  const back = canonicalToAnthropicResponse(canonical, 'requested')
  assert.equal(back.type, 'message')
  assert.equal(back.content[0].text, 'hello')
  assert.equal(back.content[1].type, 'tool_use')
  assert.equal(back.stop_reason, 'tool_use')
  assert.deepEqual(back.usage, { input_tokens: 12, output_tokens: 5 })
})

test('normalizeResponse keeps OpenAI bodies but rewrites the model', () => {
  const { body, usage } = normalizeResponse({
    providerType: 'openai',
    requestedModel: 'my-alias',
    json: {
      id: 'x',
      object: 'chat.completion',
      model: 'upstream-name',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  })
  assert.equal(body.model, 'my-alias')
  assert.equal(body.choices[0].message.content, 'ok')
  assert.deepEqual(usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
})

test('anthropic SSE becomes OpenAI chunks', async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"m","usage":{"input_tokens":9}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const ctx = emptyStreamContext()
  const output = await collect(anthropicStreamToOpenAI(streamOf(sse), { model: 'm', ctx }))
  const payloads = output.split('\n\n').filter(Boolean).map(line => line.replace(/^data: /, ''))
  assert.equal(payloads.at(-1), '[DONE]')
  const frames = payloads.slice(0, -1).map(text => JSON.parse(text))
  assert.equal(frames[0].choices[0].delta.role, 'assistant')
  assert.equal(frames.map(frame => frame.choices?.[0]?.delta?.content ?? '').join(''), 'hello')
  assert.equal(frames.at(-1).choices[0].finish_reason, 'stop')
  assert.equal(ctx.usage.prompt_tokens, 9)
  assert.equal(ctx.usage.completion_tokens, 2)
})

test('OpenAI SSE becomes Anthropic events', async () => {
  const sse = [
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] },
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
    '[DONE]',
  ].map(event => (typeof event === 'string' ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join('')
  const ctx = emptyStreamContext()
  const output = await collect(openAIStreamToAnthropic(streamOf(sse), { model: 'm', ctx }))
  const events = output.split('\n\n').filter(Boolean).map(block => {
    const name = /event: (.*)/.exec(block)?.[1]
    const data = JSON.parse(/data: (.*)/s.exec(block)[1])
    return { name, data }
  })
  assert.equal(events[0].name, 'message_start')
  assert.equal(events.at(-1).name, 'message_stop')
  const text = events.filter(event => event.name === 'content_block_delta').map(event => event.data.delta.text).join('')
  assert.equal(text, 'hi')
  const delta = events.find(event => event.name === 'message_delta')
  assert.equal(delta.data.delta.stop_reason, 'end_turn')
  assert.equal(delta.data.usage.output_tokens, 1)
  assert.equal(ctx.usage.prompt_tokens, 4)
})

test('passthrough forwards bytes untouched and still reads usage', async () => {
  const original = 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
  const ctx = emptyStreamContext()
  const output = await collect(passthroughStream(streamOf(original), { providerType: 'openai', ctx }))
  assert.equal(output, original)
  assert.equal(ctx.usage.prompt_tokens, 2)
  assert.equal(ctx.usage.completion_tokens, 1)
})

test('a provider can opt out of stream_options and still stream', () => {
  const provider = {
    type: 'openai',
    baseUrl: 'http://127.0.0.1:1/v1',
    chatPath: '/chat/completions',
    authHeader: 'bearer',
    headers: {},
    streamUsage: false,
  }
  const request = buildUpstreamRequest({
    provider,
    apiKey: 'sk',
    modelId: 'm',
    canonical: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    signal: AbortSignal.timeout(1000),
  })
  assert.equal(request.init.body.includes('stream_options'), false)
  const withUsage = buildUpstreamRequest({
    provider: { ...provider, streamUsage: true },
    apiKey: 'sk',
    modelId: 'm',
    canonical: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    signal: AbortSignal.timeout(1000),
  })
  assert.match(withUsage.init.body, /"include_usage":true/)
})
