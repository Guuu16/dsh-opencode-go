/**
 * Regression test: the pool must actually fail over to another account before
 * `dsh-llm-retry` runs out of budget and pauses the task.
 *
 * The harness owns the retry loop. `@deepseek-ai/dsh-llm-retry` re-runs the
 * failed step while `previousRetry < maxRetries`, and calls through to the
 * failure once that budget is spent — which is the moment the task pauses. The
 * pool only rotates a key away after `switchAfterConsecutiveFailures` transient
 * failures, so the advertised budget must be wide enough to reach that
 * rotation, otherwise every attempt burns on the same key.
 *
 * Pure pool policy only (no harness imports), so this runs under plain Node.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeyPool, harnessRetryBudget } from '../pool.js'

/** Mirrors MAX_ATTEMPTS_PER_REQUEST in index.js. */
const MAX_ATTEMPTS_PER_REQUEST = 2

const KEYS = [
  { id: 'key-a', label: 'outlook', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
  { id: 'key-b', label: 'gmail', apiKeyEnv: 'OPENCODE_GO_KEY_B' },
]

const makeKeys = count => Array.from({ length: count }, (_, index) => ({
  id: `key-${index}`,
  label: `account ${index}`,
  apiKeyEnv: `OPENCODE_GO_KEY_${index}`,
}))

/** The old formula this plugin shipped: the reported bug. */
const formerBudget = keyCount => Math.max(2, keyCount)

/**
 * Mirror one agent step: drive `stream()` and the harness retry accounting the
 * way dsh-llm-retry does, and report what the pool did.
 *
 * @param {object} options
 * @param {number} options.maxRetries - budget advertised by providerRetryPolicy().
 * @param {number} options.consecutiveThreshold - configured switchAfterConsecutiveFailures.
 * @param {(id: string, attempt: number) => boolean} options.succeeds - does this attempt succeed?
 * @param {Array} [options.keys] - pool key list, defaults to the two-key pool.
 */
function runStep({ maxRetries, consecutiveThreshold, succeeds, keys = KEYS }) {
  const pool = new KeyPool({ consecutiveThreshold, now: () => 0 })
  pool.syncKeys(keys)

  let previousRetry = 0
  const attempted = []
  let succeeded = false
  let paused = false

  for (;;) {
    // One `stream()` call. It keeps looping internally only when a rotation
    // handed it a different key, and never past the fixed per-request bound.
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_REQUEST; attempt++) {
      const entry = pool.currentKey()
      assert.ok(entry, 'pool went dry unexpectedly')
      attempted.push(entry.id)

      if (succeeds(entry.id, attempted.length)) {
        succeeded = true
        break
      }

      // Transient failure (TRANSPORT): counts a streak, rotates at the threshold.
      const rotated = pool.onFailure(entry.id, { code: 'TRANSPORT', message: 'Connection error.' }) !== null
      if (!rotated) break
    }
    if (succeeded) break

    // dsh-llm-retry: `if (previousRetry >= maxRetries) return next()` — the pause.
    if (previousRetry >= maxRetries) {
      paused = true
      break
    }
    previousRetry += 1
  }

  return { attempted, succeeded, paused, distinctKeys: new Set(attempted).size }
}

test('the former budget never rotates, so the task pauses on one account', () => {
  // 2 keys and threshold 4: 3 attempts, one short of the rotation. This is the
  // production defect — state.json showed failureStreak stuck at 3.
  const run = runStep({
    maxRetries: formerBudget(KEYS.length),
    consecutiveThreshold: 4,
    succeeds: id => id === 'key-b', // the second account would have worked
  })
  assert.equal(run.paused, true, 'expected the task to pause under the old budget')
  assert.equal(run.distinctKeys, 1, 'expected no failover under the old budget')
  assert.deepEqual(run.attempted, ['key-a', 'key-a', 'key-a'])
})

test('the fixed budget fails over to the healthy account instead of pausing', () => {
  const run = runStep({
    maxRetries: harnessRetryBudget({ keyCount: KEYS.length, consecutiveThreshold: 4 }),
    consecutiveThreshold: 4,
    succeeds: id => id === 'key-b',
  })
  assert.equal(run.paused, false, 'task must not pause while another account can serve it')
  assert.equal(run.succeeded, true)
  assert.equal(run.distinctKeys, 2, 'both accounts must be tried')
  assert.deepEqual(run.attempted, ['key-a', 'key-a', 'key-a', 'key-a', 'key-b'])
})

test('the budget must reach the configured rotation threshold', () => {
  // The invariant that was violated: a budget below the threshold can never
  // produce a rotation.
  for (const keyCount of [1, 2, 5, 10, 20]) {
    for (const threshold of [1, 2, 4, 8]) {
      const budget = harnessRetryBudget({ keyCount, consecutiveThreshold: threshold })
      assert.ok(
        budget >= threshold,
        `${keyCount} keys @ threshold ${threshold}: budget ${budget} cannot reach the rotation`,
      )
    }
  }
})

test('scales with the configured threshold and key count', () => {
  for (const threshold of [1, 2, 3, 4, 8]) {
    const budget = harnessRetryBudget({ keyCount: 2, consecutiveThreshold: threshold })
    assert.equal(budget, 2 * threshold, `threshold ${threshold}`)
    const run = runStep({
      maxRetries: budget,
      consecutiveThreshold: threshold,
      succeeds: id => id === 'key-b',
    })
    assert.equal(run.paused, false, `threshold ${threshold}: should fail over, not pause`)
    assert.equal(run.distinctKeys, 2, `threshold ${threshold}: both keys expected`)
  }
})

test('10 accounts reach a working account without pausing', () => {
  const keys = makeKeys(10)
  const run = runStep({
    maxRetries: harnessRetryBudget({ keyCount: 10, consecutiveThreshold: 4 }),
    consecutiveThreshold: 4,
    keys,
    succeeds: id => id === 'key-6', // the 7th account is healthy
  })
  assert.equal(run.paused, false, 'a working account must be reached before the task pauses')
  assert.equal(run.succeeded, true)
  assert.ok(run.distinctKeys > 1, 'failover must move across accounts')
})

test('request count does not grow with the square of the pool', () => {
  // The regression a pool-sized per-request sweep would reintroduce: with 10
  // accounts at threshold 1 it issued 121 requests (`(keys+1) × (budget+1)`).
  for (const [count, threshold] of [[2, 1], [5, 2], [10, 1], [10, 4], [20, 1], [20, 4]]) {
    const keys = makeKeys(count)
    const budget = harnessRetryBudget({ keyCount: count, consecutiveThreshold: threshold })
    const run = runStep({ maxRetries: budget, consecutiveThreshold: threshold, keys, succeeds: () => false })
    const ceiling = 2 * (budget + 1)
    assert.ok(
      run.attempted.length <= ceiling,
      `${count} accounts @ threshold ${threshold}: ${run.attempted.length} requests, ceiling ${ceiling}`,
    )
    const formerBlowup = (count + 1) * (budget + 1)
    assert.ok(
      run.attempted.length < formerBlowup,
      `${count} accounts @ threshold ${threshold}: ${run.attempted.length} requests must stay below the old product ${formerBlowup}`,
    )
  }
})

test('a dead pool still terminates, trying every account first', () => {
  const budget = harnessRetryBudget({ keyCount: 2, consecutiveThreshold: 4 })
  const run = runStep({ maxRetries: budget, consecutiveThreshold: 4, succeeds: () => false })
  assert.equal(run.succeeded, false)
  assert.equal(run.paused, true, 'a genuinely dead pool must end, not loop forever')
  assert.equal(run.distinctKeys, 2, 'both accounts must be attempted before giving up')
  assert.ok(
    run.attempted.length <= 2 * (budget + 1),
    `attempts bounded by 2*(budget+1)=${2 * (budget + 1)}, got ${run.attempted.length}`,
  )
})

test('a full sweep stays inside a waitable wall clock at the capped backoff', () => {
  const initialDelayMs = 500
  const maxDelayMs = 2000 // POOL_MAX_RETRY_DELAY_MS
  const sweepSeconds = retries => {
    let ms = 0
    for (let retry = 1; retry <= retries; retry++) ms += Math.min(initialDelayMs * 2 ** (retry - 1), maxDelayMs)
    return ms / 1000
  }
  const ten = sweepSeconds(harnessRetryBudget({ keyCount: 10, consecutiveThreshold: 4 }))
  const twenty = sweepSeconds(harnessRetryBudget({ keyCount: 20, consecutiveThreshold: 4 }))
  assert.ok(ten < 90, `10 accounts should sweep in under 90s, got ${ten}s`)
  assert.ok(twenty < 180, `20 accounts should sweep in under 180s, got ${twenty}s`)
})

test('a disabled rotation rule keeps the previous floor of 2', () => {
  assert.equal(harnessRetryBudget({ keyCount: 1, consecutiveThreshold: 0 }), 2)
  assert.equal(harnessRetryBudget({ keyCount: 2, consecutiveThreshold: 0 }), 2)
})

test('degenerate input is clamped, never NaN', () => {
  assert.equal(harnessRetryBudget({}), 2)
  assert.equal(harnessRetryBudget({ keyCount: 0, consecutiveThreshold: 4 }), 4)
  assert.equal(harnessRetryBudget({ keyCount: NaN, consecutiveThreshold: NaN }), 2)
  assert.equal(harnessRetryBudget({ keyCount: 3.7, consecutiveThreshold: 2.9 }), 6)
})
