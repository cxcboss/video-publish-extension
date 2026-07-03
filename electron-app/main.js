const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const fetch = require('node-fetch');
const extractZip = require('extract-zip');

let mainWindow = null;
let serverProcess = null;
let serverRunning = false;

const SERVER_PORT = 3000;
const SERVER_PATH = path.join(__dirname, '..', 'local-server', 'server.js');
const SERVER_DIR = path.join(__dirname, '..', 'local-server');
const NODE_MODULES = path.join(SERVER_DIR, 'node_modules');
const EXTENSION_SRC = path.join(__dirname, '..', 'chrome-extension');
const EXTENSION_DEST = path.join(app.getPath('userData'), 'chrome-extension');
const INSTALLED_MANIFEST = path.join(EXTENSION_DEST, 'manifest.json');
const REPO = 'cxcboss/video-publish-extension';
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    title: 'AI 视频发布助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
}

// ==================== 环境检测 ====================

function checkEnvironment() {
  const depsInstalled = fs.existsSync(NODE_MODULES);
  const extInstalled = fs.existsSync(INSTALLED_MANIFEST);
  let extVersion = null;
  if (extInstalled) {
    try { extVersion = JSON.parse(fs.readFileSync(INSTALLED_MANIFEST, 'utf8')).version; } catch (_) {}
  }
  return { depsInstalled, extInstalled, extVersion };
}

// ==================== 服务管理 ====================

function startServer() {
  if (serverProcess) return;
  serverProcess = spawn('node', [SERVER_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(SERVER_PORT) }
  });
  serverProcess.on('error', () => {
    serverRunning = false;
    mainWindow?.webContents.send('server-status', { running: false });
  });
  serverProcess.on('exit', () => {
    serverRunning = false;
    serverProcess = null;
    mainWindow?.webContents.send('server-status', { running: false });
  });
  serverProcess.stdout?.on('data', (data) => {
    if (data.toString().includes('3000')) {
      serverRunning = true;
      mainWindow?.webContents.send('server-status', { running: true });
    }
  });
  serverProcess.stderr?.on('data', (data) => {
    if (data.toString().includes('EADDRINUSE')) {
      serverRunning = true;
      mainWindow?.webContents.send('server-status', { running: true, note: '端口已被占用' });
    }
  });
  setTimeout(() => checkServerHealth(), 3000);
}

function stopServer() {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
  serverRunning = false;
}

function checkServerHealth() {
  const req = http.get(`http://127.0.0.1:${SERVER_PORT}/health`, () => {
    serverRunning = true;
    mainWindow?.webContents.send('server-status', { running: true });
  });
  req.on('error', () => {
    serverRunning = false;
    mainWindow?.webContents.send('server-status', { running: false });
  });
  req.setTimeout(3000, () => req.destroy());
}

// ==================== 更新检测 ====================

function getInstalledExtVersion() {
  if (!fs.existsSync(INSTALLED_MANIFEST)) return null;
  try { return JSON.parse(fs.readFileSync(INSTALLED_MANIFEST, 'utf8')).version; } catch (_) { return null; }
}

async function checkForUpdate() {
  const installedVersion = getInstalledExtVersion();
  try {
    const r = await fetch(GITHUB_API, { timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const release = await r.json();
    const latestVersion = (release.tag_name || '').replace('v', '');
    if (!latestVersion) return { hasUpdate: false, installedVersion, latestVersion: null };

    const curParts = (installedVersion || '0.0.0').split('.').map(Number);
    const latParts = latestVersion.split('.').map(Number);
    let isNewer = false;
    for (let i = 0; i < 3; i++) {
      if ((latParts[i] || 0) > (curParts[i] || 0)) { isNewer = true; break; }
      if ((latParts[i] || 0) < (curParts[i] || 0)) break;
    }

    return { hasUpdate: isNewer, installedVersion, latestVersion, changelog: release.body || '', zipUrl: release.zipball_url || '' };
  } catch (e) {
    return { hasUpdate: false, installedVersion, latestVersion: null, error: e.message || '网络连接失败' };
  }
}

async function downloadAndInstall(zipUrl) {
  const tmpZip = path.join(app.getPath('temp'), 'vpe-update.zip');
  const tmpDir = path.join(app.getPath('temp'), 'vpe-update-extract');
  try {
    const r = await fetch(zipUrl, { timeout: 60000 });
    if (!r.ok) throw new Error(`下载失败: HTTP ${r.status}`);
    fs.writeFileSync(tmpZip, await r.buffer());
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    await extractZip(tmpZip, { dir: tmpDir });
    // ZIP 内可能有一层仓库根目录包裹
    const entries = fs.readdirSync(tmpDir);
    const root = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
      ? path.join(tmpDir, entries[0]) : tmpDir;
    // 仓库打包的 ZIP 内 chrome-extension 在根目录（我们只打包插件内容）
    const src = fs.existsSync(path.join(root, 'manifest.json')) ? root
      : fs.existsSync(path.join(root, 'chrome-extension')) ? path.join(root, 'chrome-extension')
      : null;
    if (!src) throw new Error('ZIP 中未找到插件文件');
    // 先清空再覆盖
    if (fs.existsSync(EXTENSION_DEST)) fs.rmSync(EXTENSION_DEST, { recursive: true });
    fs.cpSync(src, EXTENSION_DEST, { recursive: true });
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: true };
  } catch (e) {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: e.message };
  }
}

// ==================== IPC ====================

app.whenReady().then(() => {
  createWindow();
  startServer();

  // 启动时检测环境
  ipcMain.handle('check-env', () => checkEnvironment());

  ipcMain.handle('server-action', async (e, action) => {
    if (action === 'start') { startServer(); return { ok: true }; }
    if (action === 'stop') { stopServer(); return { ok: true }; }
    if (action === 'restart') { stopServer(); await new Promise(r => setTimeout(r, 500)); startServer(); return { ok: true }; }
    if (action === 'check') { checkServerHealth(); return { ok: true }; }
  });

  ipcMain.handle('install-server-deps', async () => {
    try {
      execSync('npm install', { cwd: SERVER_DIR, stdio: 'pipe', timeout: 120000 });
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('install-extension', async () => {
    try {
      if (!fs.existsSync(EXTENSION_SRC)) throw new Error('源插件目录不存在');
      fs.cpSync(EXTENSION_SRC, EXTENSION_DEST, { recursive: true });
      return { success: true, path: EXTENSION_DEST };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('check-update', () => checkForUpdate());

  ipcMain.handle('do-update', async (e, zipUrl) => {
    const result = await downloadAndInstall(zipUrl);
    if (result.success) {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '更新完成',
        message: '插件已更新，请在 Chrome 扩展管理页面点击「重新加载」以生效。',
        buttons: ['打开扩展管理页', '确定']
      }).then(({ response }) => { if (response === 0) shell.openExternal('chrome://extensions'); });
    }
    return result;
  });

  ipcMain.handle('open-ext-dir', () => shell.openPath(EXTENSION_DEST));
  ipcMain.handle('open-extensions', () => shell.openExternal('chrome://extensions'));
  ipcMain.handle('get-ext-path', () => EXTENSION_DEST);

  mainWindow.on('closed', () => { mainWindow = null; stopServer(); app.quit(); });
});

app.on('window-all-closed', () => { stopServer(); app.quit(); });
