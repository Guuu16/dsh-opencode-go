import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../electron/core/store.js'
import { Controller } from '../electron/core/controller.js'
import { UsageError } from '../electron/core/usage.js'

const crypto = {
  encrypt: plain => `plain:1:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: cipher => Buffer.from(cipher.split(':')[2], 'base64').toString('utf8'),
}

function makeController(fetchUsageImpl) {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-pool-controller-'))
  const store = new Store({ file: join(dir, 'pool.json'), ...crypto, scheme: 'plain', logger: { warn() {} } })
  store.load()
  const controller = new Controller({ store, fetchUsageImpl, now: () => 0, autoStartProxy: false })
  controller.init()
  return { store, controller }
}

const usage = {
  rolling: { status: 'ok', percent: 20, resetsAt: '2026-01-01T05:00:00.000Z' },
  weekly: { status: 'ok', percent: 30, resetsAt: null },
  monthly: { status: 'ok', percent: 5, resetsAt: null },
}

test('adding an account makes it active and refresh feeds usage', async t => {
  const { store, controller } = makeController(async () => usage)
  t.after(() => controller.dispose())
  const id = controller.addAccount({ label: '主号', secret: 'sk-abcdefghijklmnop' })
  assert.equal(store.state.activeId, id)
  assert.equal(store.secretOf(id), 'sk-abcdefghijklmnop')

  const result = await controller.refreshUsage()
  assert.equal(result.updated, 1)
  const snapshot = controller.snapshot()
  assert.equal(snapshot.accounts[0].usage.rolling.percent, 20)
  assert.equal(snapshot.usable, 1)
  assert.equal(snapshot.accounts[0].hint, 'sk-…mnop')
})

test('a 401 usage response marks the key invalid and rotates', async t => {
  let active = 'first'
  const { store, controller } = makeController(async ({ apiKey }) => {
    if (apiKey === 'sk-first-key-0001') throw new UsageError('unauthorized', '401')
    return usage
  })
  t.after(() => controller.dispose())
  const first = controller.addAccount({ label: '一号', secret: 'sk-first-key-0001' })
  controller.addAccount({ label: '二号', secret: 'sk-second-key-0002' })

  await controller.refreshUsage()
  assert.equal(store.account(first).state, 'invalid')
  assert.notEqual(store.state.activeId, first, 'pool rotated away from the invalid key')
  assert.equal(store.state.lastSwitch.reason, 'invalid')
})

test('settings validation rejects out-of-range values', t => {
  const { controller } = makeController(async () => usage)
  t.after(() => controller.dispose())
  assert.throws(() => controller.updateSettings({ preemptAtPercent: 101 }), /0–100/)
  assert.throws(() => controller.updateSettings({ switchAfterConsecutiveFailures: 21 }), /0–20/)
  assert.throws(() => controller.updateSettings({ proxyPort: 80 }), /1024/)
  assert.equal(controller.updateSettings({ preemptAtPercent: 80 }).preemptAtPercent, 80)
})

test('removing the last account leaves the pool empty, not broken', t => {
  const { store, controller } = makeController(async () => usage)
  t.after(() => controller.dispose())
  const id = controller.addAccount({ label: '主号', secret: 'sk-abcdefghijklmnop' })
  controller.removeAccount(id)
  assert.equal(store.state.accounts.length, 0)
  assert.equal(store.state.activeId, null)
  assert.equal(controller.snapshot().proxy.running, false)
})

test('snapshot never exposes the secret', async t => {
  const { controller } = makeController(async () => usage)
  t.after(() => controller.dispose())
  controller.addAccount({ label: '主号', secret: 'sk-super-secret-key-123' })
  const serialized = JSON.stringify(controller.snapshot())
  assert.equal(serialized.includes('sk-super-secret-key-123'), false)
  assert.equal(serialized.includes('cipher'), false)
})

test('listModels presents the gateway token when the proxy is running', async t => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers['x-pool-token'])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))

  const { store, controller } = makeController(async () => usage)
  t.after(() => controller.dispose())
  store.state.settings.proxyToken = 'sk-pool-controller-test-1234'
  controller.proxyInfo = { running: true, host: '127.0.0.1', port: server.address().port }

  const result = await controller.listModels()
  assert.deepEqual(result.models.map(model => model.id), ['m-one', 'm-two'])
  assert.equal(seen[0], 'sk-pool-controller-test-1234')
})
