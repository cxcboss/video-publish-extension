const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
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
const EXTENSION_SRC = path.join(__dirname, '..', 'chrome-extension');
const EXTENSION_DEST = path.join(app.getPath('userData'), 'chrome-extension');
const REPO = 'cxcboss/video-publish-extension';
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 500,
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

function startServer() {
  if (serverProcess) return;

  serverProcess = spawn('node', [SERVER_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(SERVER_PORT) }
  });

  serverProcess.on('error', (err) => {
    serverRunning = false;
    mainWindow?.webContents.send('server-status', { running: false, error: err.message });
  });

  serverProcess.on('exit', (code) => {
    serverRunning = false;
    serverProcess = null;
    mainWindow?.webContents.send('server-status', { running: false, error: `进程退出 code=${code}` });
  });

  serverProcess.stdout?.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('listening') || msg.includes('Server running') || msg.includes('3000')) {
      serverRunning = true;
      mainWindow?.webContents.send('server-status', { running: true });
    }
  });

  serverProcess.stderr?.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('EADDRINUSE')) {
      serverRunning = true;
      mainWindow?.webContents.send('server-status', { running: true, note: '端口已被占用，服务可能已在运行' });
    }
  });

  setTimeout(() => checkServerHealth(), 3000);
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  serverRunning = false;
}

function checkServerHealth() {
  const req = http.get(`http://127.0.0.1:${SERVER_PORT}/health`, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
      serverRunning = true;
      mainWindow?.webContents.send('server-status', { running: true });
    });
  });
  req.on('error', () => {
    serverRunning = false;
    mainWindow?.webContents.send('server-status', { running: false });
  });
  req.setTimeout(3000, () => { req.destroy(); });
}

async function checkForUpdate() {
  try {
    const r = await fetch(GITHUB_API);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const release = await r.json();
    const currentVersion = app.getVersion();
    const latestVersion = (release.tag_name || '').replace('v', '');

    if (!latestVersion) return { hasUpdate: false };

    const curParts = currentVersion.split('.').map(Number);
    const latParts = latestVersion.split('.').map(Number);
    let isNewer = false;
    for (let i = 0; i < 3; i++) {
      if ((latParts[i] || 0) > (curParts[i] || 0)) { isNewer = true; break; }
      if ((latParts[i] || 0) < (curParts[i] || 0)) break;
    }

    return {
      hasUpdate: isNewer,
      currentVersion,
      latestVersion,
      changelog: release.body || '',
      zipUrl: release.zipball_url || ''
    };
  } catch (e) {
    return { hasUpdate: false, error: e.message };
  }
}

async function downloadAndInstall(zipUrl) {
  const tmpZip = path.join(app.getPath('temp'), 'video-publish-extension-update.zip');
  const tmpDir = path.join(app.getPath('temp'), 'vpe-update-extract');

  try {
    const r = await fetch(zipUrl);
    if (!r.ok) throw new Error(`下载失败: HTTP ${r.status}`);

    const buffer = await r.buffer();
    fs.writeFileSync(tmpZip, buffer);

    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    await extractZip(tmpZip, { dir: tmpDir });

    const entries = fs.readdirSync(tmpDir);
    const repoDir = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
      ? path.join(tmpDir, entries[0])
      : tmpDir;

    const srcExt = path.join(repoDir, 'chrome-extension');
    if (!fs.existsSync(srcExt)) throw new Error('ZIP 中未找到 chrome-extension 目录');

    fs.cpSync(srcExt, EXTENSION_DEST, { recursive: true });

    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { success: true };
  } catch (e) {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: e.message };
  }
}

app.whenReady().then(() => {
  createWindow();
  startServer();

  ipcMain.handle('server-action', async (e, action) => {
    if (action === 'start') { startServer(); return { ok: true }; }
    if (action === 'stop') { stopServer(); return { ok: true }; }
    if (action === 'restart') { stopServer(); await new Promise(r => setTimeout(r, 500)); startServer(); return { ok: true }; }
    if (action === 'check') { checkServerHealth(); return { ok: true }; }
  });

  ipcMain.handle('check-update', () => checkForUpdate());

  ipcMain.handle('do-update', async (e, zipUrl) => {
    const result = await downloadAndInstall(zipUrl);
    if (result.success) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '更新完成',
        message: '插件已更新，请在 Chrome 扩展管理页面点击「重新加载」以生效。',
        buttons: ['打开扩展管理页', '确定']
      }).then(({ response }) => {
        if (response === 0) shell.openExternal('chrome://extensions');
      });
    }
    return result;
  });

  ipcMain.handle('open-extensions', () => shell.openExternal('chrome://extensions'));
  ipcMain.handle('open-github', () => shell.openExternal(`https://github.com/${REPO}/releases`));
  ipcMain.handle('get-version', () => app.getVersion());
  ipcMain.handle('get-ext-path', () => EXTENSION_DEST);

  // 一键安装服务依赖
  ipcMain.handle('install-server-deps', async () => {
    try {
      const { execSync } = require('child_process');
      execSync('npm install', { cwd: SERVER_DIR, stdio: 'pipe', timeout: 120000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 安装浏览器插件到 userData 目录
  ipcMain.handle('install-extension', async () => {
    try {
      if (!fs.existsSync(EXTENSION_SRC)) throw new Error('源插件目录不存在');
      fs.cpSync(EXTENSION_SRC, EXTENSION_DEST, { recursive: true });
      return { success: true, path: EXTENSION_DEST };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 打开插件安装目录
  ipcMain.handle('open-ext-dir', () => {
    shell.openPath(EXTENSION_DEST);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopServer();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});
