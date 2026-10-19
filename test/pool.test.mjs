import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool, classifyCode } from '../electron/core/pool.js'

function makeState(accounts, settings = {}) {
  return {
    version: 1,
    activeId: accounts.length > 0 ? accounts[0].id : null,
    accounts: accounts.map((account, index) => ({
      id: account.id ?? `k-${index}`,
      label: account.label ?? `acc-${index}`,
      hint: '',
      cipher: '',
      scheme: 'plain',
      state: account.state ?? 'healthy',
      disabled: (account.state ?? 'healthy') === 'disabled',
      failureStreak: account.failureStreak ?? 0,
      lastFailure: null,
      usage: account.usage ?? null,
      usageAt: null,
      usageError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    settings: {
      preemptAtPercent: 100,
      switchAfterConsecutiveFailures: 0,
      usageRefreshMs: 30000,
      proxyEnabled: true,
      proxyPort: 8787,
      launchAtLogin: false,
      closeToTray: true,
      autoMarkInvalid: true,
      ...settings,
    },
    lastSwitch: null,
  }
}

function makePool(accounts, settings) {
  const state = makeState(accounts, settings)
  const pool = new Pool({ state, now: () => Date.parse('2026-01-01T00:00:00.000Z') })
  return { state, pool }
}

test('quota failure marks the account exhausted and rotates to the next', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }])
  const rotation = pool.onFailure('a', 'QUOTA', 'quota exceeded')
  assert.deepEqual(rotation, { from: 'a', to: 'b', reason: 'quota' })
  assert.equal(state.accounts[0].state, 'exhausted')
  assert.equal(state.activeId, 'b')
  assert.equal(state.lastSwitch.reason, 'quota')
})

test('credential failure marks invalid and rotates', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }])
  pool.onFailure('a', 'INVALID_CREDENTIAL')
  assert.equal(state.accounts[0].state, 'invalid')
  assert.equal(state.activeId, 'b')
})

test('wrapped status codes classify onto pool rules', () => {
  assert.equal(classifyCode('429'), 'RATE_LIMIT')
  assert.equal(classifyCode('401'), 'INVALID_CREDENTIAL')
  assert.equal(classifyCode('503'), 'SERVER')
  assert.equal(classifyCode('TRANSPORT'), 'TRANSPORT')
})

test('an exhausted active account falls back to the next usable one', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  state.accounts[0].state = 'exhausted'
  assert.equal(pool.current().id, 'b')
  assert.equal(state.activeId, 'b')
})

test('all dry means no current account', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }])
  state.accounts[0].state = 'exhausted'
  state.accounts[1].state = 'disabled'
  assert.equal(pool.current(), null)
  assert.equal(state.activeId, null)
})

test('preemption skips an account over the threshold on any window', () => {
  const { pool } = makePool([
    { id: 'a', usage: { rolling: { percent: 96, status: 'ok' }, weekly: { percent: 5 }, monthly: { percent: 10 } } },
    { id: 'b', usage: { rolling: { percent: 10 }, weekly: { percent: 96 }, monthly: { percent: 10 } } },
    { id: 'c', usage: { rolling: { percent: 10 }, weekly: { percent: 10 }, monthly: { percent: 96 } } },
    { id: 'd', usage: { rolling: { percent: 10 }, weekly: { percent: 10 }, monthly: { percent: 10 } } },
  ], { preemptAtPercent: 95 })
  assert.equal(pool.usable(pool.accounts[0]), false)
  assert.equal(pool.usable(pool.accounts[1]), false)
  assert.equal(pool.usable(pool.accounts[2]), false, 'monthly must count too')
  assert.equal(pool.usable(pool.accounts[3]), true)
})

test('threshold 100 disables preemption', () => {
  const { pool } = makePool([
    { id: 'a', usage: { rolling: { percent: 100, status: 'ok' }, weekly: { percent: 100 }, monthly: { percent: 100 } } },
  ], { preemptAtPercent: 100 })
  assert.equal(pool.usable(pool.accounts[0]), true)
})

test('an exhausted account revives only when every window recovered', () => {
  const { state, pool } = makePool([{ id: 'a', state: 'exhausted' }, { id: 'b' }])
  pool.onUsage('a', {
    rolling: { percent: 0, status: 'ok' },
    weekly: { percent: 10, status: 'ok' },
    monthly: { percent: 99, status: 'ok' },
  })
  assert.equal(state.accounts[0].state, 'exhausted', 'monthly at 99% must not revive')

  pool.onUsage('a', {
    rolling: { percent: 0, status: 'ok' },
    weekly: { percent: 10, status: 'ok' },
    monthly: { percent: 20, status: 'ok' },
  })
  assert.equal(state.accounts[0].state, 'healthy')
})

test('quota status keeps an account exhausted', () => {
  const { state, pool } = makePool([{ id: 'a', state: 'exhausted' }])
  pool.onUsage('a', { rolling: { percent: 100, status: 'quota' }, weekly: null, monthly: null })
  assert.equal(state.accounts[0].state, 'exhausted')
})

test('consecutive transient failures rotate at the configured threshold', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }], { switchAfterConsecutiveFailures: 2 })
  assert.equal(pool.onFailure('a', 'RATE_LIMIT'), null)
  const rotation = pool.onFailure('a', 'RATE_LIMIT')
  assert.deepEqual(rotation, { from: 'a', to: 'b', reason: 'consecutive' })
  assert.equal(state.accounts[0].failureStreak, 0)
})

test('a successful request resets the failure streak', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }], { switchAfterConsecutiveFailures: 2 })
  pool.onFailure('a', 'SERVER')
  assert.equal(state.accounts[0].failureStreak, 1)
  pool.onSuccess('a')
  assert.equal(state.accounts[0].failureStreak, 0)
})

test('manual switch and cycle honour usability', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  assert.throws(() => pool.setActive('missing'), /unknown account/)
  assert.equal(pool.cycle().to, 'b')
  assert.equal(state.activeId, 'b')
  state.accounts[1].state = 'exhausted'
  assert.equal(pool.cycle().to, 'c')
  assert.equal(pool.setActive('c'), false)
})

test('disabling the active account picks a replacement; enabling restores it', () => {
  const { state, pool } = makePool([{ id: 'a' }, { id: 'b' }])
  pool.setDisabled('a', true)
  assert.equal(state.accounts[0].state, 'disabled')
  assert.equal(state.activeId, 'b')
  pool.setDisabled('a', false)
  assert.equal(state.accounts[0].state, 'healthy')
  assert.equal(pool.usable(state.accounts[0]), true)
})
