#!/usr/bin/env node
/**
 * 把 aipool 注册成 ZCode 的一个自定义供应商。
 *
 * ZCode 把供应商配置存在两个文件里，而且运行时会把内存状态写回去，所以：
 *   1. 先完全退出 ZCode（Cmd-Q，不是关窗口）
 *   2. node scripts/connect-zcode.mjs --token sk-aipool-… [--dry-run]
 *   3. 重新打开 ZCode，在模型/供应商列表里选 “aipool (LAN)”
 *
 * 脚本是幂等的：重复执行只会更新同一个 provider，不会堆出一串重复项；
 * 两个配置文件都会先备份成 *.bak-aipool-<时间戳>。
 *
 * 参数：
 *   --token <sk-aipool-…>   客户端 token（必填，或读环境变量 AIPOOL_TOKEN）
 *   --base <url>            默认 http://127.0.0.1:8790
 *   --models a,b,c          默认下面 MODELS
 *   --dry-run               只打印将要写入的摘要
 *   --force                 ZCode 在跑也强行写（不推荐：退出时可能被覆盖）
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODELS = ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4-pro', 'kimi-k3', 'qwen3.8-max']
const PROVIDER_ID = 'aipool'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : true
}

const token = flag('token') || process.env.AIPOOL_TOKEN
const base = flag('base', 'http://127.0.0.1:8790')
const models = String(flag('models', MODELS.join(','))).split(',').map(item => item.trim()).filter(Boolean)
const dryRun = flag('dry-run', false) === true
const force = flag('force', false) === true

if (!token || token === true) {
  console.error('缺少 --token（或环境变量 AIPOOL_TOKEN）。先 `aipool token new --name zcode` 生成一个。')
  process.exit(1)
}

function zcodeRunning() {
  try {
    execFileSync('pgrep', ['-x', 'ZCode'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (zcodeRunning() && !force && !dryRun) {
  console.error('ZCode 正在运行：它会把自己的内存状态写回配置。请先 Cmd-Q 完全退出，再执行本脚本。')
  process.exit(1)
}

const v2 = join(homedir(), '.zcode', 'v2')
const providerConfigPath = join(v2, 'provider_config.json')
const configPath = join(v2, 'config.json')

if (!existsSync(providerConfigPath)) {
  console.error(`没找到 ${providerConfigPath}：ZCode 可能还没初始化过，先在它里面登录/选一次模型再回来。`)
  process.exit(1)
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function backup(path) {
  if (!existsSync(path)) return null
  const target = `${path}.bak-aipool-${Date.now()}`
  copyFileSync(path, target)
  return target
}

function writeJSON(path, value) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

// ---- provider_config.json：供应商规则 + 模型规则 ----
const providerConfig = readJSON(providerConfigPath)
providerConfig.config ??= {}
providerConfig.config.providerConfigRules ??= { providerRules: [] }
providerConfig.config.modelConfigRules ??= { providerModelRules: [] }
providerConfig.config.providerOrder ??= []

const providerRule = {
  providerId: PROVIDER_ID,
  providerName: 'aipool (LAN)',
  enabled: true,
  config: {
    group: 'standard-personal',
    access: { type: 'api-key', apiKey: token },
    api: { type: 'anthropic-messages', baseUrl: base },
    personalModelIds: models,
    modelOrder: models,
  },
}

const rules = providerConfig.config.providerConfigRules.providerRules
const existingRule = rules.findIndex(rule => rule?.providerId === PROVIDER_ID)
if (existingRule >= 0) rules[existingRule] = providerRule
else rules.push(providerRule)

if (!providerConfig.config.providerOrder.includes(PROVIDER_ID)) {
  providerConfig.config.providerOrder.push(PROVIDER_ID)
}

const modelRules = providerConfig.config.modelConfigRules.providerModelRules
for (const id of models) {
  const index = modelRules.findIndex(rule => rule?.providerId === PROVIDER_ID && rule?.modelId === id)
  const rule = {
    modelId: id,
    config: { enabled: true, properties: { contextWindow: 1000000 } },
    providerId: PROVIDER_ID,
  }
  if (index >= 0) modelRules[index] = rule
  else modelRules.push(rule)
}

// ---- config.json：模型清单（ZCode 的 picker 读这里） ----
let config = null
if (existsSync(configPath)) {
  config = readJSON(configPath)
  config.provider ??= {}
  const previous = config.provider[PROVIDER_ID] ?? {}
  config.provider[PROVIDER_ID] = {
    name: 'aipool (LAN)',
    kind: 'anthropic',
    options: { apiKey: token, baseURL: base, apiKeyRequired: true },
    source: 'custom',
    enabled: true,
    models: Object.fromEntries(models.map((id, index) => [id, {
      reasoning: previous.models?.[id]?.reasoning ?? { enabled: false },
      limit: { context: 1000000, output: 128000 },
      modalities: { input: ['text'], output: ['text'] },
      zcode: { modified: false, priority: index + 1 },
    }])),
  }
}

if (dryRun) {
  const masked = (() => {
    const value = config?.provider?.[PROVIDER_ID]
    if (!value) return null
    return { ...value, options: { ...value.options, apiKey: `${String(token).slice(0, 12)}…` } }
  })()
  console.log(JSON.stringify({
    dryRun: true,
    providerConfig: { providerId: PROVIDER_ID, baseUrl: base, models, providersAfter: providerConfig.config.providerOrder },
    configProvider: masked,
  }, null, 2))
  process.exit(0)
}

const backupA = backup(providerConfigPath)
writeJSON(providerConfigPath, providerConfig)
const backupB = config ? backup(configPath) : null
if (config) writeJSON(configPath, config)

console.log(`✓ 已注册 ZCode 供应商 "${PROVIDER_ID}"`)
console.log(`  baseUrl : ${base}`)
console.log(`  models  : ${models.join(', ')}`)
if (backupA) console.log(`  备份    : ${backupA}`)
if (backupB) console.log(`  备份    : ${backupB}`)
console.log('  下一步  : 重新打开 ZCode → 模型/供应商列表里选 “aipool (LAN)”')
