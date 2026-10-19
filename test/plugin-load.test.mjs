/**
 * Load-and-construct smoke test for the plugin's own module.
 *
 * The host half imports ten packages that only exist inside the DSH runtime, so
 * a plain import can never run here. This test builds a throwaway package
 * directory with stub versions of those imports and then imports the real
 * `index.js` from it, so a module-scope or constructor-time error fails the
 * suite instead of failing silently at DSH startup.
 *
 * Regression it exists for: a `const VOLATILE_WRITE = ...` declaration was once
 * swallowed into the preceding `//` comment, leaving `toPlain()` referencing an
 * undefined binding. Syntax checks passed, the plugin composed fine, and the
 * constructor threw a ReferenceError that DSH only logged — the plugin silently
 * never mounted. Nothing short of constructing the class catches that.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every runtime file the host half imports, plus its manifest. */
const RUNTIME_FILES = [
  'index.js',
  'pool.js',
  'usage.js',
  'models.js',
  'typert.host.js',
  'client.js',
  'package.json',
]

/**
 * Stand-ins for the DSH runtime packages. Each is the smallest surface the host
 * half touches while its module is evaluated and its plugin instance built.
 */
const STUBS = {
  // Schemastery is only used to declare Config; every access returns a
  // chainable schema-like callable so the declaration itself cannot fail.
  '@deepseek-ai/schemastery': `
const chain = () => new Proxy(function () {}, { get: () => chain, apply: () => chain })
export default new Proxy({}, { get: () => chain })
`,
  '@deepseek-ai/dsh-typert-protocol': `
export class TypertRemoteService { constructor(ctx, name) { this.ctx = ctx; this.name = name } }
`,
  '@deepseek-ai/dsh-credentials': `
export const credentialRef = (name) => ({ name })
`,
  '@deepseek-ai/dsh-home-paths': `
import { join } from 'node:path'
export const dshHomePath = (name) => join(process.env.PLUGIN_LOAD_TEST_HOME, name)
`,
  '@deepseek-ai/dsh-llm': `
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const QUOTA_EXCEEDED_CODE = 'QUOTA'
export class LlmAdapter {}
export class LlmError extends Error { constructor(message, code) { super(message); this.code = code } }
export const assertUsableApiKey = (value) => value
export const resolveRetryPolicy = (config) => config ?? { mode: 'normal', maxRetries: 5, retryableCodes: [] }
`,
  '@deepseek-ai/dsh-llm-pi-ai': `
export class PiAiAdapter { constructor(options) { this.options = options } async *stream() {} }
`,
  '@earendil-works/pi-ai/providers/opencode-go': `
export const opencodeGoProvider = () => ({ id: 'opencode-go', getModels: () => [] })
`,
  zod: 'export default {}',
}

/** Write one stub package: `<modules>/<name>/package.json` + `index.js`. */
function writeStub(modules, name, source, manifest = {}) {
  const dir = join(modules, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    main: 'index.js',
    ...manifest,
  }))
  writeFileSync(join(dir, 'index.js'), source)
}

/**
 * Build the throwaway package: real runtime files plus the stub module tree.
 * @returns {{ dir: string, home: string }} package dir and its private DSH home.
 */
function buildSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencode-go-load-'))
  const dir = join(root, 'package')
  mkdirSync(dir, { recursive: true })
  for (const file of RUNTIME_FILES) copyFileSync(join(pkgRoot, file), join(dir, file))

  const modules = join(dir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const [name, source] of Object.entries(STUBS)) writeStub(modules, name, source)
  // The pi-ai subpath must be declared, or Node refuses the directory import.
  writeFileSync(join(modules, '@earendil-works/pi-ai/package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    type: 'module',
    exports: { './providers/opencode-go': './providers/opencode-go/index.js' },
  }))

  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { dir, home }
}

/** Minimal Cordis context: logger, lifecycle subscription, service lookup. */
function makeContext(events, { credentials } = {}) {
  return {
    logger: { info() {}, warn() {} },
    on(event) { events.push(event); return () => {} },
    get(name) {
      if (name === 'credentials') {
        return credentials ?? { resolve: async () => ({ value: 'sk-test-key' }) }
      }
      return undefined
    },
    llm: { registerAdapter: () => ({ replace() {} }) },
  }
}

/** The production-shaped config, including the two real key refs. */
function makeConfig() {
  return {
    route: 'opencode-go',
    keys: [
      { id: 'key-mv0qbswj', label: 'outlook', apiKeyEnv: 'OPENCODE_GO_KEY_KEY_MV0QBSWJ' },
      { id: 'key-mv0qeq4h', label: 'gmail', apiKeyEnv: 'OPENCODE_GO_KEY_KEY_MV0QEQ4H' },
    ],
    preemptAtPercent: 90,
    switchAfterConsecutiveFailures: 4,
    modelMode: 'all',
    models: [],
    usageBaseUrl: 'https://opencode.ai/zen/go/v1/usage',
    modelsBaseUrl: 'https://opencode.ai/zen/go/v1/models',
    usageRefreshMs: 30000,
    timeoutMs: 15000,
  }
}

let sandbox
let module

/** Import the real host half once, through the stub tree. */
async function loadModule() {
  if (module !== undefined) return module
  sandbox = buildSandbox()
  process.env.PLUGIN_LOAD_TEST_HOME = sandbox.home
  module = await import(pathToFileURL(join(sandbox.dir, 'index.js')).href)
  return module
}

test('the host module evaluates against the DSH runtime surface', async () => {
  const loaded = await loadModule()
  assert.equal(loaded.name, 'dsh-opencode-go')
  assert.ok(loaded.Config !== undefined, 'Config must be exported')
  assert.equal(typeof loaded.OpenCodeGoPool, 'function')
})

test('constructing the plugin registers the route and persists state', async () => {
  const loaded = await loadModule()
  const events = []
  const plugin = new loaded.OpenCodeGoPool(makeContext(events), makeConfig())

  // The route registration is what makes the provider usable at all.
  assert.equal(plugin.servingRoute, 'opencode-go')
  // Budget must cover the configured rotation: 2 keys × threshold 4.
  assert.equal(plugin.retryBudget(), 8)
  assert.equal(plugin.pool.keyCount(), 2)
  assert.equal(plugin.pool.currentKey()?.id, 'key-mv0qbswj')
  // syncKeys() persists on construction; a swallow here would lose them silently.
  assert.ok(existsSync(join(sandbox.home, 'dsh-opencode-go.state.json')))
  assert.deepEqual(events, ['loader/volatile-update', 'llm/adapters-updated'])
})

test('the constructor tolerates a config with no keys', async () => {
  const loaded = await loadModule()
  const plugin = new loaded.OpenCodeGoPool(makeContext([]), { ...makeConfig(), keys: [] })
  assert.equal(plugin.pool.keyCount(), 0)
  assert.equal(plugin.pool.currentKey(), null)
  // No keys to rotate over, but the threshold still asks for 4 attempts.
  assert.equal(plugin.retryBudget(), 4)
})

test('the model catalog resolves the active pool key', async () => {
  // Newer runtimes call resolveApiKey while listing models. It must hand back a
  // real credential; an unconditional throw turns "list models" into a hard
  // catalog load failure in the model picker.
  const loaded = await loadModule()
  const plugin = new loaded.OpenCodeGoPool(makeContext([]), makeConfig())
  const resolveApiKey = plugin.innerCatalog.options.resolveApiKey
  assert.equal(typeof resolveApiKey, 'function')
  assert.equal(await resolveApiKey('opencode-go', {}), 'sk-test-key')
})

test('a pool with no usable key reports MISSING_CREDENTIAL, not a load failure', async () => {
  // The runtime turns exactly this code into an empty model list; any other
  // error surfaces as a broken catalog.
  const loaded = await loadModule()
  const plugin = new loaded.OpenCodeGoPool(makeContext([]), { ...makeConfig(), keys: [] })
  await assert.rejects(
    () => plugin.innerCatalog.options.resolveApiKey('opencode-go', {}),
    (error) => error.code === 'MISSING_CREDENTIAL',
  )
})

test('module-scope declarations are not swallowed by comments', async () => {
  // Direct guard for the regression above: a declaration glued onto the tail of
  // a `//` line becomes part of the comment, and only a load can reveal it.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(pkgRoot, 'index.js'), 'utf8')
  assert.match(source, /^const VOLATILE_WRITE = Symbol\.for\('cosmokit\.volatile\.write'\)$/m)
  for (const [lineNumber, line] of source.split('\n').entries()) {
    // A trailing comment must not end in something that looks like a statement.
    assert.doesNotMatch(
      line,
      /\/\/[^\n]*?\S\.(const|let|var|function|class|import|export)\s/,
      `line ${lineNumber + 1} looks like code swallowed by a comment: ${line}`,
    )
  }
})

test('a custom model selection with no ids exposes no models', async () => {
  // Regression: `custom` + empty list used to read as "all models", silently
  // re-enabling every model the user had unchecked (and contradicting the
  // card's own "no model selected" message).
  const loaded = await loadModule()
  const plugin = new loaded.OpenCodeGoPool(makeContext([]), {
    ...makeConfig(),
    modelMode: 'custom',
    models: [],
  })
  const selection = plugin.modelSelection()
  assert.ok(selection instanceof Set, 'a custom selection must not collapse to null (= all)')
  assert.equal(selection.size, 0)
})

test('a malformed key entry is reported but never aborts construction', async () => {
  // DSH only logs a constructor throw: a hand-edited yml with one bad key used
  // to make the whole plugin silently never mount.
  const loaded = await loadModule()
  const events = []
  const plugin = new loaded.OpenCodeGoPool(makeContext(events), {
    ...makeConfig(),
    keys: [{ id: 'BAD ID', label: '', apiKeyEnv: '' }],
  })
  assert.equal(plugin.pool.keyCount(), 0)
  assert.equal(plugin.servingRoute, 'opencode-go')
})
