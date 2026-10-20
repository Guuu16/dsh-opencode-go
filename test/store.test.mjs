import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, maskSecret, normalizeState } from '../electron/core/store.js'

const crypto = {
  encrypt: plain => `plain:1:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: cipher => Buffer.from(cipher.split(':')[2], 'base64').toString('utf8'),
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-pool-store-'))
  const store = new Store({
    file: join(dir, 'pool.json'),
    ...crypto,
    scheme: 'plain',
    logger: { warn() {} },
  })
  store.load()
  return store
}

test('maskSecret keeps only the prefix and suffix', () => {
  assert.equal(maskSecret('sk-1234567890abcd'), 'sk-…abcd')
  assert.equal(maskSecret('short'), '••••')
  assert.equal(maskSecret(''), '')
})

test('accounts round-trip through the encrypted store', () => {
  const store = makeStore()
  const account = store.addAccount({ label: '主号', secret: 'sk-abcdefghijklmnop' })
  assert.equal(account.hint, 'sk-…mnop')
  assert.equal(store.secretOf(account.id), 'sk-abcdefghijklmnop')
  assert.equal(store.state.activeId, account.id)

  const second = store.addAccount({ label: '', secret: 'sk-second-key-0001' })
  assert.match(second.label, /账号/)
  assert.equal(store.state.accounts.length, 2)
})

test('a fresh secret repairs an invalid account', () => {
  const store = makeStore()
  const account = store.addAccount({ label: '主号', secret: 'sk-abcdefghijklmnop' })
  account.state = 'invalid'
  store.updateAccount(account.id, { secret: 'sk-new-secret-9999' })
  assert.equal(account.state, 'healthy')
  assert.equal(store.secretOf(account.id), 'sk-new-secret-9999')
  assert.equal(store.account(account.id).hint, 'sk-…9999')
})

test('removing an account clears the active pointer', () => {
  const store = makeStore()
  const account = store.addAccount({ label: '主号', secret: 'sk-abcdefghijklmnop' })
  store.removeAccount(account.id)
  assert.equal(store.state.accounts.length, 0)
  assert.equal(store.state.activeId, null)
})

test('store persists across reloads', () => {
  const store = makeStore()
  const account = store.addAccount({ label: '主号', secret: 'sk-abcdefghijklmnop' })
  const reloaded = new Store({ file: store.file, ...crypto, scheme: 'plain', logger: { warn() {} } })
  reloaded.load()
  assert.equal(reloaded.state.accounts.length, 1)
  assert.equal(reloaded.secretOf(account.id), 'sk-abcdefghijklmnop')
})

test('normalizeState drops malformed entries and repairs settings', () => {
  const state = normalizeState({
    activeId: 'gone',
    accounts: [
      { id: 'k-valid', label: ' ok ', state: 'weird', usage: { rolling: { percent: 3 } } },
      { id: 'BAD ID', label: 'x' },
      null,
      { id: 'k-valid', label: 'duplicate' },
    ],
    settings: { preemptAtPercent: 500, switchAfterConsecutiveFailures: -3, usageRefreshMs: 1, proxyEnabled: 'yes' },
  })
  assert.equal(state.accounts.length, 2, 'invalid id is replaced, duplicate dropped, null skipped')
  assert.equal(state.accounts[0].label, 'ok')
  assert.equal(state.accounts[0].state, 'healthy')
  assert.equal(state.activeId, null)
  assert.equal(state.settings.preemptAtPercent, 100)
  assert.equal(state.settings.switchAfterConsecutiveFailures, 0)
  assert.equal(state.settings.usageRefreshMs, 5000)
  assert.equal(state.settings.proxyEnabled, true)
})

test('the gateway access token is generated, persisted and never short', () => {
  const store = makeStore()
  const token = store.state.settings.proxyToken
  assert.match(token, /^sk-pool-[0-9a-f]{40}$/)
  assert.equal(store.state.settings.proxyAuth, true)
  store.save()

  const reloaded = new Store({ file: store.file, ...crypto, scheme: 'plain', logger: { warn() {} } })
  reloaded.load()
  assert.equal(reloaded.state.settings.proxyToken, token)

  const short = normalizeState({ settings: { proxyToken: 'short' } }).settings.proxyToken
  assert.match(short, /^sk-pool-[0-9a-f]{40}$/)
  assert.notEqual(short, token)
})
