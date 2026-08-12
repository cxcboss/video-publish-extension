const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'local-server');

let child = null;
let port = 0;
let tmpDir = null;
let videoFile = null;
const historyFile = path.join(os.tmpdir(), `vpe-test-history-${Date.now()}.json`);
const retryFile = path.join(os.tmpdir(), `vpe-test-retry-${Date.now()}.json`);

function baseUrl() { return `http://127.0.0.1:${port}`; }

function rawRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test.before(async () => {
  // 临时视频目录 + 100 字节假视频
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-test-videos-'));
  videoFile = path.join(tmpDir, '测试视频.mp4');
  fs.writeFileSync(videoFile, Buffer.alloc(100, 7));

  child = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: '0',
      VPE_HISTORY_FILE: historyFile,
      VPE_RETRY_FILE: retryFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('服务启动超时')), 10000);
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      const m = text.match(/运行在 http:\/\/localhost:(\d+)/);
      if (m) {
        port = parseInt(m[1], 10);
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`服务提前退出: ${code}`));
    });
  });
});

test.after(() => {
  if (child) child.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fs.existsSync(historyFile)) fs.rmSync(historyFile, { force: true });
  if (fs.existsSync(retryFile)) fs.rmSync(retryFile, { force: true });
});

test('健康检查可用', async () => {
  const r = await fetch(`${baseUrl()}/health`);
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.status, 'ok');
});

test('安全：恶意网页 Origin 被拒绝', async () => {
  const r = await fetch(`${baseUrl()}/api/videos?path=${encodeURIComponent(tmpDir)}`, {
    headers: { Origin: 'https://evil.com' }
  });
  assert.strictEqual(r.status, 403);
});

test('安全：跨站无 Origin 请求（媒体标签类）被拒绝', async () => {
  const r = await fetch(`${baseUrl()}/api/videos?path=${encodeURIComponent(tmpDir)}`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.strictEqual(r.status, 403);
});

test('安全：非回环 Host 被拒绝（防 DNS rebinding）', async () => {
  const r = await rawRequest({
    host: '127.0.0.1', port,
    path: '/api/videos',
    headers: { Host: 'evil.com' }
  });
  assert.strictEqual(r.status, 403);
});

test('内容脚本（平台 Origin）可访问视频列表', async () => {
  const r = await fetch(`${baseUrl()}/api/videos?path=${encodeURIComponent(tmpDir)}`, {
    headers: { Origin: 'https://creator.douyin.com' }
  });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.videos.length, 1);
  assert.strictEqual(d.videos[0].name, '测试视频.mp4');
  assert.strictEqual(d.videos[0].size, 100);
});

test('无 Origin 无 Sec-Fetch-Site（本机工具）可访问', async () => {
  const r = await fetch(`${baseUrl()}/api/videos?path=${encodeURIComponent(tmpDir)}`);
  assert.strictEqual(r.status, 200);
});

test('视频文件 Range 请求返回 206 与正确字节', async () => {
  const r = await fetch(`${baseUrl()}/api/video/file?path=${encodeURIComponent(videoFile)}`, {
    headers: { Range: 'bytes=0-9' }
  });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 0-9/100');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.length, 10);
  assert.strictEqual(r.headers.get('content-type'), 'video/mp4');
});

test('视频文件非法 Range 返回 416', async () => {
  const r = await fetch(`${baseUrl()}/api/video/file?path=${encodeURIComponent(videoFile)}`, {
    headers: { Range: 'bytes=999-1000' }
  });
  assert.strictEqual(r.status, 416);
});

test('发布记录：POST → 列表 → DELETE → 分页', async () => {
  const post = (name) => fetch(`${baseUrl()}/api/publish-record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoName: name, videoPath: tmpDir, platform: 'douyin', status: 'success' })
  });
  const r1 = await post('视频A.mp4');
  assert.strictEqual(r1.status, 200);
  const recA = (await r1.json()).record;
  await post('视频B.mp4');
  await post('视频C.mp4');

  const list = await (await fetch(`${baseUrl()}/api/publish-history?offset=1&limit=2`)).json();
  assert.strictEqual(list.total, 3);
  assert.strictEqual(list.history.length, 2);

  const del = await fetch(`${baseUrl()}/api/publish-record/${recA.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const after = await (await fetch(`${baseUrl()}/api/publish-history`)).json();
  assert.strictEqual(after.total, 2);
});

test('重发队列：POST 去重 → GET → DELETE', async () => {
  const add = () => fetch(`${baseUrl()}/api/retry-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoPath: tmpDir, videoName: '视频A.mp4' })
  });
  assert.strictEqual((await add()).status, 200);
  assert.strictEqual((await add()).status, 200);
  const items = (await (await fetch(`${baseUrl()}/api/retry-queue`)).json()).items;
  assert.strictEqual(items.length, 1); // 幂等去重

  const del = await fetch(`${baseUrl()}/api/retry-queue`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const empty = (await (await fetch(`${baseUrl()}/api/retry-queue`)).json()).items;
  assert.strictEqual(empty.length, 0);
});
