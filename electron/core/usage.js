/**
 * OpenCode Go usage endpoint client.
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <key>
 *
 * The endpoint is undocumented; parsing is defensive and any shape drift
 * degrades to a coded error shown in the dashboard, never a crash.
 */

export const DEFAULT_USAGE_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'
export const DEFAULT_MODELS_BASE_URL = 'https://opencode.ai/zen/go/v1/models'
export const DEFAULT_API_BASE_URL = 'https://opencode.ai/zen/go/v1'

export class UsageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UsageError'
    this.code = code
  }
}

function pickWindow(value) {
  if (!value || typeof value !== 'object') return null
  const percent = typeof value.percent === 'number' ? value.percent : Number(value.percent)
  return {
    status: typeof value.status === 'string' ? value.status : null,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
  }
}

export function parseUsage(body) {
  const usage = body && typeof body === 'object' && body.usage ? body.usage : body
  return {
    rolling: pickWindow(usage && usage.rolling),
    weekly: pickWindow(usage && usage.weekly),
    monthly: pickWindow(usage && usage.monthly),
  }
}

async function releaseBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    // best effort: the socket is already unusable
  }
}

export async function fetchUsage({ baseUrl = DEFAULT_USAGE_BASE_URL, apiKey, timeoutMs = 15000, fetchImpl } = {}) {
  if (!apiKey) throw new UsageError('no-api-key', 'no API key to query usage with')
  const impl = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  let body
  try {
    response = await impl(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      await releaseBody(response)
      throw new UsageError('unauthorized', `usage endpoint rejected the key (${response.status})`)
    }
    if (!response.ok) {
      await releaseBody(response)
      throw new UsageError(`http-${response.status}`, `usage endpoint answered HTTP ${response.status}`)
    }
    // The timer must cover the BODY read too: a response whose headers arrive
    // while the body never does would otherwise hang the dashboard forever.
    body = await response.json()
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (controller.signal.aborted) throw new UsageError('timeout', `usage request timed out after ${timeoutMs}ms`)
    if (response === undefined) throw new UsageError('network', `usage request failed: ${baseUrl}`)
    throw new UsageError('bad-json', 'usage endpoint answered with non-JSON')
  } finally {
    clearTimeout(timer)
  }
  return parseUsage(body)
}

export async function fetchModels({ baseUrl = DEFAULT_MODELS_BASE_URL, apiKey, timeoutMs = 15000, fetchImpl } = {}) {
  const impl = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  let response
  let body
  try {
    response = await impl(baseUrl, { headers, signal: controller.signal })
    if (!response.ok) {
      await releaseBody(response)
      throw new UsageError(`http-${response.status}`, `models endpoint answered HTTP ${response.status}`)
    }
    body = await response.json()
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (controller.signal.aborted) throw new UsageError('timeout', `models request timed out after ${timeoutMs}ms`)
    if (response === undefined) throw new UsageError('network', `models request failed: ${baseUrl}`)
    throw new UsageError('bad-json', 'models endpoint answered with non-JSON')
  } finally {
    clearTimeout(timer)
  }
  const list = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : [])
  return list.map(item => typeof item === 'string' ? { id: item } : { id: String(item?.id ?? '') }).filter(item => item.id)
}
