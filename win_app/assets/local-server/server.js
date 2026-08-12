const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm'];
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv'
};
const HISTORY_FILE = process.env.VPE_HISTORY_FILE || path.join(__dirname, 'publish_history.json');
const RETRY_FILE = process.env.VPE_RETRY_FILE || path.join(__dirname, 'retry_queue.json');
const MAX_HISTORY = 5000;
const PAGE_SIZE = 200;

// ========== 安全中间件 ==========
// 本服务运行在 localhost，但浏览器内任意网页都可向它发起请求。
// 三层防护：1) Host 必须为回环地址（防 DNS rebinding）；2) Origin 白名单（扩展/平台页/本机页面）；
// 3) 无 Origin 请求（img/video/script 标签等 no-cors 请求）阻断跨站（Sec-Fetch-Site: cross-site）。
// 说明：内容脚本的 fetch 携带页面 Origin（creator.douyin.com / channels.weixin.qq.com），
// 故这两个平台域名在白名单中；该信任边界的残余风险为平台自身存在 XSS，属可接受范围。

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_ORIGIN_HOSTS = new Set(['creator.douyin.com', 'channels.weixin.qq.com']);

function originHostname(origin) {
  try { return new URL(origin).hostname; } catch (_) { return ''; }
}

app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    return res.status(403).json({ error: '拒绝访问：仅允许本机请求' });
  }

  const origin = req.headers.origin;
  if (origin) {
    if (!origin.startsWith('chrome-extension://')) {
      const hn = originHostname(origin);
      if (!LOOPBACK_HOSTS.has(hn) && !ALLOWED_ORIGIN_HOSTS.has(hn)) {
        return res.status(403).json({ error: '拒绝访问：来源不受信任' });
      }
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: '拒绝访问：跨站请求' });
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());

// ========== 历史记录（内存缓存 + 串行写队列） ==========

let historyCache = null;
let writeChain = Promise.resolve();

function loadHistory() {
  if (historyCache !== null) return historyCache;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      historyCache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('加载历史记录失败:', e.message);
  }
  if (!Array.isArray(historyCache)) historyCache = [];
  return historyCache;
}

function saveHistory(history) {
  historyCache = Array.isArray(history) ? history.slice(0, MAX_HISTORY) : [];
  const snapshot = JSON.stringify(historyCache, null, 2);
  writeChain = writeChain
    .then(() => new Promise((resolve, reject) => {
      fs.writeFile(HISTORY_FILE, snapshot, 'utf8', err => (err ? reject(err) : resolve()));
    }))
    .catch(err => console.error('保存历史记录失败:', err.message));
}

// ========== 重发队列（历史页 → 插件恢复入口） ==========

let retryCache = null;
let retryWriteChain = Promise.resolve();

function loadRetryQueue() {
  if (retryCache !== null) return retryCache;
  try {
    if (fs.existsSync(RETRY_FILE)) {
      retryCache = JSON.parse(fs.readFileSync(RETRY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('加载重发队列失败:', e.message);
  }
  if (!Array.isArray(retryCache)) retryCache = [];
  return retryCache;
}

function saveRetryQueue(items) {
  retryCache = Array.isArray(items) ? items : [];
  const snapshot = JSON.stringify(retryCache, null, 2);
  retryWriteChain = retryWriteChain
    .then(() => new Promise((resolve, reject) => {
      fs.writeFile(RETRY_FILE, snapshot, 'utf8', err => (err ? reject(err) : resolve()));
    }))
    .catch(err => console.error('保存重发队列失败:', err.message));
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function groupByDirectory(history) {
  const groups = {};
  history.forEach(record => {
    const dir = record.videoPath || '未知目录';
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(record);
  });
  return groups;
}

function statusMeta(record) {
  const cls = record.status === 'failed' ? 'failed'
    : record.status === 'unknown' ? 'unknown'
    : (record.scheduled ? 'scheduled' : 'success');
  const text = record.status === 'failed' ? '失败'
    : record.status === 'unknown' ? '结果未知'
    : (record.scheduled ? '定时' : '已发');
  return { cls, text };
}

const STATUS_SVGS = {
  failed: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-2h2v2h-2zm0-4V7h2v6h-2z"/></svg>',
  unknown: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>',
  scheduled: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>',
  success: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
};
const PLATFORM_SVGS = {
  douyin: '<svg viewBox="0 0 24 24"><path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0015.54 3h-3.09v12.4a2.592 2.592 0 01-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6 0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 004.3 1.38V7.3s-1.88.09-3.24-1.48z"/></svg>',
  weixin: '<svg viewBox="0 0 24 24"><path d="M8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm7 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm-3.5 7c-4.42 0-8-2.69-8-6 0-.75.14-1.47.4-2.14.06-.16.13-.31.2-.46.14-.31.31-.6.5-.87.03-.04.06-.08.09-.12C7.04 6.96 9.39 5.5 12 5.5s4.96 1.46 6.31 2.91c.03.04.06.08.09.12.19.27.36.56.5.87.07.15.14.3.2.46.26.67.4 1.39.4 2.14 0 3.31-3.58 6-8 6z"/></svg>'
};

function renderRecord(record) {
  const { cls, text } = statusMeta(record);
  const canRetry = record.status === 'failed' || record.status === 'unknown';
  return `
    <div class="history-item" data-id="${record.id}" data-platform="${record.platform}" data-date="${new Date(record.publishTime).toDateString()}">
      <div class="platform-badge ${record.platform}">${PLATFORM_SVGS[record.platform] || PLATFORM_SVGS.weixin}</div>
      <div class="video-info">
        <div class="video-name" onclick="playVideo('${escapeHtml(record.videoPath || '')}', '${escapeHtml(record.videoName || '')}')" title="${escapeHtml(record.videoName)}">${escapeHtml(record.videoName)}</div>
        <div class="video-meta">
          <span>${record.platform === 'douyin' ? '抖音' : '视频号'}</span>
          <span>${formatDate(record.publishTime)} ${formatTime(record.publishTime)}</span>
        </div>
        ${record.topics && record.topics.length > 0 ? `<div class="topics">${record.topics.map(t => '<span class="topic">' + escapeHtml(t) + '</span>').join('')}</div>` : ''}
        ${record.description ? `<div class="description">${escapeHtml(record.description)}</div>` : ''}
        ${record.error ? `<div class="description" style="border-left-color:var(--danger);color:var(--danger)">${escapeHtml(record.error)}</div>` : ''}
      </div>
      <div class="status-col">
        <span class="publish-time-text">${formatTime(record.publishTime)}</span>
        <span class="status-badge ${cls}">${STATUS_SVGS[cls]}${text}</span>
      </div>
      <div class="action-btns">
        <button class="action-btn" onclick="playVideo('${escapeHtml(record.videoPath || '')}', '${escapeHtml(record.videoName || '')}')" title="播放">
          <svg viewBox="0 0 24 24" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
        ${canRetry ? `<button class="action-btn retry" onclick="addRetry('${escapeHtml(record.videoPath || '')}', '${escapeHtml(record.videoName || '')}')" title="加入重发队列">
          <svg viewBox="0 0 24 24" stroke-width="2" fill="none"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        </button>` : ''}
        <button class="action-btn danger" onclick="deleteRecord(${record.id})" title="删除">
          <svg viewBox="0 0 24 24" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>`;
}

function renderGroups(records) {
  const groups = groupByDirectory(records);
  if (Object.keys(groups).length === 0) {
    return `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M9 10h.01M15 10h.01M9.5 15.5a3.5 3.5 0 015 0"/></svg>
        <h3>暂无发布记录</h3>
        <p>发布视频后，记录将显示在这里</p>
      </div>`;
  }
  return Object.entries(groups).map(([dir, records]) => `
    <div class="directory-group" data-directory="${escapeHtml(dir)}">
      <div class="directory-header" onclick="toggleGroup(this)">
        <span class="folder-icon"><svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(dir)}</span>
        <span class="count">${records.length}</span>
      </div>
      <div class="history-list">
        ${records.map(renderRecord).join('')}
      </div>
    </div>
  `).join('');
}

// ========== 首页（发布历史，分页渲染） ==========

app.get('/', (req, res) => {
  const history = loadHistory();
  const stats = {
    total: history.length,
    douyin: history.filter(h => h.platform === 'douyin').length,
    weixin: history.filter(h => h.platform === 'weixin').length,
    today: history.filter(h => {
      const today = new Date().toDateString();
      return new Date(h.publishTime).toDateString() === today;
    }).length
  };

  const visible = history.slice(0, PAGE_SIZE);

  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>视频发布历史记录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #ffffff; --bg-card: #f5f5f5; --bg-hover: #f0f0f0;
      --border: #e0e0e0; --text: #1a1a1a; --text-2: #666666; --text-3: #999999;
      --accent: #12C508; --accent-bg: rgba(18,197,8,0.1);
      --danger: #f44336; --danger-bg: rgba(244,67,54,0.1);
      --warn: #FF9800; --warn-bg: rgba(255,152,0,0.1);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1a1a; --bg-card: #252525; --bg-hover: #2a2a2a;
        --border: #3a3a3a; --text: #e0e0e0; --text-2: #aaaaaa; --text-3: #777777;
        --accent-bg: rgba(18,197,8,0.15);
        --danger-bg: rgba(244,67,54,0.15);
        --warn-bg: rgba(255,152,0,0.15);
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 960px; margin: 0 auto; }
    .header { margin-bottom: 20px; }
    .header h1 { font-size: 20px; font-weight: 700; color: var(--text); }
    .header p { font-size: 12px; color: var(--text-3); margin-top: 2px; }

    .stats { display: flex; gap: 10px; margin-bottom: 16px; }
    .stat-card {
      flex: 1; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px; text-align: center;
    }
    .stat-card .number { font-size: 24px; font-weight: 700; color: var(--accent); }
    .stat-card .label { font-size: 11px; color: var(--text-3); margin-top: 2px; }

    .filter-bar { display: flex; gap: 6px; margin-bottom: 14px; }
    .filter-btn {
      padding: 5px 14px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg); color: var(--text-2); cursor: pointer;
      font-size: 12px; transition: all 0.15s;
    }
    .filter-btn:hover { border-color: var(--text-3); color: var(--text); }
    .filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

    .directory-group { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .directory-header {
      background: var(--bg-card); padding: 10px 14px;
      font-size: 12px; font-weight: 600; color: var(--text-2);
      display: flex; align-items: center; gap: 8px; cursor: pointer;
    }
    .directory-header:hover { background: var(--bg-hover); }
    .directory-header .folder-icon svg { width: 14px; height: 14px; stroke: var(--text-3); fill: none; }
    .directory-header .count {
      background: var(--accent-bg); color: var(--accent);
      padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
    }

    .history-list { display: flex; flex-direction: column; }
    .history-item {
      padding: 10px 14px; display: flex; align-items: center; gap: 12px;
      border-top: 1px solid var(--border); transition: background 0.1s;
    }
    .history-item:hover { background: var(--bg-hover); }

    .platform-badge {
      width: 28px; height: 28px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .platform-badge svg { width: 14px; height: 14px; }
    .platform-badge.douyin { background: #000; }
    .platform-badge.douyin svg { fill: #fff; }
    .platform-badge.weixin { background: #E78815; }
    .platform-badge.weixin svg { fill: #fff; }

    .video-info { flex: 1; min-width: 0; }
    .video-name { font-size: 13px; font-weight: 600; color: var(--text); cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .video-name:hover { color: var(--accent); }
    .video-meta { display: flex; gap: 12px; margin-top: 3px; font-size: 11px; color: var(--text-3); }
    .video-meta span { display: flex; align-items: center; gap: 3px; }
    .video-meta svg { width: 11px; height: 11px; stroke: var(--text-3); fill: none; }

    .topics { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    .topic {
      background: var(--accent-bg); color: var(--accent);
      padding: 1px 8px; border-radius: 4px; font-size: 11px;
    }
    .description {
      margin-top: 5px; padding: 6px 10px; background: var(--bg-card);
      border-radius: 5px; font-size: 12px; color: var(--text-2);
      border-left: 2px solid var(--accent);
    }

    .status-col { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 70px; flex-shrink: 0; }
    .publish-time-text { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
    .status-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
    }
    .status-badge svg { width: 11px; height: 11px; }
    .status-badge.success { background: var(--accent-bg); color: var(--accent); }
    .status-badge.success svg { fill: var(--accent); }
    .status-badge.scheduled { background: var(--warn-bg); color: var(--warn); }
    .status-badge.scheduled svg { fill: var(--warn); }
    .status-badge.failed { background: var(--danger-bg); color: var(--danger); }
    .status-badge.failed svg { fill: var(--danger); }
    .status-badge.unknown { background: rgba(156,39,176,0.12); color: #9C27B0; }
    .status-badge.unknown svg { fill: #9C27B0; }

    .action-btns { display: flex; gap: 4px; flex-shrink: 0; }
    .action-btn {
      width: 28px; height: 28px; border-radius: 5px; border: 1px solid var(--border);
      background: var(--bg); cursor: pointer; display: flex;
      align-items: center; justify-content: center; transition: all 0.15s;
    }
    .action-btn svg { width: 12px; height: 12px; stroke: var(--text-2); fill: none; }
    .action-btn:hover { border-color: var(--accent); }
    .action-btn:hover svg { stroke: var(--accent); }
    .action-btn.retry:hover { border-color: var(--warn); }
    .action-btn.retry:hover svg { stroke: var(--warn); }
    .action-btn.danger:hover { border-color: var(--danger); }
    .action-btn.danger:hover svg { stroke: var(--danger); }

    .load-more { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px 0 4px; }
    .load-more button {
      padding: 6px 22px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg); color: var(--text-2); cursor: pointer; font-size: 12px;
    }
    .load-more button:hover { border-color: var(--accent); color: var(--accent); }
    .load-more button:disabled { opacity: 0.4; cursor: default; }
    .load-more .info { font-size: 11px; color: var(--text-3); }

    .empty-state { text-align: center; padding: 48px 20px; color: var(--text-3); }
    .empty-state svg { width: 40px; height: 40px; stroke: var(--border); fill: none; margin-bottom: 12px; }
    .empty-state h3 { font-size: 14px; color: var(--text-2); margin-bottom: 4px; }
    .empty-state p { font-size: 12px; }

    .video-modal {
      display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.85); z-index: 1000; justify-content: center; align-items: center;
    }
    .video-modal.active { display: flex; }
    .video-modal video { max-width: 90%; max-height: 90%; border-radius: 8px; }
    .video-modal .close-btn {
      position: absolute; top: 16px; right: 24px;
      width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,0.15);
      border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .video-modal .close-btn svg { width: 16px; height: 16px; stroke: #fff; fill: none; }
    .video-modal .close-btn:hover { background: rgba(255,255,255,0.3); }

    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.8); color: #fff; padding: 8px 16px;
      border-radius: 6px; font-size: 12px; z-index: 1100; transition: opacity 0.3s;
    }

    @media (max-width: 640px) {
      body { padding: 12px; }
      .stats { flex-wrap: wrap; }
      .stat-card { min-width: calc(50% - 5px); }
      .history-item { flex-wrap: wrap; }
      .video-info { width: calc(100% - 40px); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>发布历史记录</h1>
      <p>AI 视频发布助手</p>
    </div>

    <div class="stats">
      <div class="stat-card">
        <div class="number">${stats.total}</div>
        <div class="label">总发布</div>
      </div>
      <div class="stat-card">
        <div class="number">${stats.douyin}</div>
        <div class="label">抖音</div>
      </div>
      <div class="stat-card">
        <div class="number">${stats.weixin}</div>
        <div class="label">视频号</div>
      </div>
      <div class="stat-card">
        <div class="number">${stats.today}</div>
        <div class="label">今日</div>
      </div>
    </div>

    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterRecords('all')">全部</button>
      <button class="filter-btn" onclick="filterRecords('douyin')">抖音</button>
      <button class="filter-btn" onclick="filterRecords('weixin')">视频号</button>
      <button class="filter-btn" onclick="filterRecords('today')">今日</button>
    </div>

    <div id="historyList">
      ${renderGroups(visible)}
    </div>

    <div class="load-more" id="load-more" style="${history.length <= PAGE_SIZE ? 'display:none' : ''}">
      <button id="load-more-btn" onclick="loadMoreRecords()">加载更多</button>
      <span class="info" id="load-more-info">已显示 ${visible.length} / 共 ${history.length} 条</span>
    </div>
  </div>

  <div class="video-modal" id="videoModal" onclick="closeVideoModal(event)">
    <button class="close-btn" onclick="closeVideoModal()">
      <svg viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <video id="videoPlayer" controls></video>
  </div>

  <script>
    const PAGE_SIZE = ${PAGE_SIZE};
    let totalRecords = ${history.length};
    let shownRecords = ${visible.length};

    function filterRecords(filter) {
      document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      const today = new Date().toDateString();
      document.querySelectorAll('.directory-group').forEach(group => {
        let hasVisibleItems = false;
        group.querySelectorAll('.history-item').forEach(item => {
          const platform = item.dataset.platform;
          const date = item.dataset.date;
          let visible = filter === 'all' ? true : filter === 'today' ? date === today : platform === filter;
          item.style.display = visible ? 'flex' : 'none';
          if (visible) hasVisibleItems = true;
        });
        group.style.display = hasVisibleItems ? 'block' : 'none';
      });
    }

    function toggleGroup(header) {
      const list = header.nextElementSibling;
      list.style.display = list.style.display === 'none' ? 'flex' : 'none';
    }

    async function deleteRecord(id) {
      if (!confirm('确定要删除这条记录吗？')) return;
      try {
        const response = await fetch('/api/publish-record/' + id, { method: 'DELETE' });
        if (response.ok) location.reload(); else alert('删除失败');
      } catch (e) { alert('删除失败: ' + e.message); }
    }

    async function addRetry(videoPath, videoName) {
      try {
        const r = await fetch('/api/retry-queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath, videoName })
        });
        if (r.ok) showToast('已加入重发队列，打开浏览器插件即可重发');
        else showToast('加入重发队列失败');
      } catch (e) { showToast('加入重发队列失败: ' + e.message); }
    }

    function playVideo(videoPath, videoName) {
      if (!videoPath || videoPath === '未知目录') { alert('视频路径不存在'); return; }
      const fullPath = videoPath.endsWith('/') ? videoPath + videoName : videoPath + '/' + videoName;
      const video = document.getElementById('videoPlayer');
      video.src = '/api/video/file?path=' + encodeURIComponent(fullPath);
      document.getElementById('videoModal').classList.add('active');
      video.play();
    }

    function closeVideoModal(event) {
      if (event && event.target.id !== 'videoModal' && !event.target.closest('.close-btn')) return;
      const video = document.getElementById('videoPlayer');
      video.pause(); video.src = '';
      document.getElementById('videoModal').classList.remove('active');
    }

    function showToast(msg) {
      let t = document.querySelector('.toast');
      if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
      t.textContent = msg;
      t.style.opacity = '1';
      clearTimeout(t._timer);
      t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
    }

    // 分页：用 DOM API 追加渲染（textContent 赋值，天然防注入）
    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    function buildRecordItem(record) {
      const statusCls = record.status === 'failed' ? 'failed'
        : record.status === 'unknown' ? 'unknown'
        : (record.scheduled ? 'scheduled' : 'success');
      const statusText = record.status === 'failed' ? '失败'
        : record.status === 'unknown' ? '结果未知'
        : (record.scheduled ? '定时' : '已发');
      const statusSvg = {
        failed: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-2h2v2h-2zm0-4V7h2v6h-2z"/></svg>',
        unknown: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>',
        scheduled: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>',
        success: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
      }[statusCls];
      const platformSvg = record.platform === 'douyin'
        ? '<svg viewBox="0 0 24 24"><path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0015.54 3h-3.09v12.4a2.592 2.592 0 01-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6 0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 004.3 1.38V7.3s-1.88.09-3.24-1.48z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm7 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm-3.5 7c-4.42 0-8-2.69-8-6 0-.75.14-1.47.4-2.14.06-.16.13-.31.2-.46.14-.31.31-.6.5-.87.03-.04.06-.08.09-.12C7.04 6.96 9.39 5.5 12 5.5s4.96 1.46 6.31 2.91c.03.04.06.08.09.12.19.27.36.56.5.87.07.15.14.3.2.46.26.67.4 1.39.4 2.14 0 3.31-3.58 6-8 6z"/></svg>';

      const item = el('div', 'history-item');
      item.dataset.id = record.id;
      item.dataset.platform = record.platform;
      item.dataset.date = new Date(record.publishTime).toDateString();

      const badge = el('div', 'platform-badge ' + record.platform);
      badge.innerHTML = platformSvg;
      item.appendChild(badge);

      const info = el('div', 'video-info');
      const name = el('div', 'video-name', record.videoName);
      name.title = record.videoName || '';
      name.onclick = () => playVideo(record.videoPath || '', record.videoName || '');
      info.appendChild(name);

      const meta = el('div', 'video-meta');
      meta.appendChild(el('span', '', record.platform === 'douyin' ? '抖音' : '视频号'));
      meta.appendChild(el('span', '', formatDateStr(record.publishTime) + ' ' + formatTimeStr(record.publishTime)));
      info.appendChild(meta);

      if (record.topics && record.topics.length > 0) {
        const topics = el('div', 'topics');
        record.topics.forEach(t => topics.appendChild(el('span', 'topic', t)));
        info.appendChild(topics);
      }
      if (record.description) {
        const d = el('div', 'description', record.description);
        info.appendChild(d);
      }
      if (record.error) {
        const d = el('div', 'description', record.error);
        d.style.borderLeftColor = 'var(--danger)';
        d.style.color = 'var(--danger)';
        info.appendChild(d);
      }
      item.appendChild(info);

      const statusCol = el('div', 'status-col');
      statusCol.appendChild(el('span', 'publish-time-text', formatTimeStr(record.publishTime)));
      const badgeStatus = el('span', 'status-badge ' + statusCls);
      badgeStatus.innerHTML = statusSvg;
      badgeStatus.appendChild(document.createTextNode(statusText));
      statusCol.appendChild(badgeStatus);
      item.appendChild(statusCol);

      const actions = el('div', 'action-btns');
      const playBtn = el('button', 'action-btn');
      playBtn.title = '播放';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>';
      playBtn.onclick = () => playVideo(record.videoPath || '', record.videoName || '');
      actions.appendChild(playBtn);

      if (record.status === 'failed' || record.status === 'unknown') {
        const retryBtn = el('button', 'action-btn retry');
        retryBtn.title = '加入重发队列';
        retryBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="2" fill="none"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>';
        retryBtn.onclick = () => addRetry(record.videoPath || '', record.videoName || '');
        actions.appendChild(retryBtn);
      }

      const delBtn = el('button', 'action-btn danger');
      delBtn.title = '删除';
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      delBtn.onclick = () => deleteRecord(record.id);
      actions.appendChild(delBtn);
      item.appendChild(actions);

      return item;
    }

    function formatDateStr(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    function formatTimeStr(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    async function loadMoreRecords() {
      const btn = document.getElementById('load-more-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/publish-history?offset=' + shownRecords + '&limit=' + PAGE_SIZE);
        const d = await r.json();
        const records = d.history || [];
        const list = document.getElementById('historyList');
        records.forEach(record => {
          const dir = record.videoPath || '未知目录';
          let group = list.querySelector('.directory-group[data-directory="' + CSS.escape(dir) + '"]');
          if (!group) {
            group = el('div', 'directory-group');
            group.dataset.directory = dir;
            const header = el('div', 'directory-header');
            const icon = el('span', 'folder-icon');
            icon.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';
            header.appendChild(icon);
            const title = el('span', '', dir);
            title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            header.appendChild(title);
            header.appendChild(el('span', 'count', '0'));
            header.onclick = function () { toggleGroup(this); };
            group.appendChild(header);
            group.appendChild(el('div', 'history-list'));
            list.appendChild(group);
          }
          group.querySelector('.history-list').appendChild(buildRecordItem(record));
          const cnt = group.querySelector('.count');
          cnt.textContent = String(parseInt(cnt.textContent, 10) + 1);
        });
        shownRecords += records.length;
        document.getElementById('load-more-info').textContent =
          '已显示 ' + shownRecords + ' / 共 ' + totalRecords + ' 条';
        if (shownRecords >= totalRecords) {
          document.getElementById('load-more').style.display = 'none';
        }
      } catch (e) {
        showToast('加载失败: ' + e.message);
      }
      btn.disabled = false;
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVideoModal(); });
  </script>
</body>
</html>
  `);
});

// ========== API ==========

app.post('/api/publish-record', (req, res) => {
  const history = loadHistory();
  const maxId = history.reduce((m, h) => Math.max(m, h.id || 0), 0);
  const record = {
    id: maxId + 1,
    videoName: req.body.videoName || '未知视频',
    videoPath: req.body.videoPath || '',
    platform: req.body.platform || 'unknown',
    status: req.body.status || 'success',
    error: req.body.error || '',
    scheduled: req.body.scheduled || false,
    scheduledTime: req.body.scheduledTime || null,
    topics: req.body.topics || [],
    description: req.body.description || '',
    publishTime: req.body.publishTime || new Date().toISOString()
  };

  history.unshift(record);
  saveHistory(history);

  console.log('新增发布记录:', record.videoName, '-', record.platform);
  res.json({ success: true, record });
});

app.get('/api/publish-history', (req, res) => {
  const history = loadHistory();
  const limit = Math.min(parseInt(req.query.limit, 10) || PAGE_SIZE, 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json({ history: history.slice(offset, offset + limit), total: history.length });
});

app.delete('/api/publish-record/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const history = loadHistory();
  const newHistory = history.filter(h => h.id !== id);
  saveHistory(newHistory);
  console.log('删除发布记录:', id);
  res.json({ success: true });
});

app.get('/api/retry-queue', (req, res) => {
  res.json({ items: loadRetryQueue() });
});

app.post('/api/retry-queue', (req, res) => {
  const { videoPath, videoName } = req.body || {};
  if (!videoPath || !videoName) {
    return res.status(400).json({ error: '缺少 videoPath / videoName' });
  }
  const items = loadRetryQueue();
  if (!items.some(i => i.videoPath === videoPath && i.videoName === videoName)) {
    items.push({ videoPath, videoName, addedAt: new Date().toISOString() });
  }
  saveRetryQueue(items);
  res.json({ success: true, count: items.length });
});

app.delete('/api/retry-queue', (req, res) => {
  saveRetryQueue([]);
  res.json({ success: true });
});

app.get('/api/videos', (req, res) => {
  const dirPath = req.query.path;

  if (!dirPath) {
    return res.status(400).json({ error: '请提供视频目录路径' });
  }

  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: '目录不存在' });
  }

  try {
    const files = fs.readdirSync(dirPath);
    const videos = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return VIDEO_EXTENSIONS.includes(ext);
      })
      .map(file => {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          path: filePath,
          size: stats.size,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.modified - a.modified);

    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/video/file', (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: '请提供视频文件路径' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: '不支持的文件格式' });
  }

  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  let stream;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (match[1] === '' && match[2] === '')) {
      return res.status(416).json({ error: '无效的 Range 请求' });
    }
    let start, end;
    if (match[1] === '') {
      const suffixLen = parseInt(match[2], 10);
      start = fileSize - suffixLen;
      end = fileSize - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] === '' ? fileSize - 1 : parseInt(match[2], 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= fileSize || end < start) {
      return res.status(416).json({ error: '无效的 Range 请求' });
    }
    if (end >= fileSize) end = fileSize - 1;
    const chunksize = (end - start) + 1;
    stream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mime
    });
  } else {
    stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mime
    });
  }

  stream.on('error', () => { try { res.destroy(); } catch (_) {} });
  req.on('close', () => { if (!stream.destroyed) stream.destroy(); });
  stream.pipe(res);
});

app.get('/api/video/info', (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: '请提供视频文件路径' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    res.json({
      name: path.basename(filePath),
      path: filePath,
      size: stats.size,
      extension: ext,
      created: stats.birthtime,
      modified: stats.mtime
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/directories', (req, res) => {
  const basePath = req.query.path || process.env.HOME;

  try {
    const items = fs.readdirSync(basePath, { withFileTypes: true });
    const directories = items
      .filter(item => item.isDirectory() && !item.name.startsWith('.'))
      .map(item => ({
        name: item.name,
        path: path.join(basePath, item.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ directories, currentPath: basePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`视频文件服务运行在 http://localhost:${actualPort}`);
  console.log('支持的格式:', VIDEO_EXTENSIONS.join(', '));
  console.log('发布历史记录将保存到:', HISTORY_FILE);
});
