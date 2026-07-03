const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkEnv: () => ipcRenderer.invoke('check-env'),
  serverAction: (action) => ipcRenderer.invoke('server-action', action),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_, data) => cb(data)),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  doUpdate: (zipUrl) => ipcRenderer.invoke('do-update', zipUrl),
  openExtensions: () => ipcRenderer.invoke('open-extensions'),
  getExtPath: () => ipcRenderer.invoke('get-ext-path'),
  installServerDeps: () => ipcRenderer.invoke('install-server-deps'),
  installExtension: () => ipcRenderer.invoke('install-extension'),
  openExtDir: () => ipcRenderer.invoke('open-ext-dir')
});
