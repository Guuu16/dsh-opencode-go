/**
 * Wire protocol: OpenAI Chat Completions ⇄ Anthropic Messages.
 *
 * The gateway's canonical request/response is the OpenAI shape. Everything
 * that differs per upstream lives here:
 *   - request translation (tools, images, system prompts, token limits)
 *   - non-stream response translation
 *   - SSE stream translation in both directions
 *   - passthrough tapping (same dialect: forward bytes untouched, still read
 *     usage/finish/error out of the event stream)
 */

import { randomBytes } from 'node:crypto'

const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

export function joinUrl(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '')
  const suffix = String(path).startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

export function shortId(prefix) {
  return `${prefix}${randomBytes(8).toString('hex')}`
}

function safeParse(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---- SSE plumbing ----------------------------------------------------------

/** Parse a `text/event-stream` body into `{event, data}` records. */
export async function* parseSSE(readable) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of readable) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const record = parseBlock(block)
      if (record) yield record
    }
  }
  buffer += decoder.decode().replace(/\r/g, '')
  if (buffer.trim().length > 0) {
    const record = parseBlock(buffer)
    if (record) yield record
  }
}

function parseBlock(block) {
  const lines = block.split('\n')
  let event = null
  const data = []
  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

export function sseData(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
}

export function sseEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

// ---- usage -----------------------------------------------------------------

const EMPTY_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

export function usageFromOpenAI(usage) {
  if (!usage || typeof usage !== 'object') return { ...EMPTY_USAGE }
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens ?? prompt + completion) || prompt + completion,
  }
}

export function usageFromAnthropic(usage) {
  if (!usage || typeof usage !== 'object') return { ...EMPTY_USAGE }
  const prompt = Number(usage.input_tokens ?? 0) || 0
  const completion = Number(usage.output_tokens ?? 0) || 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

// ---- inbound: Anthropic → canonical (OpenAI shape) -------------------------

function anthropicImageToOpenAIPart(block) {
  const source = block?.source
  if (!source || typeof source !== 'object') return null
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = source.media_type || 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return null
}

function anthropicContentToCanonical(content, role) {
  if (typeof content === 'string') return { content }
  if (!Array.isArray(content)) return { content: '' }
  const textParts = []
  const imageParts = []
  const toolCalls = []
  const toolResults = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
    else if (block.type === 'image') {
      const part = anthropicImageToOpenAIPart(block)
      if (part) imageParts.push(part)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    } else if (block.type === 'tool_result') {
      const resultContent = Array.isArray(block.content)
        ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
        : typeof block.content === 'string' ? block.content : ''
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: resultContent,
      })
    }
  }
  if (role === 'assistant') {
    const message = { role: 'assistant' }
    if (imageParts.length > 0 || textParts.length > 1) {
      message.content = [...textParts.filter(text => text.length > 0).map(text => ({ type: 'text', text })), ...imageParts]
    } else {
      message.content = textParts.join('')
    }
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    return { message }
  }
  if (toolResults.length > 0) return { toolResults, content: textParts.join('') }
  if (imageParts.length > 0) {
    return {
      content: [...textParts.filter(text => text.length > 0).map(text => ({ type: 'text', text })), ...imageParts],
    }
  }
  return { content: textParts.join('') }
}

function anthropicToolsToCanonical(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

function anthropicToolChoiceToCanonical(choice) {
  if (!choice || typeof choice !== 'object') return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } }
  if (choice.type === 'none') return 'none'
  return undefined
}

/**
 * Convert an inbound `/v1/messages` body into the canonical OpenAI body.
 * Unknown fields are dropped, which is safer than forwarding Anthropic-only
 * parameters to an OpenAI-compatible upstream.
 */
export function anthropicRequestToCanonical(body) {
  const messages = []
  const systemText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.filter(part => part?.type === 'text').map(part => part.text).join('\n')
      : ''
  if (systemText) messages.push({ role: 'system', content: systemText })

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const converted = anthropicContentToCanonical(message.content, role)
    if (converted.toolResults && converted.toolResults.length > 0) {
      if (converted.content) messages.push({ role: 'user', content: converted.content })
      for (const result of converted.toolResults) messages.push(result)
      continue
    }
    if (converted.message) messages.push(converted.message)
    else messages.push({ role, content: converted.content ?? '' })
  }

  const canonical = {
    model: body.model,
    messages,
    stream: body.stream === true,
  }
  if (typeof body.max_tokens === 'number') canonical.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') canonical.temperature = body.temperature
  if (typeof body.top_p === 'number') canonical.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) canonical.stop = body.stop_sequences
  const tools = anthropicToolsToCanonical(body.tools)
  if (tools) canonical.tools = tools
  const toolChoice = anthropicToolChoiceToCanonical(body.tool_choice)
  if (toolChoice !== undefined) canonical.tool_choice = toolChoice
  if (body.metadata && typeof body.metadata === 'object') canonical.metadata = body.metadata
  return canonical
}

// ---- outbound: canonical → Anthropic request -------------------------------

function openAIImageToAnthropicBlock(part) {
  const url = part?.image_url?.url
  if (typeof url !== 'string') return null
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
    if (!match) return null
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
  }
  return { type: 'image', source: { type: 'url', url } }
}

function canonicalContentToAnthropic(content, role) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image_url') {
      const block = openAIImageToAnthropicBlock(part)
      if (block) blocks.push(block)
    }
  }
  if (role === 'assistant' && blocks.length === 0) return []
  return blocks
}

function canonicalToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter(tool => tool && (tool.type === 'function' || tool.function))
    .map(tool => {
      const fn = tool.function ?? tool
      return {
        name: fn.name,
        description: fn.description ?? '',
        input_schema: fn.parameters ?? { type: 'object', properties: {} },
      }
    })
}

function canonicalToolChoiceToAnthropic(choice) {
  if (choice === undefined || choice === null) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required' || choice === 'any') return { type: 'any' }
  if (choice === 'none') return undefined
  if (typeof choice === 'object' && choice.function?.name) return { type: 'tool', name: choice.function.name }
  if (typeof choice === 'object' && choice.type === 'tool' && choice.name) return { type: 'tool', name: choice.name }
  return undefined
}

/** Build an Anthropic Messages request body from the canonical request. */
export function canonicalToAnthropicRequest(canonical, modelId, provider = {}) {
  const systemParts = []
  const messages = []

  const pushMessage = (role, blocks) => {
    if (blocks.length === 0) return
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }

  for (const message of canonical.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
          : ''
      if (text) systemParts.push(text)
      continue
    }
    if (message.role === 'tool') {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
          : ''
      pushMessage('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: text || '(empty)' }])
      continue
    }
    if (message.role === 'assistant') {
      const blocks = canonicalContentToAnthropic(message.content, 'assistant')
      for (const call of message.tool_calls ?? []) {
        let input = {}
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          input = { _raw: call.function?.arguments ?? '' }
        }
        blocks.push({ type: 'tool_use', id: call.id ?? shortId('toolu_'), name: call.function?.name ?? 'tool', input })
      }
      pushMessage('assistant', blocks)
      continue
    }
    pushMessage('user', canonicalContentToAnthropic(message.content, 'user'))
  }

  const maxTokens = canonical.max_tokens ?? canonical.max_completion_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS
  const body = {
    model: modelId,
    max_tokens: Math.max(1, Math.floor(Number(maxTokens) || ANTHROPIC_DEFAULT_MAX_TOKENS)),
    messages,
    stream: canonical.stream === true,
  }
  if (systemParts.length > 0) body.system = systemParts.join('\n\n')
  if (typeof canonical.temperature === 'number') body.temperature = canonical.temperature
  if (typeof canonical.top_p === 'number') body.top_p = canonical.top_p
  const stop = canonical.stop
  if (typeof stop === 'string') body.stop_sequences = [stop]
  else if (Array.isArray(stop)) body.stop_sequences = stop.filter(item => typeof item === 'string')
  const tools = canonicalToolsToAnthropic(canonical.tools)
  if (tools && tools.length > 0) {
    body.tools = tools
    const toolChoice = canonicalToolChoiceToAnthropic(canonical.tool_choice)
    if (toolChoice) body.tool_choice = toolChoice
  }
  return body
}

// ---- upstream request ------------------------------------------------------

function authHeaders(provider, apiKey) {
  const headers = { ...(provider.headers ?? {}) }
  if (provider.type === 'anthropic') headers['anthropic-version'] = provider.anthropicVersion || '2023-06-01'
  if (provider.authHeader === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else if (provider.authHeader === 'x-api-key') headers['x-api-key'] = apiKey
  else {
    headers.authorization = `Bearer ${apiKey}`
    headers['x-api-key'] = apiKey
  }
  return headers
}

/**
 * Build the fetch() call for one (provider, key, model) attempt.
 * @returns {{url: string, init: RequestInit, dialect: 'openai'|'anthropic'}}
 */
export function buildUpstreamRequest({ provider, apiKey, modelId, canonical, signal }) {
  const dialect = provider.type
  let body
  if (dialect === 'anthropic') {
    body = canonicalToAnthropicRequest(canonical, modelId, provider)
  } else {
    body = { ...canonical, model: modelId }
    delete body.aipool
    // `stream_options.include_usage` is how we learn the token counts, but a
    // few OpenAI-compatible servers reject unknown fields: let the provider
    // opt out instead of losing the whole stream.
    if (body.stream === true && body.stream_options === undefined && provider.streamUsage !== false) {
      body.stream_options = { include_usage: true }
    }
  }
  const headers = {
    'content-type': 'application/json',
    accept: canonical.stream ? 'text/event-stream' : 'application/json',
    ...authHeaders(provider, apiKey),
  }
  return {
    url: joinUrl(provider.baseUrl, provider.chatPath),
    dialect,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    },
  }
}

// ---- response translation --------------------------------------------------

function mapStopReasonFromAnthropic(stopReason) {
  switch (stopReason) {
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'refusal': return 'content_filter'
    case 'end_turn':
    case 'stop_sequence':
    default: return 'stop'
  }
}

function mapFinishToAnthropic(finishReason) {
  switch (finishReason) {
    case 'length': return 'max_tokens'
    case 'tool_calls': return 'tool_use'
    case 'content_filter': return 'end_turn'
    case 'stop':
    case null:
    case undefined:
    default: return 'end_turn'
  }
}

/** Anthropic non-stream response → canonical OpenAI response. */
export function anthropicResponseToCanonical(json, requestedModel) {
  const blocks = Array.isArray(json?.content) ? json.content : []
  const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('')
  const toolCalls = blocks.filter(block => block?.type === 'tool_use').map(block => ({
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }))
  const message = { role: 'assistant', content: text }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
    if (text.length === 0) message.content = null
  }
  return {
    id: json?.id ?? shortId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: mapStopReasonFromAnthropic(json?.stop_reason) }],
    usage: usageFromAnthropic(json?.usage),
  }
}

/** Canonical OpenAI response → Anthropic Messages response. */
export function canonicalToAnthropicResponse(json, requestedModel) {
  const choice = json?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const content = []
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('')
      : ''
  if (text) content.push({ type: 'text', text })
  for (const call of message.tool_calls ?? []) {
    let input = {}
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      input = { _raw: call.function?.arguments ?? '' }
    }
    content.push({ type: 'tool_use', id: call.id ?? shortId('toolu_'), name: call.function?.name ?? 'tool', input })
  }
  const usage = usageFromOpenAI(json?.usage)
  return {
    id: json?.id ?? shortId('msg_'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapFinishToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  }
}

/** Normalize a provider response into the canonical shape + usage facts. */
export function normalizeResponse({ providerType, json, requestedModel }) {
  if (providerType === 'anthropic') {
    return { body: anthropicResponseToCanonical(json, requestedModel), usage: usageFromAnthropic(json?.usage) }
  }
  const body = json && typeof json === 'object' ? { ...json, model: requestedModel } : json
  return { body, usage: usageFromOpenAI(json?.usage) }
}

// ---- stream translation ----------------------------------------------------

function chunkFrame({ id, model, created, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/**
 * Anthropic SSE → OpenAI SSE.
 * `ctx` collects `{usage, finishReason, error, model}` for the caller.
 */
export async function* anthropicStreamToOpenAI(readable, { model, ctx }) {
  const id = shortId('chatcmpl-')
  const created = Math.floor(Date.now() / 1000)
  let toolIndex = -1
  let currentToolIndex = -1
  let sawRole = false
  let finished = false

  for await (const record of parseSSE(readable)) {
    const data = safeParse(record.data)
    if (!data) continue
    const event = record.event ?? data.type
    if (event === 'message_start') {
      ctx.usage.prompt_tokens = Number(data.message?.usage?.input_tokens ?? 0) || 0
      ctx.model = data.message?.model ?? model
      if (!sawRole) {
        sawRole = true
        yield sseData(chunkFrame({ id, model: ctx.model, created, delta: { role: 'assistant', content: '' } }))
      }
      continue
    }
    if (event === 'content_block_start') {
      const block = data.content_block ?? {}
      if (block.type === 'tool_use') {
        toolIndex += 1
        currentToolIndex = toolIndex
        yield sseData(chunkFrame({
          id,
          model: ctx.model,
          created,
          delta: {
            tool_calls: [{ index: currentToolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }],
          },
        }))
      }
      continue
    }
    if (event === 'content_block_delta') {
      const delta = data.delta ?? {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        yield sseData(chunkFrame({ id, model: ctx.model, created, delta: { content: delta.text } }))
      } else if (delta.type === 'input_json_delta' && currentToolIndex >= 0) {
        yield sseData(chunkFrame({
          id,
          model: ctx.model,
          created,
          delta: {
            tool_calls: [{ index: currentToolIndex, function: { arguments: delta.partial_json ?? '' } }],
          },
        }))
      }
      continue
    }
    if (event === 'message_delta') {
      const stopReason = data.delta?.stop_reason
      if (stopReason) {
        ctx.finishReason = mapStopReasonFromAnthropic(stopReason)
        yield sseData(chunkFrame({ id, model: ctx.model, created, delta: {}, finishReason: ctx.finishReason }))
        finished = true
      }
      if (data.usage && typeof data.usage.output_tokens === 'number') {
        ctx.usage.completion_tokens = data.usage.output_tokens
      }
      continue
    }
    if (event === 'error') {
      ctx.error = {
        message: data.error?.message ?? 'upstream stream error',
        type: data.error?.type ?? 'api_error',
      }
      ctx.errorForwarded = true
      yield sseData({ error: { message: ctx.error.message, type: ctx.error.type } })
      return
    }
    if (event === 'message_stop') break
  }
  if (!finished && ctx.error === null) {
    yield sseData(chunkFrame({ id, model: ctx.model, created, delta: {}, finishReason: ctx.finishReason ?? 'stop' }))
  }
  yield sseData('[DONE]')
}

/**
 * OpenAI SSE → Anthropic SSE.
 * Emits a well-formed message_start / content_block_* / message_delta sequence;
 * `ctx` collects usage, stop reason and error facts.
 */
export async function* openAIStreamToAnthropic(readable, { model, ctx }) {
  const id = shortId('msg_')
  let nextIndex = 0
  let textBlockIndex = -1
  let finishReason = null
  const toolBlocks = new Map() // openai tool index → anthropic block index

  yield sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  for await (const record of parseSSE(readable)) {
    if (record.data === '[DONE]') break
    const data = safeParse(record.data)
    if (!data) continue
    if (data.error) {
      ctx.error = { message: data.error.message ?? 'upstream stream error', type: data.error.type ?? 'api_error' }
      ctx.errorForwarded = true
      yield sseEvent('error', { type: 'error', error: { type: 'api_error', message: ctx.error.message } })
      return
    }
    if (data.usage) Object.assign(ctx.usage, usageFromOpenAI(data.usage))
    const choice = data.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (textBlockIndex < 0) {
        textBlockIndex = nextIndex++
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      })
    }

    for (const call of delta.tool_calls ?? []) {
      const key = typeof call.index === 'number' ? call.index : 0
      let blockIndex = toolBlocks.get(key)
      if (blockIndex === undefined) {
        blockIndex = nextIndex++
        toolBlocks.set(key, blockIndex)
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: call.id ?? shortId('toolu_'),
            name: call.function?.name ?? 'tool',
            input: {},
          },
        })
      }
      const args = call.function?.arguments
      if (typeof args === 'string' && args.length > 0) {
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        })
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const indices = [...(textBlockIndex >= 0 ? [textBlockIndex] : []), ...toolBlocks.values()].sort((a, b) => a - b)
  for (const index of indices) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index })
  }
  ctx.finishReason = finishReason ?? 'stop'
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapFinishToAnthropic(finishReason), stop_sequence: null },
    usage: { output_tokens: ctx.usage.completion_tokens },
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

/**
 * Same-dialect passthrough: forward the upstream bytes untouched while
 * sniffing the event stream for usage / finish / error facts.
 */
export async function* passthroughStream(readable, { providerType, ctx }) {
  const decoder = new TextDecoder()
  let buffer = ''
  const sniff = (block) => {
    const record = parseBlock(block)
    if (!record) return
    if (record.data === '[DONE]') return
    const data = safeParse(record.data)
    if (!data) return
    if (data.error) {
      ctx.error = { message: data.error.message ?? 'upstream stream error', type: data.error.type ?? 'api_error' }
      // passthrough forwards the frame untouched, so nothing else must emit it.
      ctx.errorForwarded = true
      return
    }
    if (providerType === 'anthropic') {
      // Some Anthropic-compatible servers omit the `event:` line and only send
      // `data: {"type": ...}` — fall back to the payload type.
      const eventName = record.event ?? data.type
      if (eventName === 'message_start' && data.message?.usage) {
        ctx.usage.prompt_tokens = Number(data.message.usage.input_tokens ?? 0) || 0
      }
      if (eventName === 'message_delta') {
        if (data.usage?.output_tokens) ctx.usage.completion_tokens = data.usage.output_tokens
        if (data.delta?.stop_reason) ctx.finishReason = data.delta.stop_reason
      }
      return
    }
    if (data.usage) Object.assign(ctx.usage, usageFromOpenAI(data.usage))
    const choice = data.choices?.[0]
    if (choice?.finish_reason) ctx.finishReason = choice.finish_reason
  }

  for await (const chunk of readable) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      sniff(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
    }
    yield chunk
  }
  buffer += decoder.decode().replace(/\r/g, '')
  if (buffer.trim()) sniff(buffer)
}

export function emptyStreamContext() {
  return {
    model: null,
    usage: { ...EMPTY_USAGE },
    finishReason: null,
    error: null,
    // true when the upstream error frame has already been forwarded to the
    // client verbatim, so callers must not synthesize a second one.
    errorForwarded: false,
  }
}

/**
 * Does the first SSE chunk already carry an upstream error? Providers that
 * answer 200 and then an error event must still be rotated.
 */
export function looksLikeErrorEvent(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const trimmed = text.trim()
  if (trimmed.startsWith('event: error')) return { message: 'upstream emitted an error event' }
  if (trimmed.startsWith('data:')) {
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return null
    try {
      const parsed = JSON.parse(payload)
      if (parsed?.error) return { message: parsed.error.message ?? 'upstream error', type: parsed.error.type }
    } catch {
      return null
    }
  }
  return null
}
