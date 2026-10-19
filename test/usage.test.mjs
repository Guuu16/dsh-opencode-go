import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchModels, fetchUsage, parseUsage, UsageError } from '../electron/core/usage.js'

test('parseUsage keeps all three windows and clamps percentages', () => {
  const usage = parseUsage({
    usage: {
      rolling: { status: 'ok', percent: 9, resetsAt: '2026-01-01T05:00:00.000Z' },
      weekly: { status: 'ok', percent: '12.5' },
      monthly: { status: 'quota', percent: 120 },
    },
  })
  assert.equal(usage.rolling.percent, 9)
  assert.equal(usage.rolling.resetsAt, '2026-01-01T05:00:00.000Z')
  assert.equal(usage.weekly.percent, 12.5)
  assert.equal(usage.monthly.percent, 100)
  assert.equal(usage.monthly.status, 'quota')
})

test('parseUsage tolerates a bare usage object and missing windows', () => {
  const usage = parseUsage({ rolling: { percent: 1 } })
  assert.equal(usage.rolling.percent, 1)
  assert.equal(usage.weekly, null)
  assert.equal(usage.monthly, null)
})

test('fetchUsage sends the bearer key and parses the response', async () => {
  let seen
  const usage = await fetchUsage({
    apiKey: 'sk-test',
    fetchImpl: async (url, options) => {
      seen = { url, auth: options.headers.Authorization }
      return new Response(JSON.stringify({
        usage: { rolling: { status: 'ok', percent: 42 }, weekly: { status: 'ok', percent: 7 }, monthly: { status: 'ok', percent: 3 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(seen.auth, 'Bearer sk-test')
  assert.equal(usage.rolling.percent, 42)
})

test('401 becomes a coded unauthorized error', async () => {
  await assert.rejects(
    () => fetchUsage({ apiKey: 'sk-test', fetchImpl: async () => new Response('nope', { status: 401 }) }),
    error => error instanceof UsageError && error.code === 'unauthorized',
  )
})

test('network failures are coded, not raw', async () => {
  await assert.rejects(
    () => fetchUsage({ apiKey: 'sk-test', fetchImpl: async () => { throw new Error('ECONNRESET') } }),
    error => error instanceof UsageError && error.code === 'network',
  )
})

test('a missing key never issues a request', async () => {
  let called = false
  await assert.rejects(
    () => fetchUsage({ apiKey: '', fetchImpl: async () => { called = true } }),
    error => error.code === 'no-api-key',
  )
  assert.equal(called, false)
})

/** A response whose headers are fine but whose body never arrives. */
function hangingResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('aborted', 'AbortError'))
      })
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
}

test('a body that never arrives times out instead of hanging the dashboard', async () => {
  const started = Date.now()
  await assert.rejects(
    () => fetchUsage({
      apiKey: 'sk-test',
      timeoutMs: 60,
      fetchImpl: async (_url, { signal }) => hangingResponse(signal),
    }),
    error => error instanceof UsageError && error.code === 'timeout',
  )
  assert.ok(Date.now() - started < 2000, 'timeout must fire while the body is pending')
})

test('fetchModels has the same body timeout', async () => {
  await assert.rejects(
    () => fetchModels({
      timeoutMs: 60,
      fetchImpl: async (_url, { signal }) => hangingResponse(signal),
    }),
    error => error instanceof UsageError && error.code === 'timeout',
  )
})
