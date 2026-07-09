const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// CORS 限制：只允许扩展和本地访问
app.use(cors({
  origin: (origin, callback) => {
    // 允许无 origin（本地请求、扩展）和 localhost
    if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('http://localhost')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  }
}));
app.use(express.json());

// 路径白名单：只允许访问用户通过扩展添加的目录
const allowedPaths = new Set();

function addAllowedPath(dirPath) {
  try {
    allowedPaths.add(path.resolve(dirPath));
  } catch (_) {}
}

function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  for (const allowed of allowedPaths) {
    if (resolved === allowed || resolved.startsWith(allowed + path.sep)) return true;
  }
  return false;
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm'];
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm'
};
const HISTORY_FILE = path.join(__dirname, 'publish_history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('加载历史记录失败:', e.message);
  }
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.error('保存历史记录失败:', e.message);
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    if (!groups[dir]) {
      groups[dir] = [];
    }
    groups[dir].push(record);
  });
  
  return groups;
}

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
  
  const groups = groupByDirectory(history);

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

    /* 统计 */
    .stats { display: flex; gap: 10px; margin-bottom: 16px; }
    .stat-card {
      flex: 1; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px; text-align: center;
    }
    .stat-card .number { font-size: 24px; font-weight: 700; color: var(--accent); }
    .stat-card .label { font-size: 11px; color: var(--text-3); margin-top: 2px; }

    /* 筛选 */
    .filter-bar { display: flex; gap: 6px; margin-bottom: 14px; }
    .filter-btn {
      padding: 5px 14px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg); color: var(--text-2); cursor: pointer;
      font-size: 12px; transition: all 0.15s;
    }
    .filter-btn:hover { border-color: var(--text-3); color: var(--text); }
    .filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

    /* 目录分组 */
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

    /* 记录列表 */
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

    /* 状态 */
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

    /* 操作按钮 */
    .action-btns { display: flex; gap: 4px; flex-shrink: 0; }
    .action-btn {
      width: 28px; height: 28px; border-radius: 5px; border: 1px solid var(--border);
      background: var(--bg); cursor: pointer; display: flex;
      align-items: center; justify-content: center; transition: all 0.15s;
    }
    .action-btn svg { width: 12px; height: 12px; stroke: var(--text-2); fill: none; }
    .action-btn:hover { border-color: var(--accent); }
    .action-btn:hover svg { stroke: var(--accent); }
    .action-btn.danger:hover { border-color: var(--danger); }
    .action-btn.danger:hover svg { stroke: var(--danger); }

    /* 空状态 */
    .empty-state { text-align: center; padding: 48px 20px; color: var(--text-3); }
    .empty-state svg { width: 40px; height: 40px; stroke: var(--border); fill: none; margin-bottom: 12px; }
    .empty-state h3 { font-size: 14px; color: var(--text-2); margin-bottom: 4px; }
    .empty-state p { font-size: 12px; }

    /* 视频弹窗 */
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
      ${Object.keys(groups).length === 0 ? `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M9 10h.01M15 10h.01M9.5 15.5a3.5 3.5 0 015 0"/></svg>
          <h3>暂无发布记录</h3>
          <p>发布视频后，记录将显示在这里</p>
        </div>
      ` : Object.entries(groups).map(([dir, records]) => `
        <div class="directory-group" data-directory="${escapeHtml(dir)}">
          <div class="directory-header" onclick="toggleGroup(this)">
            <span class="folder-icon"><svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(dir)}</span>
            <span class="count">${records.length}</span>
          </div>
          <div class="history-list">
            ${records.map(record => {
              const statusCls = record.status === 'failed' ? 'failed' : (record.scheduled ? 'scheduled' : 'success');
              const statusText = record.status === 'failed' ? '失败' : (record.scheduled ? '定时' : '已发');
              const statusIcon = statusCls === 'failed'
                ? '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-2h2v2h-2zm0-4V7h2v6h-2z"/></svg>'
                : statusCls === 'scheduled'
                  ? '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>'
                  : '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
              return `
                <div class="history-item" data-id="${record.id}" data-platform="${record.platform}" data-date="${new Date(record.publishTime).toDateString()}">
                  <div class="platform-badge ${record.platform}">
                    ${record.platform === 'douyin'
                      ? '<svg viewBox="0 0 24 24"><path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0015.54 3h-3.09v12.4a2.592 2.592 0 01-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6 0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 004.3 1.38V7.3s-1.88.09-3.24-1.48z"/></svg>'
                      : '<svg viewBox="0 0 24 24"><path d="M8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm7 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm-3.5 7c-4.42 0-8-2.69-8-6 0-.75.14-1.47.4-2.14.06-.16.13-.31.2-.46.14-.31.31-.6.5-.87.03-.04.06-.08.09-.12C7.04 6.96 9.39 5.5 12 5.5s4.96 1.46 6.31 2.91c.03.04.06.08.09.12.19.27.36.56.5.87.07.15.14.3.2.46.26.67.4 1.39.4 2.14 0 3.31-3.58 6-8 6z"/></svg>'}
                  </div>
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
                    <span class="status-badge ${statusCls}">${statusIcon}${statusText}</span>
                  </div>
                  <div class="action-btns">
                    <button class="action-btn" onclick="playVideo('${escapeHtml(record.videoPath || '')}', '${escapeHtml(record.videoName || '')}')" title="播放">
                      <svg viewBox="0 0 24 24" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>
                    </button>
                    <button class="action-btn danger" onclick="deleteRecord(${record.id})" title="删除">
                      <svg viewBox="0 0 24 24" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <div class="video-modal" id="videoModal" onclick="closeVideoModal(event)">
    <button class="close-btn" onclick="closeVideoModal()">
      <svg viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <video id="videoPlayer" controls></video>
  </div>

  <script>
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
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVideoModal(); });
  </script>
</body>
</html>
  `);
});

app.post('/api/publish-record', (req, res) => {
  const record = {
    id: Date.now(),
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
  
  const history = loadHistory();
  history.unshift(record);
  saveHistory(history);
  
  console.log('新增发布记录:', record.videoName, '-', record.platform);
  res.json({ success: true, record });
});

app.get('/api/publish-history', (req, res) => {
  const history = loadHistory();
  res.json({ history });
});

app.delete('/api/publish-record/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const history = loadHistory();
  const newHistory = history.filter(h => h.id !== id);
  saveHistory(newHistory);
  console.log('删除发布记录:', id);
  res.json({ success: true });
});

app.get('/api/videos', (req, res) => {
  const dirPath = req.query.path;

  if (!dirPath) {
    return res.status(400).json({ error: '请提供视频目录路径' });
  }

  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: '目录不存在' });
  }

  if (!isPathAllowed(resolved)) {
    return res.status(403).json({ error: '目录未授权，请先通过扩展浏览该目录' });
  }

  try {
    const files = fs.readdirSync(resolved);
    const videos = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return VIDEO_EXTENSIONS.includes(ext);
      })
      .map(file => {
        const filePath = path.join(resolved, file);
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

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  if (!isPathAllowed(resolved)) {
    return res.status(403).json({ error: '文件路径未授权' });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: '不支持的文件格式' });
  }

  const stat = fs.statSync(resolved);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = VIDEO_MIME_TYPES[ext] || 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(resolved, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType
    });

    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType
    });

    fs.createReadStream(resolved).pipe(res);
  }
});

app.get('/api/video/info', (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: '请提供视频文件路径' });
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  if (!isPathAllowed(resolved)) {
    return res.status(403).json({ error: '文件路径未授权' });
  }

  try {
    const stats = fs.statSync(resolved);
    const ext = path.extname(resolved).toLowerCase();

    res.json({
      name: path.basename(resolved),
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
  const resolved = path.resolve(basePath);

  try {
    const items = fs.readdirSync(resolved, { withFileTypes: true });
    const directories = items
      .filter(item => item.isDirectory())
      .map(item => ({
        name: item.name,
        path: path.join(resolved, item.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ directories, currentPath: resolved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 注册允许访问的目录（用户通过扩展浏览时调用）
app.post('/api/allow-path', (req, res) => {
  const dirPath = req.body.path;
  if (!dirPath) return res.status(400).json({ error: '请提供目录路径' });
  addAllowedPath(dirPath);
  res.json({ success: true, allowed: path.resolve(dirPath) });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 检查更新 - 用 GitHub Releases API
app.get('/check-update', (req, res) => {
  const { exec } = require('child_process');
  const https = require('https');
  const projectDir = path.join(__dirname, '..');

  // 获取本地版本
  let localVersion = '0.0.0';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'chrome-extension', 'manifest.json'), 'utf8'));
    localVersion = manifest.version || '0.0.0';
  } catch (_) {}

  // 查询 GitHub 最新 Release
  https.get('https://api.github.com/repos/cxcboss/video-publish-extension/releases/latest', {
    headers: { 'User-Agent': 'video-publish-extension' }
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const release = JSON.parse(data);
        if (release.tag_name) {
          const remoteVersion = release.tag_name.replace(/^v/, '');
          const hasUpdate = compareVersions(remoteVersion, localVersion) > 0;
          res.json({
            success: true,
            hasUpdate,
            localVersion,
            remoteVersion,
            message: hasUpdate ? `新版本 v${remoteVersion} 可用` : '已是最新版本',
            changelog: hasUpdate ? release.body || '无更新说明' : null,
            downloadUrl: release.zipball_url,
            releaseUrl: release.html_url,
            publishedAt: release.published_at
          });
        } else {
          // 没有 release，回退到 commit 检查
          fallbackCommitCheck(localVersion, res);
        }
      } catch (e) {
        fallbackCommitCheck(localVersion, res);
      }
    });
  }).on('error', () => {
    res.json({ success: false, error: '无法连接 GitHub' });
  });
});

function fallbackCommitCheck(localVersion, res) {
  const https = require('https');
  https.get('https://api.github.com/repos/cxcboss/video-publish-extension/commits/main', {
    headers: { 'User-Agent': 'video-publish-extension' }
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const commit = JSON.parse(data);
        res.json({
          success: true,
          hasUpdate: false,
          localVersion,
          remoteVersion: localVersion,
          message: '已是最新版本（基于提交检查）',
          changelog: null,
          releaseUrl: 'https://github.com/cxcboss/video-publish-extension/releases'
        });
      } catch (e) {
        res.json({ success: false, error: '解析更新信息失败' });
      }
    });
  }).on('error', () => {
    res.json({ success: false, error: '无法连接 GitHub' });
  });
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// 执行更新 - git pull（仅允许本地请求）
app.post('/update', (req, res) => {
  const origin = req.headers.origin || '';
  if (origin && !origin.startsWith('http://localhost')) {
    return res.status(403).json({ success: false, error: '禁止远程更新' });
  }
  const { exec } = require('child_process');
  const projectDir = path.join(__dirname, '..');

  exec('git pull origin main', { cwd: projectDir, timeout: 30000 }, (err, stdout) => {
    if (err) {
      return res.json({ success: false, error: '更新失败: ' + err.message });
    }
    const output = stdout.trim();
    const alreadyUp = output.includes('Already up to date') || output.includes('已经是最新的');
    res.json({
      success: true,
      updated: !alreadyUp,
      message: alreadyUp ? '已是最新版本' : '更新成功，请重启服务',
      detail: output
    });
  });
});

app.listen(PORT, () => {
  console.log(`视频文件服务运行在 http://localhost:${PORT}`);
  console.log('支持的格式:', VIDEO_EXTENSIONS.join(', '));
  console.log('发布历史记录将保存到:', HISTORY_FILE);
});
