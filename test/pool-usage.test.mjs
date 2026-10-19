/**
 * Regression tests for usage-driven selection.
 *
 * OpenCode Go quotas reset on three independent windows (5h rolling, weekly,
 * monthly). The pool used to look at rolling+weekly only, so an account whose
 * MONTHLY quota was gone stayed selectable: every request burned one attempt
 * before the 429 rotated away. Revival had the same gap in reverse — a key
 * could revive into rotation while its monthly window was still exhausted.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXHAUSTED, HEALTHY, KeyPool } from '../pool.js'

const KEYS = [
  { id: 'key-a', label: 'a', apiKeyEnv: 'KEY_A' },
  { id: 'key-b', label: 'b', apiKeyEnv: 'KEY_B' },
]

function usage(rolling, weekly, monthly) {
  return {
    rolling: { status: 'ok', percent: rolling, resetsAt: null },
    weekly: { status: 'ok', percent: weekly, resetsAt: null },
    monthly: { status: 'ok', percent: monthly, resetsAt: null },
  }
}

test('a monthly window over the threshold preempts the key', () => {
  const pool = new KeyPool({ preemptAtPercent: 95 })
  pool.syncKeys(KEYS)
  pool.onUsage('key-a', usage(10, 10, 99))
  assert.equal(pool.isUsable('key-a'), false, 'monthly usage must count towards preemption')
  assert.equal(pool.currentKey()?.id, 'key-b')
})

test('an exhausted key does not revive while its monthly window is exhausted', () => {
  const pool = new KeyPool({ reviveThresholdPercent: 98 })
  pool.syncKeys(KEYS)
  pool.states.get('key-a').state = EXHAUSTED
  pool.onUsage('key-a', usage(0, 5, 99))
  assert.equal(pool.states.get('key-a').state, EXHAUSTED)
})

test('an exhausted key revives once all three windows recovered', () => {
  const pool = new KeyPool({ reviveThresholdPercent: 98 })
  pool.syncKeys(KEYS)
  pool.states.get('key-a').state = EXHAUSTED
  pool.onUsage('key-a', usage(0, 5, 20))
  assert.equal(pool.states.get('key-a').state, HEALTHY)
})

test('usage-only polls do not rewrite the state file', () => {
  // Persistence is best-effort, but writing once per key per poll was disk
  // churn: 10 accounts at 30s means 10 rewrites of the same file.
  let writes = 0
  const pool = new KeyPool()
  pool.syncKeys(KEYS)
  pool.persist = () => { writes += 1 }
  for (let index = 0; index < 5; index++) {
    pool.onUsage('key-a', usage(index, index, index))
    pool.onUsage('key-b', usage(index, index, index))
  }
  assert.equal(writes, 0, 'usage-only updates must not persist')
  pool.onUsage('key-a', usage(0, 0, 0))
  assert.equal(writes, 0)
})
