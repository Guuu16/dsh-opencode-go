/**
 * App controller: ties the store, the pool state machine, usage polling and
 * the local proxy together. Electron-free so it can be unit tested.
 */

import { EventEmitter } from 'node:events'
import { Pool } from './pool.js'
import { fetchUsage, UsageError } from './usage.js'
import { createProxyServer } from './proxy.js'
import { describeFailure } from './failures.js'

function isoNow(now) {
  return new Date(now()).toISOString()
}

export class Controller extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./store.js').Store} options.store
   * @param {string} [options.usageBaseUrl]
   * @param {number} [options.logLimit]
   * @param {() => number} [options.now]
   * @param {Function} [options.fetchUsageImpl]
   */
  constructor({ store, usageBaseUrl, logLimit = 300, now = () => Date.now(), fetchUsageImpl = fetchUsage, autoStartProxy = true }) {
    super()
    this.store = store
    this.now = now
    this.fetchUsageImpl = fetchUsageImpl
    this.usageBaseUrl = usageBaseUrl
    this.autoStartProxy = autoStartProxy
    this.logLimit = logLimit
    this.logs = []
    this.proxy = null
    this.proxyInfo = { running: false, port: null, host: '127.0.0.1' }
    this.proxyError = null
    this.pollTimer = null
    this.refreshing = false
    this.refreshedAt = null
    this.suspended = false
    this.emitScheduled = false
    this.pool = null
  }

  init() {
    this.store.load()
    this.pool = new Pool({ state: this.store.state, now: this.now })
    this.pool.onChange = () => this.changed()
    this.pushLog({ level: 'info', message: `号池已加载：${this.store.state.accounts.length} 个账号` })
    this.startPolling()
    if (this.autoStartProxy && this.store.state.settings.proxyEnabled) {
      this.startProxy().catch(error => this.proxyFailed(error))
    }
    this.initTimer = setTimeout(() => { this.refreshUsage().catch(() => {}) }, 1200)
    if (this.initTimer.unref) this.initTimer.unref()
    return this
  }

  // ---- state ---------------------------------------------------------------

  snapshot() {
    const activeId = this.pool.state.activeId
    const accounts = this.pool.accounts.map(account => ({
      id: account.id,
      label: account.label,
      hint: account.hint,
      state: account.state,
      disabled: account.disabled,
      active: account.id === activeId,
      usable: this.pool.usable(account),
      failureStreak: account.failureStreak,
      lastFailure: account.lastFailure,
      usage: account.usage,
      usageAt: account.usageAt,
      usageError: account.usageError,
      createdAt: account.createdAt,
    }))
    const usable = accounts.filter(account => this.pool.usable(this.store.account(account.id))).length
    return {
      activeId,
      lastSwitch: this.pool.state.lastSwitch,
      settings: { ...this.pool.settings },
      accounts,
      usable,
      refreshedAt: this.refreshedAt,
      proxy: {
        running: this.proxyInfo.running,
        port: this.proxyInfo.port,
        host: this.proxyInfo.host,
        baseUrl: this.proxyInfo.running ? `http://${this.proxyInfo.host}:${this.proxyInfo.port}/v1` : null,
        error: this.proxyError,
      },
      logs: this.logs.slice(-120),
      app: {
        scheme: this.store.scheme,
        encryptionAvailable: this.store.scheme === 'dpapi',
      },
    }
  }

  changed() {
    if (this.suspended) return
    this.store.save()
    this.emitState()
  }

  emitState() {
    if (this.emitScheduled) return
    this.emitScheduled = true
    setImmediate(() => {
      this.emitScheduled = false
      this.emit('state', this.snapshot())
    })
  }

  pushLog(entry) {
    const record = {
      at: entry.at ?? isoNow(this.now),
      level: entry.level ?? 'info',
      message: String(entry.message ?? ''),
    }
    this.logs.push(record)
    if (this.logs.length > this.logLimit) this.logs.splice(0, this.logs.length - this.logLimit)
    this.emit('log', record)
  }

  // ---- accounts ------------------------------------------------------------

  addAccount({ label, secret }) {
    const account = this.store.addAccount({ label, secret })
    if (this.pool.state.activeId === null) this.pool.state.activeId = account.id
    this.pushLog({ level: 'info', message: `已添加账号「${account.label}」` })
    this.changed()
    this.refreshUsage({ onlyId: account.id }).catch(() => {})
    return account.id
  }

  updateAccount({ id, label, secret }) {
    const before = this.store.account(id)
    if (!before) throw new Error('账号不存在')
    this.store.updateAccount(id, { label, secret })
    if (secret) this.pushLog({ level: 'info', message: `已更新账号「${before.label}」的密钥` })
    else this.pushLog({ level: 'info', message: `已重命名账号「${before.label}」` })
    this.changed()
    if (secret) this.refreshUsage({ onlyId: id }).catch(() => {})
    return true
  }

  removeAccount(id) {
    const account = this.store.account(id)
    if (!account) throw new Error('账号不存在')
    this.store.removeAccount(id)
    this.pushLog({ level: 'info', message: `已删除账号「${account.label}」` })
    if (this.pool.state.activeId === null) this.pool.current()
    this.changed()
    return true
  }

  setActive(id) {
    const rotation = this.pool.setActive(id)
    if (rotation) this.pushLog({ level: 'info', message: `手动切换到「${this.accountLabel(id)}」` })
    return rotation
  }

  setDisabled(id, disabled) {
    this.pool.setDisabled(id, disabled)
    this.pushLog({ level: 'info', message: `${disabled ? '停用' : '启用'}账号「${this.accountLabel(id)}」` })
    return true
  }

  cycle() {
    const rotation = this.pool.cycle()
    if (rotation) {
      this.pushLog({ level: 'info', message: `切换到「${this.accountLabel(rotation.to)}」` })
      this.emit('switch', rotation)
    }
    return rotation
  }

  accountLabel(id) {
    return this.store.account(id)?.label ?? String(id)
  }

  // ---- settings ------------------------------------------------------------

  updateSettings(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('设置无效')
    const settings = this.store.state.settings
    const beforePort = settings.proxyPort
    const beforeEnabled = settings.proxyEnabled
    const beforeRefresh = settings.usageRefreshMs

    if (patch.preemptAtPercent !== undefined) {
      const value = Number(patch.preemptAtPercent)
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('避让阈值必须在 0–100 之间')
      settings.preemptAtPercent = Math.round(value)
    }
    if (patch.switchAfterConsecutiveFailures !== undefined) {
      const value = Number(patch.switchAfterConsecutiveFailures)
      if (!Number.isFinite(value) || value < 0 || value > 20) throw new Error('连败阈值必须在 0–20 之间')
      settings.switchAfterConsecutiveFailures = Math.round(value)
    }
    if (patch.usageRefreshMs !== undefined) {
      const value = Number(patch.usageRefreshMs)
      if (!Number.isFinite(value) || value < 5000 || value > 300000) throw new Error('刷新间隔必须在 5–300 秒之间')
      settings.usageRefreshMs = Math.round(value)
    }
    if (patch.proxyPort !== undefined) {
      const value = Number(patch.proxyPort)
      if (!Number.isFinite(value) || value < 1024 || value > 65535) throw new Error('代理端口必须在 1024–65535 之间')
      settings.proxyPort = Math.round(value)
    }
    for (const key of ['proxyEnabled', 'launchAtLogin', 'closeToTray', 'autoMarkInvalid']) {
      if (patch[key] !== undefined) settings[key] = patch[key] === true
    }
    this.store.save()
    this.pushLog({ level: 'info', message: '设置已保存' })

    if (settings.usageRefreshMs !== beforeRefresh) this.startPolling()

    const portChanged = settings.proxyPort !== beforePort
    const enabledChanged = settings.proxyEnabled !== beforeEnabled
    if (enabledChanged || (portChanged && this.proxyInfo.running)) {
      this.restartProxy().catch(error => this.proxyFailed(error))
    }
    this.changed()
    return { ...settings }
  }

  // ---- usage ---------------------------------------------------------------

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    const interval = Math.max(5000, Number(this.store.state.settings.usageRefreshMs) || 30000)
    this.pollTimer = setInterval(() => { this.refreshUsage().catch(() => {}) }, interval)
    if (this.pollTimer.unref) this.pollTimer.unref()
  }

  /**
   * Query every account's usage in parallel (bounded), then persist once.
   * 401 marks the account invalid when the setting allows it. A concurrent call
   * waits for the in-flight sweep first, so a manual refresh is never silently
   * dropped by the poller.
   */
  async refreshUsage({ onlyId = null } = {}) {
    if (this.refreshing) {
      try {
        await this.refreshPromise
      } catch {
        // the in-flight sweep already reported its own failures
      }
    }
    this.refreshing = true
    this.suspended = true
    const accounts = onlyId
      ? this.pool.accounts.filter(account => account.id === onlyId)
      : this.pool.accounts.slice()
    this.refreshPromise = this.runRefresh(accounts)
    try {
      const updated = await this.refreshPromise
      this.refreshedAt = isoNow(this.now)
      return { updated }
    } finally {
      this.refreshPromise = null
      this.suspended = false
      this.refreshing = false
      this.store.save()
      this.emitState()
    }
  }

  async runRefresh(accounts) {
    let updated = 0
    const queue = accounts.slice()
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const account = queue.shift()
        if (!account) return
        const ok = await this.refreshOne(account)
        if (ok) updated += 1
      }
    })
    await Promise.all(workers)
    return updated
  }

  async refreshOne(account) {
    let secret
    try {
      secret = this.store.secretOf(account.id)
    } catch (error) {
      account.usageError = error.code === 'MISSING_CREDENTIAL' ? 'no-api-key' : 'secret-unreadable'
      return false
    }
    try {
      const usage = await this.fetchUsageImpl({
        baseUrl: this.usageBaseUrl,
        apiKey: secret,
        timeoutMs: 12000,
      })
      this.pool.onUsage(account.id, usage)
      return true
    } catch (error) {
      const code = error instanceof UsageError ? error.code : 'network'
      if (code === 'unauthorized' && this.store.state.settings.autoMarkInvalid) {
        const rotation = this.pool.markInvalid(account.id, '额度接口返回 401：Key 无效或已过期')
        if (rotation) {
          this.pushLog({ level: 'warn', message: `账号「${account.label}」Key 失效，已自动切换` })
          this.emit('switch', rotation)
        }
        return false
      }
      this.pool.onUsageError(account.id, code)
      return false
    }
  }

  // ---- proxy ---------------------------------------------------------------

  proxyStatus() {
    const active = this.pool?.accounts.find(account => account.id === this.pool.state.activeId)
    return {
      running: this.proxyInfo.running,
      port: this.proxyInfo.port,
      baseUrl: this.proxyInfo.running ? `http://${this.proxyInfo.host}:${this.proxyInfo.port}/v1` : null,
      activeId: this.pool?.state.activeId ?? null,
      activeLabel: active?.label ?? null,
      accounts: (this.pool?.accounts ?? []).map(account => ({
        id: account.id,
        label: account.label,
        state: account.state,
        usage: account.usage,
        usable: this.pool.usable(account),
      })),
    }
  }

  async startProxy() {
    if (this.proxyInfo.running) return this.proxyInfo
    const port = this.store.state.settings.proxyPort
    this.proxyError = null
    const proxy = createProxyServer({
      resolveKey: async () => {
        const account = this.pool.current()
        if (!account) return null
        const secret = this.store.secretOf(account.id)
        return { id: account.id, label: account.label, secret }
      },
      onFailure: async (id, code, message) => {
        const rotation = this.pool.onFailure(id, code, message)
        if (rotation) {
          this.pushLog({
            level: 'warn',
            message: `账号「${this.accountLabel(id)}」${describeFailure(code)}，已切换到「${rotation.to ? this.accountLabel(rotation.to) : '无可用账号'}」`,
          })
          this.emit('switch', rotation)
        }
        return rotation
      },
      onSuccess: id => this.pool.onSuccess(id),
      onEvent: entry => this.pushLog(entry),
      status: () => this.proxyStatus(),
      switchTo: id => this.setActive(id),
      cycle: () => this.cycle(),
    })
    try {
      const info = await proxy.start(port)
      this.proxy = proxy
      this.proxyInfo = { running: true, port: info.port, host: info.host }
      this.pushLog({ level: 'info', message: `本地代理已启动：http://${info.host}:${info.port}/v1` })
    } catch (error) {
      this.proxy = null
      this.proxyInfo = { running: false, port: null, host: '127.0.0.1' }
      throw error
    } finally {
      this.emitState()
    }
    return this.proxyInfo
  }

  async stopProxy() {
    if (!this.proxy) {
      this.proxyInfo = { running: false, port: null, host: '127.0.0.1' }
      return
    }
    const proxy = this.proxy
    this.proxy = null
    await proxy.stop()
    this.proxyInfo = { running: false, port: null, host: '127.0.0.1' }
    this.pushLog({ level: 'info', message: '本地代理已停止' })
    this.emitState()
  }

  async restartProxy() {
    await this.stopProxy()
    if (this.store.state.settings.proxyEnabled) await this.startProxy()
  }

  /** Start/stop the proxy regardless of the persisted setting, then persist it. */
  async toggleProxy() {
    if (this.proxyInfo.running) {
      return this.updateSettings({ proxyEnabled: false })
    }
    this.store.state.settings.proxyEnabled = true
    this.store.save()
    await this.restartProxy()
    return this.snapshot().proxy
  }

  proxyFailed(error) {
    this.proxyError = String((error && error.message) || error)
    this.proxyInfo = { running: false, port: null, host: '127.0.0.1' }
    this.pushLog({ level: 'error', message: `代理启动失败：${this.proxyError}` })
    this.emitState()
  }

  dispose() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.initTimer) clearTimeout(this.initTimer)
    this.pollTimer = null
    this.initTimer = null
    return this.stopProxy()
  }
}
