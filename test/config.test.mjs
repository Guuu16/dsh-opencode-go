import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeConfig, persistConfig } from '../src/config.mjs'

const ADMIN = `adm_${'A'.repeat(24)}`

function raw(overrides = {}) {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 8787 },
    auth: { adminToken: ADMIN, tokens: [] },
    providers: [{
      id: 'p',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      keys: [{ id: 'k1', label: 'A', key: 'sk-literal-secret' }],
    }],
    ...overrides,
  }
}

test('an env-referenced key survives a config round-trip as a reference', () => {
  process.env.AIPOOL_TEST_SECRET = 'sk-live-do-not-persist'
  const config = normalizeConfig(raw({
    providers: [{
      id: 'p',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      keys: [{ id: 'k1', label: 'A', key: '${AIPOOL_TEST_SECRET}' }],
    }],
  }))
  assert.equal(config.providers[0].keys[0].key, 'sk-live-do-not-persist')
  assert.equal(config.providers[0].keys[0].keyRef, '${AIPOOL_TEST_SECRET}')

  const path = join(mkdtempSync(join(tmpdir(), 'aipool-cfg-')), 'config.json')
  persistConfig(config, path)
  const written = readFileSync(path, 'utf8')
  assert.match(written, /\$\{AIPOOL_TEST_SECRET\}/)
  assert.equal(written.includes('sk-live-do-not-persist'), false)
})

test('an env-referenced admin token is persisted as a reference too', () => {
  process.env.AIPOOL_TEST_ADMIN = ADMIN
  const config = normalizeConfig(raw({ auth: { adminToken: '${AIPOOL_TEST_ADMIN}', tokens: [] } }))
  const path = join(mkdtempSync(join(tmpdir(), 'aipool-cfg-')), 'config.json')
  persistConfig(config, path)
  const written = readFileSync(path, 'utf8')
  assert.match(written, /\$\{AIPOOL_TEST_ADMIN\}/)
  assert.equal(written.includes(ADMIN), false)
})

test('a malformed CIDR is a ConfigError, not a RangeError at listen time', () => {
  assert.throws(
    () => normalizeConfig(raw({ server: { allowFrom: ['192.168.1.0/33'] } })),
    /prefix between 0 and 32/,
  )
  assert.throws(() => normalizeConfig(raw({ server: { allowFrom: ['not-an-ip'] } })), /not an IP or CIDR/)
  const ok = normalizeConfig(raw({ server: { allowFrom: ['*', '10.0.0.0/8', '::1'] } }))
  assert.deepEqual(ok.server.allowFrom, ['*', '10.0.0.0/8', '::1'])
})

test('aliases.auto is kept instead of silently dropped', () => {
  const config = normalizeConfig(raw({ aliases: { auto: ['p/x', 'p/y'], cheap: ['p/z'] } }))
  assert.deepEqual(config.aliases.auto, ['p/x', 'p/y'])
  assert.deepEqual(config.aliases.cheap, ['p/z'])
})
