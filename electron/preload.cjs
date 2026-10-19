// Preload: the only bridge between the renderer and the main process.
// Secrets never cross this bridge: the renderer can set a secret but can never
// read one back.

const { contextBridge, ipcRenderer } = require('electron')

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload)
  if (result && result.ok) return result.value
  throw new Error((result && result.error) || '操作失败')
}

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('pool', {
  state: () => invoke('app:state'),
  info: () => invoke('app:info'),

  addAccount: payload => invoke('accounts:add', payload),
  updateAccount: payload => invoke('accounts:update', payload),
  removeAccount: id => invoke('accounts:remove', { id }),
  activate: id => invoke('accounts:activate', { id }),
  setDisabled: (id, disabled) => invoke('accounts:disable', { id, disabled }),
  cycle: () => invoke('accounts:cycle'),

  updateSettings: patch => invoke('settings:update', patch),
  refreshUsage: () => invoke('usage:refresh'),
  listModels: () => invoke('models:list'),
  toggleProxy: () => invoke('proxy:toggle'),
  clearLogs: () => invoke('logs:clear'),

  copy: text => invoke('clipboard:write', text),
  openExternal: url => invoke('shell:open-external', url),
  hide: () => invoke('window:hide'),

  onState: callback => subscribe('state', callback),
  onLog: callback => subscribe('log', callback),

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
