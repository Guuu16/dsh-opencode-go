// Renderer UI: vanilla DOM, no framework, no network access (IPC only).

const api = window.pool
const $ = selector => document.querySelector(selector)

window.addEventListener('error', event => {
  console.error('[renderer] uncaught:', event.error || event.message)
})
window.addEventListener('unhandledrejection', event => {
  console.error('[renderer] rejection:', event.reason)
})

const WINDOWS = [
  ['rolling', '5 小时滚动'],
  ['weekly', '每周'],
  ['monthly', '每月'],
]

let state = null
let info = null
let editor = { mode: 'add', id: null }
let ticker = null

// ---- tiny DOM helper -------------------------------------------------------

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

// ---- formatting ------------------------------------------------------------

function fmtPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—'
}

function fmtReset(iso) {
  if (!iso) return '—'
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return '—'
  const diff = target - Date.now()
  if (diff <= 0) return '已重置'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分后`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时后`
}

function fmtTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtClock(iso) {
  const date = iso ? new Date(iso) : new Date()
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

const STATE_TEXT = {
  healthy: '正常',
  exhausted: '额度耗尽',
  invalid: '已失效',
  disabled: '已停用',
}

const USAGE_ERROR_TEXT = {
  'no-api-key': '尚未保存密钥',
  'secret-unreadable': '密钥无法在本机解密，请重新填写',
  unauthorized: '额度接口返回 401：Key 无效或已过期',
  network: '网络请求失败，稍后自动重试',
  timeout: '额度查询超时，稍后自动重试',
  'bad-json': '额度接口响应无法解析',
}

// OpenCode Go 的模型按上游协议分组（pi-ai 1.3.0 目录）。
// 配错协议会得到上游 400，所以这里按协议分开展示。
const MODEL_CATALOG = {
  openai: {
    note: 'OpenAI Chat 组：兼容性最好，DSH / ZCode / Cherry Studio 等「OpenAI 兼容」供应商填 http://127.0.0.1:8787/openai/v1。',
    models: [
      'deepseek-v4-pro', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2',
      'kimi-k3', 'kimi-k2.7-code', 'longcat-2.0', 'longcat-2.5-preview-free',
      'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro',
      'hy3', 'hy4-preview', 'step-5-preview-free', 'cat-jam-free', 'space-bunny',
    ],
  },
  responses: {
    note: 'OpenAI Responses 组：给 Codex CLI（wire_api = responses）用，Base URL 同上 /openai/v1。GPT / Grok / Muse 在部分地区会 403。',
    models: ['gpt-6-luna', 'gpt-5.6-luna', 'grok-4.7', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
  },
  anthropic: {
    note: 'Anthropic Messages 组：Claude Code / ZCode 的 Anthropic 供应商填 http://127.0.0.1:8787/anthropic。',
    models: ['claude-haiku-5-5', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'minimax-m3'],
  },
  google: {
    note: 'Google Generative AI 组：ZCode / Google SDK 填 http://127.0.0.1:8787/google。需先在 OpenCode 工作区允许「训练数据的付费端点」。',
    models: ['gemini-4-argon-contributor'],
  },
}

let activeProto = 'openai'

function usageErrorText(code) {
  if (!code) return ''
  if (USAGE_ERROR_TEXT[code]) return USAGE_ERROR_TEXT[code]
  if (String(code).startsWith('http-')) return `额度接口返回 HTTP ${String(code).slice(5)}`
  return `额度查询失败：${code}`
}

// ---- render: header / banner ----------------------------------------------

function renderHeader() {
  const pill = $('#proxy-pill')
  const running = state.proxy.running && !state.proxy.error
  pill.className = `pill ${running ? 'on' : 'off'}`
  $('#proxy-pill-text').textContent = running
    ? `代理 ${state.proxy.host}:${state.proxy.port}`
    : '代理未启动'
  $('#account-count').textContent = String(state.accounts.length)
}

function renderBanner() {
  const banner = $('#banner')
  if (!state.accounts.length) {
    banner.className = 'banner hidden'
    return
  }
  clear(banner)
  const active = state.accounts.find(account => account.active)
  const next = state.accounts.find(account => account.usable && !account.active)
  const usable = state.usable
  banner.className = `banner ${usable > 0 ? 'ok' : 'danger'}`

  const nameRow = h('div', { class: 'banner-name' },
    active ? active.label : '暂无可用账号',
    active && active.active ? h('span', { class: 'badge active' }, '使用中') : null,
    active && !active.usable ? h('span', { class: 'badge exhausted' }, '已达避让阈值') : null,
  )

  const meta = []
  const labelOf = id => (id ? state.accounts.find(account => account.id === id)?.label ?? id : '—')
  if (active) {
    meta.push(h('span', null, `Key ${active.hint || '未保存'}`))
    if (!active.usable && next) meta.push(h('span', null, `下一次请求将切到「${next.label}」`))
  }
  if (state.lastSwitch) {
    meta.push(h('span', null, `上次切换 ${labelOf(state.lastSwitch.from)} → ${labelOf(state.lastSwitch.to)} · ${fmtTime(state.lastSwitch.at)}`))
  }

  banner.append(
    h('div', { class: 'banner-main' },
      h('div', { class: 'banner-kicker' }, '当前账号'),
      nameRow,
      h('div', { class: 'banner-meta' }, meta),
    ),
    h('div', { class: 'banner-side' },
      h('strong', null, `${usable} / ${state.accounts.length}`),
      h('span', null, '可用账号'),
      state.refreshedAt ? h('span', null, `刷新于 ${fmtClock(state.refreshedAt)}`) : null,
    ),
  )
}

// ---- render: accounts ------------------------------------------------------

function badge(account) {
  if (account.active && account.usable) return h('span', { class: 'badge active' }, '使用中')
  if (account.state === 'healthy' && !account.usable) return h('span', { class: 'badge exhausted' }, '已达避让阈值')
  const kind = account.state === 'healthy' ? 'healthy' : account.state
  return h('span', { class: `badge ${kind}` }, STATE_TEXT[account.state] || account.state)
}

function usageBar(name, window) {
  const percent = window && typeof window.percent === 'number' ? window.percent : null
  const level = percent === null ? 'unknown' : percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : 'ok'
  const fill = h('div', { class: `fill ${level}` })
  fill.style.width = `${percent === null ? 0 : Math.max(0, Math.min(100, percent))}%`
  return h('div', { class: 'bar' },
    h('div', { class: 'bar-head' },
      h('span', { class: 'bar-name' }, name),
      h('span', { class: 'bar-val' }, fmtPercent(percent)),
    ),
    h('div', { class: 'track' }, fill),
    h('div', { class: 'bar-foot' },
      h('span', null, `已用 ${fmtPercent(percent)} · 剩余 ${percent === null ? '—' : fmtPercent(100 - percent)}`),
      h('span', { dataset: { reset: (window && window.resetsAt) || '' } }, `重置 ${fmtReset(window && window.resetsAt)}`),
    ),
  )
}

function accountCard(account) {
  const card = h('article', {
    class: `account ${account.active ? 'is-active' : ''} state-${account.state}`,
    dataset: { id: account.id },
  })

  card.append(h('div', { class: 'acc-head' },
    h('div', { class: 'acc-title' },
      h('h4', null, account.label),
      h('p', { class: 'acc-sub' }, `Key ${account.hint || '未保存'} · 添加于 ${fmtTime(account.createdAt)}`),
    ),
    h('div', { class: 'badges' }, badge(account)),
  ))

  if (account.usage) {
    card.append(h('div', { class: 'bars' },
      ...WINDOWS.map(([key, name]) => usageBar(name, account.usage[key])),
    ))
  } else if (account.usageError) {
    card.append(h('p', { class: 'acc-error' }, usageErrorText(account.usageError)))
  } else {
    card.append(h('p', { class: 'hint' }, '正在查询额度…'))
  }

  if (account.lastFailure && account.state !== 'healthy') {
    card.append(h('p', { class: 'acc-last' },
      `最近失败：${account.lastFailure.message || account.lastFailure.code} · ${fmtTime(account.lastFailure.at)}`,
    ))
  }

  const actions = h('div', { class: 'acc-actions' })
  if (!account.active && account.usable) {
    actions.append(h('button', { class: 'btn', dataset: { act: 'switch', id: account.id } }, '切换到此账号'))
  }
  if (account.state === 'disabled') {
    actions.append(h('button', { class: 'btn', dataset: { act: 'enable', id: account.id } }, '启用'))
  } else {
    actions.append(h('button', { class: 'btn ghost', dataset: { act: 'disable', id: account.id } }, '停用'))
  }
  actions.append(h('button', { class: 'btn ghost', dataset: { act: 'edit', id: account.id } }, '编辑'))
  actions.append(h('button', { class: 'btn subtle', dataset: { act: 'delete', id: account.id } }, '删除'))
  card.append(actions)
  return card
}

function renderAccounts() {
  const list = $('#accounts')
  clear(list)
  for (const account of state.accounts) list.append(accountCard(account))
  $('#empty').classList.toggle('hidden', state.accounts.length > 0)
}

// ---- render: proxy / settings / logs --------------------------------------

function renderProxy() {
  const running = state.proxy.running && !state.proxy.error
  const tag = $('#proxy-state')
  tag.className = `tag ${running ? 'on' : 'off'}`
  tag.textContent = running ? `运行中 · ${state.proxy.port}` : '未启动'
  const bases = state.proxy.bases || {}
  $('#base-openai').value = bases.openai || '—'
  $('#base-anthropic').value = bases.anthropic || '—'
  $('#base-google').value = bases.google || '—'
  for (const button of document.querySelectorAll('[data-copy]')) button.disabled = !running
  $('#proxy-toggle').textContent = running ? '停止代理' : '启动代理'
  const error = $('#proxy-error')
  if (state.proxy.error) {
    error.classList.remove('hidden')
    error.textContent = `代理启动失败：${state.proxy.error}`
  } else {
    error.classList.add('hidden')
  }
}

function setValue(id, value) {
  const node = $(id)
  if (!node || node === document.activeElement) return
  node.value = value
}

function renderSettings() {
  const settings = state.settings
  setValue('#set-preempt', settings.preemptAtPercent)
  setValue('#set-consec', settings.switchAfterConsecutiveFailures)
  setValue('#set-interval', String(settings.usageRefreshMs))
  setValue('#set-port', settings.proxyPort)
  $('#set-auto-invalid').checked = settings.autoMarkInvalid
  $('#set-login').checked = settings.launchAtLogin
  $('#set-tray').checked = settings.closeToTray
}

function renderLogs() {
  const box = $('#logs')
  clear(box)
  const logs = (state.logs || []).slice(-80).reverse()
  if (!logs.length) {
    box.append(h('p', { class: 'log-empty' }, '暂时没有事件'))
    return
  }
  for (const entry of logs) {
    box.append(h('div', { class: `log-row ${entry.level}` },
      h('span', { class: 'log-time' }, fmtClock(entry.at)),
      h('span', { class: 'log-msg' }, entry.message),
    ))
  }
}

function renderModels() {
  const group = MODEL_CATALOG[activeProto]
  if (!group) return
  for (const chip of document.querySelectorAll('#proto-tabs .chip')) {
    chip.classList.toggle('active', chip.dataset.proto === activeProto)
  }
  const list = $('#model-list')
  clear(list)
  for (const id of group.models) {
    list.append(h('div', {
      class: 'model-item',
      dataset: { model: id },
      title: '点击复制模型 ID',
    },
      h('span', { class: 'model-id' }, id),
      h('span', { class: 'copy-hint' }, '复制'),
    ))
  }
  $('#model-note').textContent = group.note
}

function render() {
  if (!state) return
  renderHeader()
  renderBanner()
  renderAccounts()
  renderProxy()
  renderSettings()
  renderLogs()
}

// ---- feedback --------------------------------------------------------------

function toast(message, kind = 'ok') {
  const stack = $('#toast')
  const node = h('div', { class: `toast ${kind}` }, message)
  stack.append(node)
  while (stack.children.length > 3) stack.firstChild.remove()
  setTimeout(() => node.classList.add('out'), 2800)
  setTimeout(() => node.remove(), 3200)
}

function fail(error) {
  toast(String((error && error.message) || error), 'err')
}

// ---- actions ---------------------------------------------------------------

async function refreshUsage() {
  const button = $('#refresh-btn')
  const label = button.textContent
  button.disabled = true
  button.textContent = '刷新中…'
  try {
    const result = await api.refreshUsage()
    toast(result && result.skipped ? '正在刷新，请稍候' : '额度已刷新', 'ok')
  } catch (error) {
    fail(error)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

async function onAccountAction(act, id) {
  const account = state.accounts.find(item => item.id === id)
  if (!account) return
  try {
    if (act === 'switch') {
      await api.activate(id)
      toast(`已切换到「${account.label}」`)
    } else if (act === 'disable') {
      if (!window.confirm(`停用「${account.label}」？停用后不再参与自动切号。`)) return
      await api.setDisabled(id, true)
      toast(`已停用「${account.label}」`)
    } else if (act === 'enable') {
      await api.setDisabled(id, false)
      toast(`已启用「${account.label}」`)
    } else if (act === 'edit') {
      openEditor('edit', account)
    } else if (act === 'delete') {
      if (!window.confirm(`删除「${account.label}」？密钥和运行状态都会从本机清除。`)) return
      await api.removeAccount(id)
      toast(`已删除「${account.label}」`)
    }
  } catch (error) {
    fail(error)
  }
}

// ---- account dialog --------------------------------------------------------

function openEditor(mode, account = null) {
  editor = { mode, id: account?.id ?? null }
  $('#dialog-title').textContent = mode === 'edit' ? '编辑账号' : '添加账号'
  $('#f-label').value = account?.label ?? ''
  $('#f-secret').value = ''
  $('#f-secret').placeholder = mode === 'edit' ? '留空则不修改现有密钥' : '粘贴 sk-... 密钥'
  $('#dialog-hint').textContent = mode === 'edit'
    ? '只改名可以留空密钥。填写新密钥会重新验证并清除失效标记。'
    : '密钥使用 Windows DPAPI 加密保存在本机，不会上传到任何服务器。'
  hideDialogError()
  const dialog = $('#account-dialog')
  if (!dialog.open) dialog.showModal()
  setTimeout(() => $('#f-label').focus(), 30)
}

function showDialogError(message) {
  const node = $('#dialog-error')
  node.textContent = message
  node.classList.remove('hidden')
}

function hideDialogError() {
  $('#dialog-error').classList.add('hidden')
}

async function submitEditor(event) {
  event.preventDefault()
  const label = $('#f-label').value.trim()
  const secret = $('#f-secret').value.trim()
  const submit = $('#dialog-submit')
  if (editor.mode === 'add' && secret.length === 0) {
    showDialogError('请粘贴 API Key')
    return
  }
  if (secret.length > 0 && secret.length < 8) {
    showDialogError('密钥太短，请粘贴完整的 OpenCode Go API Key')
    return
  }
  submit.disabled = true
  try {
    if (editor.mode === 'add') {
      await api.addAccount({ label, secret })
      toast('账号已添加')
    } else {
      await api.updateAccount({ id: editor.id, label, secret })
      toast('账号已更新')
    }
    $('#account-dialog').close()
  } catch (error) {
    showDialogError(String((error && error.message) || error))
  } finally {
    submit.disabled = false
  }
}

// ---- wiring ----------------------------------------------------------------

function setupEvents() {
  $('#refresh-btn').addEventListener('click', refreshUsage)
  $('#add-btn').addEventListener('click', () => openEditor('add'))
  $('#empty-add-btn').addEventListener('click', () => openEditor('add'))

  $('#accounts').addEventListener('click', event => {
    const button = event.target.closest('button[data-act]')
    if (!button) return
    onAccountAction(button.dataset.act, button.dataset.id)
  })

  $('#account-form').addEventListener('submit', submitEditor)
  $('#dialog-cancel').addEventListener('click', () => $('#account-dialog').close())
  $('#account-dialog').addEventListener('click', event => {
    if (event.target === $('#account-dialog')) $('#account-dialog').close()
  })

  $('#save-settings').addEventListener('click', async () => {
    const button = $('#save-settings')
    button.disabled = true
    try {
      await api.updateSettings({
        preemptAtPercent: Number($('#set-preempt').value),
        switchAfterConsecutiveFailures: Number($('#set-consec').value),
        usageRefreshMs: Number($('#set-interval').value),
        proxyPort: Number($('#set-port').value),
        launchAtLogin: $('#set-login').checked,
        closeToTray: $('#set-tray').checked,
        autoMarkInvalid: $('#set-auto-invalid').checked,
      })
      toast('设置已保存')
    } catch (error) {
      fail(error)
    } finally {
      button.disabled = false
    }
  })

  $('#proxy-toggle').addEventListener('click', async () => {
    const button = $('#proxy-toggle')
    button.disabled = true
    try {
      await api.toggleProxy()
      toast(state.proxy.running ? '代理已停止' : '代理已启动', 'ok')
    } catch (error) {
      fail(error)
    } finally {
      button.disabled = false
    }
  })

  $('#proxy-card').addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]')
    if (!button) return
    const url = (state.proxy.bases || {})[button.dataset.copy]
    if (!url) return
    try {
      await api.copy(url)
      toast('Base URL 已复制')
    } catch (error) {
      fail(error)
    }
  })

  $('#proto-tabs').addEventListener('click', event => {
    const chip = event.target.closest('.chip[data-proto]')
    if (!chip) return
    activeProto = chip.dataset.proto
    renderModels()
  })

  $('#model-list').addEventListener('click', async event => {
    const item = event.target.closest('.model-item')
    if (!item) return
    try {
      await api.copy(item.dataset.model)
      toast(`已复制模型 ID：${item.dataset.model}`)
    } catch (error) {
      fail(error)
    }
  })

  $('#proxy-health').addEventListener('click', () => {
    if (!state.proxy.running) return fail(new Error('代理未启动'))
    api.openExternal(`http://${state.proxy.host}:${state.proxy.port}/pool/health`).catch(fail)
  })

  $('#clear-logs').addEventListener('click', async () => {
    try {
      await api.clearLogs()
      toast('日志已清空')
    } catch (error) {
      fail(error)
    }
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('#account-dialog').open) $('#account-dialog').close()
  })
}

function startTicker() {
  if (ticker) clearInterval(ticker)
  ticker = setInterval(() => {
    for (const node of document.querySelectorAll('[data-reset]')) {
      const iso = node.dataset.reset
      node.textContent = `重置 ${fmtReset(iso)}`
    }
  }, 15000)
}

async function boot() {
  if (!api) {
    document.body.innerHTML = '<p style="padding:24px;font:14px Segoe UI">预加载脚本未加载，无法访问主进程。</p>'
    return
  }
  setupEvents()
  renderModels()
  try {
    state = await api.state()
    render()
    info = await api.info()
    $('#footer-info').textContent = `v${info.version} · ${info.encryption} · 数据目录 ${info.dataDir}`
  } catch (error) {
    fail(error)
  }
  api.onState(snapshot => {
    state = snapshot
    render()
  })
  api.onLog(entry => {
    if (!state) return
    state.logs = [...(state.logs || []), entry].slice(-120)
    renderLogs()
  })
  startTicker()
}

boot()
