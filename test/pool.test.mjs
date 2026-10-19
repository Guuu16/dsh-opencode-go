import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyPool, classifyFailure, HEALTHY, COOLDOWN, EXHAUSTED, INVALID, DISABLED } from '../src/pool.mjs'

const COOLDOWNS = { rateLimitMs: 1000, serverMs: 500, transportMs: 200, authMs: 5000, quotaMs: 3000 }

function poolWith(keys, options = {}) {
  let now = 1_000_000
  const pool = new KeyPool({
    providerId: 'p',
    keys: keys.map((entry, index) => ({ id: `k${index + 1}`, label: `k${index + 1}`, key: `secret-${index}`, enabled: true, weight: 1, ...entry })),
    cooldowns: COOLDOWNS,
    now: () => now,
    ...options,
  })
  return { pool, advance: ms => { now += ms }, now: () => now }
}

test('classification: status codes map to rotation behaviour', () => {
  assert.equal(classifyFailure({ status: 401 }).kind, 'auth')
  assert.equal(classifyFailure({ status: 403 }).kind, 'auth')
  // A bare 429 is a throttle, not an empty account: different cooldown.
  assert.equal(classifyFailure({ status: 429 }).kind, 'rateLimit')
  assert.equal(classifyFailure({ status: 429, body: { error: { message: 'insufficient_quota' } } }).kind, 'quota')
  assert.equal(classifyFailure({ status: 402 }).kind, 'quota')
  assert.equal(classifyFailure({ status: 500 }).kind, 'server')
  assert.equal(classifyFailure({ status: 503 }).kind, 'server')
  assert.equal(classifyFailure({ status: 400, body: { error: { message: 'bad tool schema' } } }).kind, 'request')
  assert.equal(classifyFailure({ status: 400, body: { error: { message: 'insufficient_quota for this account' } } }).kind, 'quota')
  assert.equal(classifyFailure({ status: 404, body: { error: { message: 'model foo does not exist' } } }).kind, 'model')
  assert.equal(classifyFailure({ status: 0, code: 'ECONNRESET' }).kind, 'transport')
})

test('Retry-After stretches the cooldown but never past 10 minutes', () => {
  const short = classifyFailure({ status: 429, cooldowns: COOLDOWNS })
  assert.equal(short.cooldownMs, COOLDOWNS.rateLimitMs)
  const honoured = classifyFailure({ status: 429, cooldowns: COOLDOWNS, retryAfterMs: 4000 })
  assert.equal(honoured.cooldownMs, 4000)
  const capped = classifyFailure({ status: 503, cooldowns: COOLDOWNS, retryAfterMs: 60 * 60_000 })
  assert.ok(capped.cooldownMs <= 600_000)
})

test('a client error is not retried, an upstream error is', () => {
  assert.equal(classifyFailure({ status: 400, body: 'x' }).retryable, false)
  assert.equal(classifyFailure({ status: 429, body: 'x' }).retryable, true)
  assert.equal(classifyFailure({ status: 401, body: 'x' }).rotateKey, true)
  assert.equal(classifyFailure({ status: 404, body: { error: { message: 'model x not found' } } }).rotateKey, false)
})

test('keys rotate least-recently-used first', () => {
  const { pool } = poolWith([{}, {}, {}])
  const first = pool.pick()
  pool.onAttempt(first.id)
  const second = pool.pick()
  pool.onAttempt(second.id)
  const third = pool.pick()
  assert.notEqual(first.id, second.id)
  assert.notEqual(second.id, third.id)
  assert.notEqual(first.id, third.id)
})

test('a throttled key cools down briefly, an exhausted one for the quota window', () => {
  const { pool, advance } = poolWith([{}, {}])
  const key = pool.pick()
  pool.onFailure(key.id, classifyFailure({ status: 429, cooldowns: COOLDOWNS }))
  assert.equal(pool.stateOf(key.id).state, COOLDOWN)
  assert.ok(pool.candidates().every(entry => entry.id !== key.id))
  advance(COOLDOWNS.rateLimitMs + 1)
  assert.equal(pool.stateOf(key.id).state, HEALTHY)

  const quotaKey = pool.pick()
  pool.onFailure(quotaKey.id, classifyFailure({
    status: 429,
    body: { error: { message: 'quota exceeded for this billing period' } },
    cooldowns: COOLDOWNS,
  }))
  assert.equal(pool.stateOf(quotaKey.id).state, EXHAUSTED)
  advance(COOLDOWNS.rateLimitMs + 1)
  assert.notEqual(pool.stateOf(quotaKey.id).state, HEALTHY)
})

test('invalid credentials keep the key out until reset', () => {
  const { pool } = poolWith([{}])
  const key = pool.pick()
  pool.onFailure(key.id, classifyFailure({ status: 401, cooldowns: COOLDOWNS }))
  assert.equal(pool.stateOf(key.id).state, INVALID)
  assert.equal(pool.pick(), null)
  pool.reset(key.id)
  assert.equal(pool.pick()?.id, key.id)
})

test('quota preemption skips a key before it fails, without killing it', () => {
  const { pool } = poolWith([{}, {}], { preemptAtPercent: 90 })
  const [a, b] = pool.entries
  pool.applyUsage(a.id, { rolling: { percent: 95, status: 'ok' }, weekly: null, monthly: null })
  assert.equal(pool.stateOf(a.id).state, HEALTHY)
  assert.equal(pool.pick().id, b.id)
  // The window resets → preemption lifts on the next probe.
  pool.applyUsage(a.id, { rolling: { percent: 10, status: 'ok' }, weekly: null, monthly: null })
  const order = pool.candidates().map(entry => entry.id)
  assert.ok(order.includes(a.id))
})

test('an exhausted key revives when the usage endpoint says the window is clear', () => {
  const { pool } = poolWith([{}])
  const key = pool.pick()
  pool.onFailure(key.id, classifyFailure({
    status: 429,
    body: { error: { message: 'quota exceeded' } },
    cooldowns: COOLDOWNS,
  }))
  assert.equal(pool.stateOf(key.id).state, EXHAUSTED)
  pool.applyUsage(key.id, { rolling: { percent: 4, status: 'ok' }, weekly: { percent: 40 }, monthly: null })
  assert.equal(pool.stateOf(key.id).state, HEALTHY)
  assert.equal(pool.pick()?.id, key.id)
})

test('explicit disable wins over a quota revival', () => {
  const { pool } = poolWith([{}])
  const key = pool.pick()
  pool.setEnabled(key.id, false)
  pool.applyUsage(key.id, { rolling: { percent: 0, status: 'ok' } })
  assert.equal(pool.stateOf(key.id).state, DISABLED)
  assert.equal(pool.pick(), null)
  pool.setEnabled(key.id, true)
  assert.equal(pool.stateOf(key.id).state, HEALTHY)
})

test('reconfiguring keys keeps state for surviving ids', () => {
  const { pool } = poolWith([{}, {}])
  const key = pool.pick()
  pool.onFailure(key.id, classifyFailure({ status: 401, cooldowns: COOLDOWNS }))
  pool.setKeys(pool.entries.filter(entry => entry.id === key.id))
  assert.equal(pool.stateOf(key.id).state, INVALID)
})

test('counters report what the dashboard needs', () => {
  const { pool } = poolWith([{}])
  const key = pool.pick()
  pool.onAttempt(key.id)
  pool.onSuccess(key.id, { latencyMs: 120, tokensIn: 10, tokensOut: 4 })
  pool.onRetry(key.id)
  const [snapshot] = pool.snapshot()
  assert.equal(snapshot.requests, 1)
  assert.equal(snapshot.tokensIn, 10)
  assert.equal(snapshot.tokensOut, 4)
  assert.equal(snapshot.retries, 1)
  assert.equal(snapshot.latencyMsAvg, 120)
  assert.match(snapshot.apiKeyMasked, /…/)
  assert.ok(!snapshot.apiKeyMasked.includes('secret'))
})
