import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootGateway, makeConfig, startFake, json, tempHome } from './fake.mjs'

const home = tempHome()

function configFor(upstream) {
  return makeConfig({
    providers: [{
      id: 'p1',
      type: 'openai',
      baseUrl: `${upstream.url}/v1`,
      models: [{ id: 'test-model' }],
      keys: [{ id: 'k1', label: 'A', key: 'sk-a' }, { id: 'k2', label: 'B', key: 'sk-b' }],
    }],
  })
}

test('cooldowns survive a restart, and expired ones heal on load', async () => {
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
    'POST /v1/chat/completions': ({ res, key }) => {
      if (key === 'sk-a') return json(res, 429, { error: { message: 'quota exceeded for this billing period' } })
      return json(res, 200, { choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }] })
    },
  })

  const first = await bootGateway(configFor(upstream))
  try {
    await first.request('/v1/chat/completions', { body: { model: 'test-model', messages: [{ role: 'user', content: 'x' }] } })
    assert.equal(first.gateway.router.snapshot().providers[0].keys[0].state, 'exhausted')
  } finally {
    await first.close()
  }

  const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.ok(persisted.providers.p1.some(entry => entry.id === 'k1' && entry.state === 'exhausted'))

  const second = await bootGateway(configFor(upstream), { restoreState: true })
  try {
    const [key] = second.gateway.router.snapshot().providers[0].keys
    assert.equal(key.state, 'exhausted')
    assert.ok(key.cooldownUntil)
    assert.equal(key.requests, 1)
  } finally {
    await second.close()
  }

  // An already-expired cooldown must not keep a healthy key out of rotation.
  const statePath = join(home, 'state.json')
  const raw = JSON.parse(readFileSync(statePath, 'utf8'))
  for (const entry of raw.providers.p1) {
    entry.cooldownUntil = Date.now() - 1000
    entry.state = 'cooldown'
  }
  writeFileSync(statePath, JSON.stringify(raw))

  const third = await bootGateway(configFor(upstream), { restoreState: true })
  try {
    const snapshot = third.gateway.router.snapshot()
    assert.ok(snapshot.providers[0].keys.every(key => key.state === 'healthy'))
  } finally {
    await third.close()
    await upstream.close()
  }
})

test('stale quota facts are discarded on load', async () => {
  const upstream = await startFake({
    'GET /v1/models': ({ res }) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] }),
  })
  const config = configFor(upstream)
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    providers: {
      p1: [{
        id: 'k1',
        state: 'healthy',
        cooldownUntil: 0,
        quota: { rolling: { percent: 99, status: 'ok' }, weekly: { percent: 99 } },
        quotaFetchedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
      }],
    },
  }))
  const gateway = await bootGateway(config, { restoreState: true })
  try {
    const [key] = gateway.gateway.router.snapshot().providers[0].keys
    assert.equal(key.quota, null)
  } finally {
    await gateway.close()
    await upstream.close()
  }
})
