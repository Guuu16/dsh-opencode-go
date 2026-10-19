#!/usr/bin/env node
/**
 * aipool — N upstream LLM keys → one LAN endpoint + one token.
 *
 *   aipool init                 first-run setup (admin token, starter config)
 *   aipool serve                run the gateway (foreground)
 *   aipool status               live pool state from the running daemon
 *   aipool key add|ls|rm|test   manage upstream keys
 *   aipool token new|ls|revoke  manage client tokens
 *   aipool provider add|ls      manage upstream providers
 *   aipool install|uninstall    macOS LaunchAgent (boot-safe on a Mac mini)
 *   aipool doctor               preflight checks
 */

import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG_VERSION,
  DEFAULT_COOLDOWNS,
  DEFAULT_ROUTING,
  DEFAULT_SERVER,
  addKey,
  createClientToken,
  loadConfig,
  normalizeConfig,
  persistConfig,
  removeKey,
  starterConfig,
} from '../src/config.mjs'
import { buildUpstreamRequest, joinUrl } from '../src/protocol.mjs'
import {
  ConfigError,
  aipoolHome,
  configPath as configFile,
  humanDuration,
  lanAddressHint,
  logPath,
  maskSecret,
  pidPath,
  randomToken,
} from '../src/util.mjs'
import * as launchd from '../src/launchd.mjs'

const BIN = fileURLToPath(import.meta.url)
const VERSION = '0.1.0'

// `aipool status | head` closes stdout early; that is not an error worth a
// stack trace and a non-zero exit code.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0)
  })
}

const color = process.env.NO_COLOR || !process.stdout.isTTY
  ? { dim: s => s, bold: s => s, green: s => s, red: s => s, yellow: s => s, cyan: s => s, gray: s => s }
  : {
      dim: s => `\u001b[2m${s}\u001b[0m`,
      bold: s => `\u001b[1m${s}\u001b[0m`,
      green: s => `\u001b[32m${s}\u001b[0m`,
      red: s => `\u001b[31m${s}\u001b[0m`,
      yellow: s => `\u001b[33m${s}\u001b[0m`,
      cyan: s => `\u001b[36m${s}\u001b[0m`,
      gray: s => `\u001b[90m${s}\u001b[0m`,
    }

function fail(message) {
  process.stderr.write(`${color.red('✗')} ${message}\n`)
  process.exitCode = 1
}

function ok(message) {
  process.stdout.write(`${color.green('✓')} ${message}\n`)
}

function info(message) {
  process.stdout.write(`${message}\n`)
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        index += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function table(rows, headers) {
  if (rows.length === 0) return ''
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => String(row[index] ?? '').length)))
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')
  return [color.dim(line(headers)), color.dim(widths.map(width => '─'.repeat(width)).join('  ')), ...rows.map(line)].join('\n')
}

function requireConfig() {
  return loadConfig()
}

function baseUrlFor(config) {
  const host = config.server.host === '0.0.0.0' || config.server.host === '::' ? lanAddressHint(config.server.host) : config.server.host
  const port = daemonInfo()?.port ?? config.server.port
  return `http://${host}:${port}/v1`
}

function localUrl(config) {
  const host = config.server.host === '0.0.0.0' || config.server.host === '::' ? '127.0.0.1' : config.server.host
  // `serve --port N` overrides the file; ask the pid file which port is live.
  const port = daemonInfo()?.port ?? config.server.port
  return `http://${host}:${port}`
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  process.stdout.write(prompt)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let value = ''
  return new Promise((resolvePromise) => {
    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolvePromise(value.trim())
          return
        }
        if (char === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        value += char
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

async function api(config, path, { method = 'GET', body = null } = {}) {
  const url = `${localUrl(config)}${path}`
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${config.auth.adminToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  if (!response.ok) throw new Error(`daemon 返回 ${response.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`)
  return json
}

/** `{pid, port}` of the live daemon, or null. Accepts the legacy bare-pid file. */
function daemonInfo() {
  let raw
  try {
    raw = readFileSync(pidPath(), 'utf8').trim()
  } catch {
    return null
  }
  let pid = null
  let port = null
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      pid = Number(parsed.pid)
      port = Number(parsed.port)
    } catch {
      return null
    }
  } else {
    pid = Number(raw)
  }
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
  } catch {
    return null
  }
  return { pid, port: Number.isInteger(port) && port > 0 ? port : null }
}

function daemonPid() {
  return daemonInfo()?.pid ?? null
}

function nudgeDaemon() {
  const pid = daemonPid()
  if (!pid) return false
  try {
    process.kill(pid, 'SIGHUP')
    return true
  } catch {
    return false
  }
}

// ---- commands --------------------------------------------------------------

async function cmdInit({ flags }) {
  const path = configFile()
  if (existsSync(path) && flags.force !== true) {
    fail(`配置已存在：${path}（要重建加 --force）`)
    return
  }
  const adminToken = randomToken('adm_')
  const raw = starterConfig({ adminToken })
  if (flags.port) raw.server.port = Number(flags.port)
  const { record, plain } = createClientToken({ auth: { tokens: [] } }, {
    name: flags.name || 'first-client',
  })
  raw.auth.tokens = [record]
  persistConfig({ ...raw, configPath: path }, path)
  ok(`配置已写入 ${path}`)
  info('')
  info(`${color.bold('下一步：')}`)
  info(`  1. 加一个上游 Key：  ${color.cyan('aipool key add --provider opencode-go --label 账号A')}`)
  info(`  2. 启动：           ${color.cyan('aipool serve')}`)
  info(`  3. 局域网客户端用这个 token 访问：`)
  info(`     ${color.bold(plain)}   ${color.dim('(只显示这一次，已存哈希)')}`)
  info('')
  info(color.dim(`  admin token（dashboard 用）：${adminToken}`))
  info(color.dim(`  配置文件：${path}  (0600)`))
}

async function cmdServe({ flags }) {
  const { createGateway } = await import('../src/server.mjs')
  let config = requireConfig()
  if (flags.port) config.server.port = Number(flags.port)
  if (flags.host) config.server.host = String(flags.host)
  const gateway = await createGateway({ config })
  const { host, port } = await gateway.start()
  writeFileSync(pidPath(), `${JSON.stringify({ pid: process.pid, port })}\n`)
  const cleanup = () => {
    try {
      if (daemonInfo()?.pid === process.pid) unlinkSync(pidPath())
    } catch {}
  }
  const shutdown = async (signal) => {
    info(`\n${color.dim(`收到 ${signal}，正在关闭…`)}`)
    cleanup()
    await gateway.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGHUP', () => {
    try {
      const next = loadConfig()
      gateway.reload(next)
      config = next
      info(color.dim('配置已热加载'))
    } catch (error) {
      fail(`热加载失败，继续用旧配置：${error.message}`)
    }
  })
  process.on('exit', cleanup)
  if (process.stdout.isTTY) {
    info(`${color.bold('aipool')} ${VERSION} running`)
    info(`  端点   ${color.cyan(`http://${host}:${port}/v1`)}`)
    info(`  面板   ${color.cyan(`http://${host}:${port}/?token=${config.auth.adminToken}`)}`)
    info(color.dim(`  日志   stderr · 快捷键 Ctrl-C 退出`))
  }
}

function resolveTokenRef(config, ref) {
  if (!ref) throw new ConfigError('需要一个 token id 或名字')
  const token = config.auth.tokens.find(item => item.id === ref || item.name === ref)
  if (!token) throw new ConfigError(`没有 token "${ref}"`)
  return token
}

function resolveProviderRef(config, ref) {
  if (!ref) throw new ConfigError('需要 --provider <id>')
  const provider = config.providers.find(item => item.id === ref || item.name === ref)
  if (!provider) throw new ConfigError(`没有 provider "${ref}"（已有：${config.providers.map(item => item.id).join(', ') || '无'}）`)
  return provider
}

async function cmdToken({ flags, positional }) {
  const sub = positional[0] ?? 'ls'
  const config = requireConfig()
  if (sub === 'new' || sub === 'create') {
    const { record, plain } = createClientToken(config, {
      name: flags.name || `client-${config.auth.tokens.length + 1}`,
      rpm: flags.rpm ? Number(flags.rpm) : null,
      models: flags.models ? String(flags.models).split(',').map(item => item.trim()).filter(Boolean) : null,
    })
    persistConfig(config)
    nudgeDaemon()
    ok(`token ${record.id} (${record.name}) 已创建`)
    info(`\n${color.bold(plain)}\n`)
    info(color.dim('只显示这一次。客户端用法：'))
    info(color.dim(`  OPENAI_BASE_URL=${baseUrlFor(config)}  OPENAI_API_KEY=${plain}`))
    info(color.dim(`  curl ${baseUrlFor(config)}/models -H "Authorization: Bearer ${plain}"`))
    return
  }
  if (sub === 'ls' || sub === 'list') {
    const rows = config.auth.tokens.map(token => [
      token.id,
      token.name,
      token.disabled ? color.red('disabled') : color.green('active'),
      token.rpm ?? '-',
      token.models ? token.models.join(',') : 'all',
      token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : 'never',
      String(token.requests),
    ])
    info(table(rows, ['ID', 'NAME', 'STATE', 'RPM', 'MODELS', 'LAST USED', 'REQ']))
    return
  }
  if (sub === 'revoke' || sub === 'rm') {
    const token = resolveTokenRef(config, positional[1] ?? flags.name ?? flags.id)
    config.auth.tokens = config.auth.tokens.filter(item => item.id !== token.id)
    persistConfig(config)
    nudgeDaemon()
    ok(`token ${token.id} (${token.name}) 已撤销`)
    return
  }
  if (sub === 'disable' || sub === 'enable') {
    const token = resolveTokenRef(config, positional[1] ?? flags.name ?? flags.id)
    token.disabled = sub === 'disable'
    persistConfig(config)
    nudgeDaemon()
    ok(`token ${token.id} 已${sub === 'disable' ? '停用' : '启用'}`)
    return
  }
  fail(`未知子命令 token ${sub}`)
}

async function cmdKey({ flags, positional }) {
  const sub = positional[0] ?? 'ls'
  const config = requireConfig()
  if (sub === 'add') {
    const provider = resolveProviderRef(config, flags.provider)
    let secret = typeof flags.key === 'string' ? flags.key.trim() : ''
    if (!secret) secret = await readSecret(`粘贴 ${provider.name} 的 API Key（不回显）: `)
    if (!secret) throw new ConfigError('key 不能为空')
    const label = String(flags.label ?? `key-${provider.keys.length + 1}`)
    const record = addKey(config, provider.id, { key: secret, label, weight: flags.weight ? Number(flags.weight) : 1 })
    persistConfig(config)
    const nudged = nudgeDaemon()
    ok(`已添加 ${provider.id}/${record.id} (${label}) ${color.dim(maskSecret(secret))}`)
    if (nudged) info(color.dim('已通知运行中的 daemon 热加载'))
    return
  }
  if (sub === 'ls' || sub === 'list') {
    const rows = []
    for (const provider of config.providers) {
      if (provider.keys.length === 0) rows.push([provider.id, '-', color.dim('(no keys)'), '', '', ''])
      for (const key of provider.keys) {
        rows.push([
          provider.id,
          key.id,
          key.label,
          key.enabled ? color.green('enabled') : color.red('disabled'),
          maskSecret(key.key),
          String(key.weight),
        ])
      }
    }
    info(table(rows, ['PROVIDER', 'ID', 'LABEL', 'STATE', 'KEY', 'WEIGHT']))
    return
  }
  if (sub === 'rm' || sub === 'remove') {
    const provider = resolveProviderRef(config, flags.provider)
    const removed = removeKey(config, provider.id, positional[1] ?? flags.id ?? flags.label)
    persistConfig(config)
    nudgeDaemon()
    ok(`已删除 ${provider.id}/${removed.id} (${removed.label})`)
    return
  }
  if (sub === 'test' || sub === 'probe') {
    await probeKeys(config, flags.provider ? [resolveProviderRef(config, flags.provider)] : config.providers)
    return
  }
  fail(`未知子命令 key ${sub}`)
}

function cachedCatalog() {
  try {
    return JSON.parse(readFileSync(join(aipoolHome(), 'catalog.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function probeKeys(config, providers) {
  const rows = []
  const catalog = cachedCatalog()
  for (const provider of providers) {
    if (provider.keys.length === 0) continue
    // Static models first; fall back to whatever the catalog fetch learned.
    const model = provider.models[0]?.id ?? catalog[provider.id]?.[0]?.id ?? null
    if (!model) {
      rows.push([provider.id, '-', color.yellow('skipped'), '目录还没拉到，先加 --model 或启动一次 daemon'])
      continue
    }
    for (const key of provider.keys) {
      if (!key.enabled) {
        rows.push([provider.id, key.id, color.dim('disabled'), ''])
        continue
      }
      const started = Date.now()
      try {
        const request = buildUpstreamRequest({
          provider,
          apiKey: key.key,
          modelId: model,
          canonical: { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], stream: false },
          signal: AbortSignal.timeout(30_000),
        })
        const response = await fetch(request.url, request.init)
        const text = await response.text()
        const ms = Date.now() - started
        if (response.ok) {
          rows.push([provider.id, key.id, color.green('ok'), `${ms}ms`, model])
        } else {
          rows.push([provider.id, key.id, color.red(`HTTP ${response.status}`), `${ms}ms`, text.slice(0, 90).replace(/\s+/g, ' ')])
        }
      } catch (error) {
        rows.push([provider.id, key.id, color.red('error'), `${Date.now() - started}ms`, error.message.slice(0, 90)])
      }
    }
  }
  info(table(rows, ['PROVIDER', 'KEY', 'RESULT', 'LATENCY', 'DETAIL']))
}

async function cmdProvider({ flags, positional }) {
  const sub = positional[0] ?? 'ls'
  const config = requireConfig()
  if (sub === 'ls' || sub === 'list') {
    const rows = config.providers.map(provider => [
      provider.id,
      provider.type,
      provider.enabled ? color.green('on') : color.red('off'),
      String(provider.priority),
      provider.baseUrl,
      String(provider.keys.length),
      provider.models.map(model => model.id).join(',') || '-',
    ])
    info(table(rows, ['ID', 'TYPE', 'STATE', 'PRIORITY', 'BASE URL', 'KEYS', 'STATIC MODELS']))
    return
  }
  if (sub === 'add') {
    const id = String(flags.id ?? '').trim()
    if (!id) throw new ConfigError('需要 --id')
    if (config.providers.some(item => item.id === id)) throw new ConfigError(`provider "${id}" 已存在`)
    const type = flags.type === 'anthropic' ? 'anthropic' : 'openai'
    const baseUrl = String(flags['base-url'] ?? '').trim()
    if (!baseUrl) throw new ConfigError('需要 --base-url，例如 https://api.deepseek.com/v1')
    const models = flags.model ? String(flags.model).split(',').map(item => item.trim()).filter(Boolean).map(modelId => ({ id: modelId })) : []
    config.providers.push({
      id,
      name: flags.name ?? id,
      type,
      baseUrl,
      chatPath: flags.path ?? (type === 'anthropic' ? '/v1/messages' : '/chat/completions'),
      modelsPath: flags['models-path'] ?? (type === 'anthropic' ? '/v1/models' : '/models'),
      authHeader: flags['auth-header'] ?? (type === 'anthropic' ? 'x-api-key' : 'bearer'),
      anthropicVersion: '2023-06-01',
      priority: Number(flags.priority ?? 100),
      enabled: true,
      timeoutMs: 300_000,
      models,
      modelsUrl: flags['models-url'] ?? null,
      usageUrl: flags['usage-url'] ?? null,
      usageRefreshMs: 60_000,
      preemptAtPercent: 100,
      headers: {},
      keys: [],
    })
    config.providers.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    // Re-validate through the same normalizer the daemon uses, so a typo in
    // --id or --base-url can never produce a config the daemon refuses to load.
    const validated = normalizeConfig({
      version: CONFIG_VERSION,
      server: config.server,
      auth: config.auth,
      routing: config.routing,
      cooldown: config.cooldown,
      providers: config.providers,
      aliases: config.aliases,
    })
    config.providers = validated.providers
    persistConfig(config)
    nudgeDaemon()
    ok(`已添加 provider ${id}（${type} → ${baseUrl}）`)
    info(color.dim(`下一步：aipool key add --provider ${id} --label 账号A`))
    return
  }
  if (sub === 'rm' || sub === 'remove') {
    const provider = resolveProviderRef(config, positional[1] ?? flags.id)
    config.providers = config.providers.filter(item => item.id !== provider.id)
    persistConfig(config)
    nudgeDaemon()
    ok(`已删除 provider ${provider.id}`)
    return
  }
  fail(`未知子命令 provider ${sub}`)
}

async function cmdStatus({ flags }) {
  const config = requireConfig()
  let snapshot
  try {
    snapshot = await api(config, '/admin/status')
  } catch (error) {
    fail(`daemon 没在跑？${error.message}`)
    info(color.dim(`  启动：aipool serve      或      aipool install（开机自启）`))
    return
  }
  if (flags.json) {
    info(JSON.stringify(snapshot, null, 2))
    return
  }
  const counters = snapshot.counters
  info(`${color.bold('aipool')} ${snapshot.version} · up ${humanDuration(snapshot.uptimeSec * 1000)}`)
  info(`${color.dim('端点')} ${color.cyan(baseUrlFor(config))}`)
  info(`${color.dim('请求')} ${counters.requests}  ${color.dim('成功')} ${counters.ok}  ${color.dim('失败')} ${counters.failed}  ${color.dim('重试')} ${counters.retries}  ${color.dim('token')} ${counters.tokensIn}↓/${counters.tokensOut}↑`)
  info('')
  for (const provider of snapshot.providers) {
    const badge = !provider.enabled
      ? color.red('off')
      : provider.keys.length === 0
        ? color.dim('no keys')
        : provider.healthy ? color.green('healthy') : color.yellow('degraded')
    info(`${color.bold(provider.name)} ${color.dim(`(${provider.id} · ${provider.type} · p${provider.priority})`)} ${badge}  ${color.dim(`${provider.models.length} models`)}`)
    const rows = provider.keys.map(key => [
      key.id,
      key.label,
      colorizeState(key.state),
      key.cooldownUntil ? humanDuration(new Date(key.cooldownUntil) - Date.now()) : '-',
      quotaCell(key.quota),
      `${key.requests}/${key.errors}`,
      key.latencyMsAvg === null ? '-' : `${key.latencyMsAvg}ms`,
    ])
    info(table(rows, ['KEY', 'LABEL', 'STATE', 'COOLDOWN', '5h / WEEK', 'REQ/ERR', 'LATENCY']))
    info('')
  }
  if (snapshot.tokens.length > 0) {
    const rows = snapshot.tokens.map(token => [
      token.id,
      token.name,
      token.disabled ? color.red('disabled') : color.green('active'),
      token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleTimeString() : 'never',
      String(token.requests),
    ])
    info(color.dim('CLIENT TOKENS'))
    info(table(rows, ['ID', 'NAME', 'STATE', 'LAST USED', 'REQ']))
  }
}

function colorizeState(state) {
  if (state === 'healthy') return color.green(state)
  if (state === 'cooldown') return color.yellow(state)
  if (state === 'exhausted') return color.red(state)
  if (state === 'invalid') return color.red(state)
  return color.dim(state)
}

function bar(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  const filled = Math.round(value / 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${String(Math.round(value)).padStart(3)}%`
}

function quotaCell(quota) {
  if (!quota) return '-'
  const rolling = quota.rolling?.percent
  const weekly = quota.weekly?.percent
  if (rolling === undefined && weekly === undefined) return '-'
  return `${rolling === null || rolling === undefined ? '?' : bar(rolling)} ${color.dim('/')} ${weekly === null || weekly === undefined ? '?' : bar(weekly)}`
}

async function cmdConfig({ flags }) {
  const config = requireConfig()
  if (flags.json) {
    info(JSON.stringify(config, null, 2))
    return
  }
  info(color.dim(`配置文件 ${config.configPath}`))
  info(JSON.stringify({
    server: config.server,
    routing: config.routing,
    cooldown: config.cooldown,
    providers: config.providers.map(provider => ({
      ...provider,
      keys: provider.keys.map(key => ({ ...key, key: maskSecret(key.key) })),
    })),
  }, null, 2))
}

async function cmdDoctor() {
  let problems = 0
  const path = configFile()
  info(`${color.bold('aipool doctor')}`)
  if (!existsSync(path)) {
    fail(`没有配置文件 ${path}（先 aipool init）`)
    return
  }
  ok(`配置文件 ${path}`)
  let config
  try {
    config = loadConfig()
    ok(`配置合法：${config.providers.length} providers / ${config.providers.reduce((sum, provider) => sum + provider.keys.length, 0)} keys / ${config.auth.tokens.length} tokens`)
  } catch (error) {
    fail(`配置错误：${error.message}`)
    return
  }
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor >= 20) ok(`Node ${process.versions.node}`)
  else { fail(`Node ${process.versions.node} 太旧，需要 >= 20`); problems += 1 }

  const pid = daemonPid()
  info(pid ? `${color.green('✓')} daemon 在跑（pid ${pid}）` : `${color.yellow('•')} daemon 没在跑（后台常驻用 aipool install）`)

  const service = launchd.status()
  info(service.installed
    ? `${color.green('✓')} LaunchAgent 已安装${service.running ? `（pid ${service.pid}）` : color.yellow('，但当前没运行')}`
    : `${color.dim('•')} 未安装 LaunchAgent（开机自启：aipool install）`)

  for (const provider of config.providers) {
    if (provider.keys.length === 0) {
      info(`${color.yellow('•')} ${provider.id}: 没有 key`)
      continue
    }
    const enabled = provider.keys.filter(key => key.enabled).length
    info(`${color.green('✓')} ${provider.id}: ${enabled}/${provider.keys.length} key 启用 · ${provider.baseUrl}`)
  }

  if (config.server.host === '0.0.0.0') ok('监听 0.0.0.0（局域网可达）')
  else info(`${color.yellow('•')} 监听 ${config.server.host}（局域网不可达，改 server.host 为 0.0.0.0）`)
  info(color.dim(`允许来源：${config.server.allowFrom.join(', ')}`))

  const portBusy = await new Promise((resolvePromise) => {
    import('node:net').then(({ createConnection }) => {
      const socket = createConnection({ host: '127.0.0.1', port: config.server.port }, () => {
        socket.destroy()
        resolvePromise(true)
      })
      socket.on('error', () => resolvePromise(false))
      socket.setTimeout(800, () => {
        socket.destroy()
        resolvePromise(false)
      })
    })
  })
  info(portBusy
    ? `${color.green('✓')} 端口 ${config.server.port} 已有服务在听`
    : `${color.dim('•')} 端口 ${config.server.port} 空闲（daemon 未启动）`)

  if (problems === 0) info(`\n${color.green('看起来没问题。')}`)
}

async function cmdLogs({ flags }) {
  const path = logPath()
  if (!existsSync(path)) {
    fail(`还没有日志：${path}（用 aipool install 启动后台服务后会写这里）`)
    return
  }
  if (flags.f) {
    const child = spawn('tail', ['-f', path], { stdio: 'inherit' })
    child.on('exit', code => process.exit(code ?? 0))
    return
  }
  info(readFileSync(path, 'utf8').split('\n').slice(-Number(flags.n ?? 80)).join('\n'))
}

function cmdInstall({ flags }) {
  const file = launchd.install({ binPath: BIN })
  ok(`LaunchAgent 已安装：${file}`)
  info(color.dim('开机自启、崩溃自动重启。日志：aipool logs'))
  const config = requireConfig()
  info(`${color.dim('面板')} http://${lanAddressHint(config.server.host)}:${config.server.port}/?token=${config.auth.adminToken}`)
}

function cmdUninstall() {
  const file = launchd.uninstall()
  ok(`已卸载（${file}）`)
}

async function cmdDashboard({ flags }) {
  const config = requireConfig()
  const url = `http://${lanAddressHint(config.server.host)}:${config.server.port}/?token=${config.auth.adminToken}`
  info(url)
  if (flags.open) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

function usage() {
  info(`aipool ${VERSION} — N 个上游 Key → 一个局域网端点 + 一个 token

用法: aipool <command> [options]

  init                    初始化 ~/.aipool/config.json（生成 admin token + 第一个客户端 token）
  serve                   前台运行网关（Ctrl-C 退出；SIGHUP 热加载配置）
  status [--json]         查看运行中的池状态、配额、最近请求
  dashboard [--open]      打印（并打开）带 admin token 的面板地址

  key add --provider ID --label 名称 [--key K | 交互输入]
  key ls | key rm --provider ID <id|label> | key test [--provider ID]

  token new --name 设备名 [--rpm 60] [--models a,b]
  token ls | token revoke <id|name> | token disable <id|name> | token enable <id|name>

  provider add --id ID --type openai|anthropic --base-url URL [--model m1,m2] [--path /chat/completions]
  provider ls | provider rm <id>

  install                 安装 macOS LaunchAgent（开机自启）
  uninstall               卸载 LaunchAgent
  logs [-f]               看日志
  doctor                  体检

环境变量：AIPOOL_HOME、AIPOOL_CONFIG、AIPOOL_LOG_LEVEL=debug
`)
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'help'
  const { flags, positional } = parseArgs(argv.slice(1))
  try {
    switch (command) {
      case 'init': await cmdInit({ flags }); break
      case 'serve': await cmdServe({ flags }); break
      case 'status': await cmdStatus({ flags }); break
      case 'key': await cmdKey({ flags, positional }); break
      case 'token': await cmdToken({ flags, positional }); break
      case 'provider': await cmdProvider({ flags, positional }); break
      case 'config': await cmdConfig({ flags }); break
      case 'doctor': await cmdDoctor(); break
      case 'install': cmdInstall({ flags }); break
      case 'uninstall': cmdUninstall(); break
      case 'logs': await cmdLogs({ flags }); break
      case 'dashboard': await cmdDashboard({ flags }); break
      case 'probe': {
        const config = requireConfig()
        await probeKeys(config, flags.provider ? [resolveProviderRef(config, flags.provider)] : config.providers)
        break
      }
      case 'version': info(VERSION); break
      case 'help':
      case '--help':
      case '-h':
      default:
        usage()
        break
    }
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message)
    else fail(error?.stack && process.env.AIPOOL_DEBUG ? error.stack : error?.message ?? String(error))
    process.exitCode = 1
  }
}

void main()
