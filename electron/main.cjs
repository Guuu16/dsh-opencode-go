/**
 * Electron main process for the OpenCode Go Pool desktop app.
 *
 * CommonJS on purpose: Electron's main entry is CJS and the npm `electron`
 * package resolves to the executable path when imported as ESM. The pool core
 * stays ESM and is loaded with dynamic import after the app is ready.
 *
 * Windows-only UI concerns live here: tray, global hotkey, notifications,
 * login item, safeStorage (DPAPI) and the window. All pool behaviour lives in
 * ./core and is unit tested without Electron.
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut,
  clipboard, shell, nativeImage, safeStorage } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

const ROOT = join(__dirname, '..')
const ICON = join(ROOT, 'assets', 'icon.png')
const TRAY_ICON = join(ROOT, 'assets', 'tray.png')
const IS_SMOKE = process.argv.includes('--smoke-test')
const START_HIDDEN = process.argv.includes('--hidden')

const dataDir = process.env.POOL_DATA_DIR || join(app.getPath('appData'), 'OpenCode Go Pool')
app.setPath('userData', dataDir)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

// Core modules (ESM) are imported after app.whenReady().
let Store = null
let Controller = null
let DEFAULT_USAGE_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'
let DEFAULT_API_BASE_URL = 'https://opencode.ai/zen/go/v1'
let describeFailure = code => String(code)

let store = null
let controller = null
let win = null
let tray = null
let isQuitting = false
let trayTimer = null
let smokeDone = false

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- encrypted secrets (DPAPI through Electron safeStorage) ----------------

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function seal(plain) {
  if (encryptionAvailable()) {
    return `dpapi:1:${safeStorage.encryptString(plain).toString('base64')}`
  }
  return `plain:1:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function unseal(cipher) {
  const parts = String(cipher || '').split(':')
  if (parts.length !== 3) throw new Error('unknown secret format')
  const [kind, , data] = parts
  const buffer = Buffer.from(data, 'base64')
  if (kind === 'dpapi') {
    if (!encryptionAvailable()) throw new Error('DPAPI unavailable')
    return safeStorage.decryptString(buffer)
  }
  if (kind === 'plain') return buffer.toString('utf8')
  throw new Error('unknown secret scheme')
}

// ---- window / tray ---------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: 'OpenCode Go Pool',
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  win.loadFile(join(ROOT, 'renderer', 'index.html'))
  win.once('ready-to-show', () => {
    if (IS_SMOKE || !START_HIDDEN) win.show()
  })
  win.on('close', event => {
    if (isQuitting) return
    if (store?.state.settings.closeToTray !== false) {
      event.preventDefault()
      win.hide()
      return
    }
    // "Close to tray" disabled: closing the window quits the app, not just the
    // window (otherwise a tray-less app would look gone but keep running).
    event.preventDefault()
    controller?.dispose().catch(() => {}).finally(() => {
      isQuitting = true
      app.quit()
    })
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return
    const icon = nativeImage.createFromPath(ICON)
    new Notification({ title, body, icon: icon.isEmpty() ? undefined : icon }).show()
  } catch {
    // notifications are a convenience; never let them break the flow
  }
}

function activeLabel() {
  const id = controller?.pool?.state.activeId
  if (!id) return '无可用账号'
  return controller.store.account(id)?.label ?? id
}

function usageSummary(account) {
  const stateText = account.state === 'exhausted' ? '额度耗尽'
    : account.state === 'invalid' ? '已失效'
      : account.state === 'disabled' ? '已停用' : '正常'
  const rolling = account.usage?.rolling
  const part = rolling && typeof rolling.percent === 'number' ? `5h ${rolling.percent}%` : '5h —'
  return `${stateText} · ${part}`
}

function applyLoginItem(enabled) {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    controller?.pushLog({ level: 'warn', message: '便携版无法注册开机启动；请使用安装版（setup.exe）' })
    return false
  }
  app.setLoginItemSettings({ openAtLogin: enabled === true, args: ['--hidden'] })
  return true
}

function buildTrayMenu() {
  const snapshot = controller.snapshot()
  const accounts = snapshot.accounts
  const activeId = snapshot.activeId
  const submenu = accounts.length === 0
    ? [{ label: '暂无账号', enabled: false }]
    : accounts.map(account => ({
      label: `${account.label} · ${usageSummary(account)}`,
      type: 'radio',
      checked: account.id === activeId,
      enabled: account.state === 'healthy',
      click: () => {
        try {
          controller.setActive(account.id)
          notify('已切换账号', `当前账号：${account.label}`)
        } catch (error) {
          notify('切换失败', String((error && error.message) || error))
        }
      },
    }))

  return Menu.buildFromTemplate([
    { label: `当前：${activeLabel()}`, enabled: false },
    { label: snapshot.proxy.running ? `代理：${snapshot.proxy.baseUrl}` : '代理未启动', enabled: false },
    { type: 'separator' },
    { label: '切换账号', submenu },
    {
      label: '下一个账号（Ctrl+Alt+O）',
      enabled: snapshot.usable > 0,
      click: () => {
        const rotation = controller.cycle()
        if (!rotation) notify('没有可切换的账号', '所有账号都不可用，请查看面板')
      },
    },
    { label: '刷新额度', click: () => controller.refreshUsage().catch(() => {}) },
    { type: 'separator' },
    { label: '打开面板', click: showWindow },
    {
      label: '复制代理地址',
      enabled: Boolean(snapshot.proxy.baseUrl),
      click: () => {
        if (snapshot.proxy.baseUrl) clipboard.writeText(snapshot.proxy.baseUrl)
      },
    },
    {
      label: snapshot.proxy.running ? '停止本地代理' : '启动本地代理',
      click: () => controller.toggleProxy().catch(error => notify('代理切换失败', String((error && error.message) || error))),
    },
    { type: 'separator' },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: snapshot.settings.launchAtLogin,
      click: item => {
        applyLoginItem(item.checked)
        controller.updateSettings({ launchAtLogin: item.checked })
      },
    },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ])
}

function rebuildTray() {
  if (!tray || !controller) return
  tray.setContextMenu(buildTrayMenu())
  const snapshot = controller.snapshot()
  tray.setToolTip(`OpenCode Go Pool · ${activeLabel()}${snapshot.proxy.running ? ' · 代理运行中' : ''}`)
  tray.setImage(TRAY_ICON)
}

function scheduleTrayRebuild() {
  if (trayTimer) return
  trayTimer = setTimeout(() => {
    trayTimer = null
    rebuildTray()
  }, 250)
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(TRAY_ICON)
    if (image.isEmpty()) return
    tray = new Tray(image)
    tray.on('double-click', showWindow)
    tray.on('click', showWindow)
    rebuildTray()
  } catch (error) {
    // A session without an interactive shell (service/RDP-less) has no tray;
    // the app still works through the window.
    tray = null
    console.warn('[tray] unavailable:', String((error && error.message) || error))
  }
}

// ---- IPC -------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, value: await fn(payload) }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  })
}

function registerIpc() {
  handle('app:state', () => controller.snapshot())
  handle('app:info', () => ({
    version: app.getVersion(),
    dataDir,
    usageBaseUrl: DEFAULT_USAGE_BASE_URL,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    encryption: encryptionAvailable() ? 'Windows DPAPI' : '未加密（DPAPI 不可用）',
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  }))
  handle('accounts:add', payload => controller.addAccount(payload ?? {}))
  handle('accounts:update', payload => controller.updateAccount(payload ?? {}))
  handle('accounts:remove', payload => controller.removeAccount(payload?.id))
  handle('accounts:activate', payload => controller.setActive(payload?.id))
  handle('accounts:disable', payload => controller.setDisabled(payload?.id, payload?.disabled === true))
  handle('accounts:cycle', () => controller.cycle())
  handle('settings:update', patch => {
    const settings = controller.updateSettings(patch ?? {})
    if (patch && 'launchAtLogin' in patch) applyLoginItem(settings.launchAtLogin)
    return settings
  })
  handle('usage:refresh', () => controller.refreshUsage())
  handle('models:list', () => controller.listModels())
  handle('proxy:toggle', () => controller.toggleProxy())
  handle('logs:clear', () => {
    controller.logs = []
    controller.emitState()
    return true
  })
  handle('clipboard:write', text => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  handle('shell:open-external', url => {
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url))
    throw new Error('unsupported URL')
  })
  handle('window:hide', () => {
    win?.hide()
    return true
  })
}

// ---- lifecycle -------------------------------------------------------------

app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  app.setAppUserModelId('com.guuu16.opencodegopool')

  ;({ Store } = await import('./core/store.js'))
  ;({ Controller } = await import('./core/controller.js'))
  ;({ DEFAULT_USAGE_BASE_URL, DEFAULT_API_BASE_URL } = await import('./core/usage.js'))
  ;({ describeFailure } = await import('./core/failures.js'))

  store = new Store({
    file: join(dataDir, 'pool.json'),
    encrypt: seal,
    decrypt: unseal,
    scheme: encryptionAvailable() ? 'dpapi' : 'plain',
    logger: console,
  })
  const usageBaseUrl = process.env.POOL_USAGE_BASE_URL || DEFAULT_USAGE_BASE_URL
  controller = new Controller({ store, usageBaseUrl }).init()

  controller.on('state', snapshot => {
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot)
    scheduleTrayRebuild()
  })
  controller.on('log', entry => {
    if (win && !win.isDestroyed()) win.webContents.send('log', entry)
  })
  controller.on('switch', rotation => {
    const from = rotation.from ? controller.store.account(rotation.from)?.label ?? rotation.from : '—'
    const to = rotation.to ? controller.store.account(rotation.to)?.label ?? rotation.to : '无可用账号'
    const reasonText = rotation.reason === 'quota' ? describeFailure('QUOTA')
      : rotation.reason === 'invalid' ? describeFailure('INVALID_CREDENTIAL')
        : rotation.reason === 'consecutive' ? describeFailure('RATE_LIMIT') : '手动'
    notify(rotation.reason === 'manual' ? '已切换账号' : '额度切换', `${from} → ${to}（${reasonText}）`)
  })

  registerIpc()
  createWindow()
  createTray()

  if (store.state.settings.launchAtLogin) applyLoginItem(true)

  try {
    globalShortcut.register('CommandOrControl+Alt+O', () => {
      const rotation = controller.cycle()
      if (!rotation) notify('没有可切换的账号', '所有账号都不可用')
    })
    globalShortcut.register('CommandOrControl+Alt+Shift+O', showWindow)
  } catch (error) {
    console.warn('[hotkey]', error)
  }

  if (IS_SMOKE) runSmokeTest()

  app.on('activate', showWindow)
})

app.on('window-all-closed', () => {
  // Tray app: keep running with no window.
})

app.on('before-quit', event => {
  if (isQuitting) return
  isQuitting = true
  if (controller) {
    event.preventDefault()
    controller.dispose().catch(() => {}).finally(() => app.exit(0))
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

async function runSmokeTest() {
  if (smokeDone) return
  smokeDone = true
  try {
    const started = Date.now()
    while (!controller.proxyInfo.running && Date.now() - started < 6000) await delay(200)
    await delay(2500)
    let health = null
    if (controller.proxyInfo.running) {
      try {
        const response = await fetch(`http://127.0.0.1:${controller.proxyInfo.port}/pool/health`, {
          headers: { 'X-Pool-Token': store.state.settings.proxyToken },
        })
        health = await response.json()
      } catch (error) {
        health = { error: String((error && error.message) || error) }
      }
    }
    const image = await win.webContents.capturePage()
    writeFileSync(join(app.getPath('userData'), 'smoke.png'), image.toPNG())
    console.log('SMOKE ' + JSON.stringify({
      ok: Boolean(health),
      proxy: controller.proxyInfo,
      health,
      accounts: store.state.accounts.length,
      screen: join(app.getPath('userData'), 'smoke.png'),
    }))
  } catch (error) {
    console.log('SMOKE_FAIL ' + String((error && error.stack) || error))
  } finally {
    setTimeout(() => {
      isQuitting = true
      controller?.dispose().catch(() => {}).finally(() => app.exit(0))
    }, 250)
  }
}
