const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm'];
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
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    
    .header {
      text-align: center;
      color: white;
      margin-bottom: 30px;
    }
    .header h1 {
      font-size: 2.5rem;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .header p { opacity: 0.9; font-size: 1.1rem; }
    
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      border-radius: 16px;
      padding: 25px;
      text-align: center;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
      transition: transform 0.3s ease;
    }
    .stat-card:hover { transform: translateY(-5px); }
    .stat-card .number {
      font-size: 3rem;
      font-weight: bold;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .stat-card .label { color: #666; margin-top: 5px; font-size: 1rem; }
    
    .history-section {
      background: white;
      border-radius: 20px;
      padding: 30px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    .section-title {
      font-size: 1.5rem;
      color: #333;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-title::before {
      content: '';
      width: 4px;
      height: 24px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 2px;
    }
    
    .filter-bar {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .filter-btn {
      padding: 8px 20px;
      border: none;
      border-radius: 20px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 0.3s ease;
      background: #f0f0f0;
      color: #666;
    }
    .filter-btn:hover { background: #e0e0e0; }
    .filter-btn.active {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
    }
    
    .directory-group {
      margin-bottom: 25px;
      border: 1px solid #eee;
      border-radius: 12px;
      overflow: hidden;
    }
    .directory-header {
      background: #f8f9fa;
      padding: 12px 20px;
      font-weight: 600;
      color: #555;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
    }
    .directory-header:hover { background: #f0f0f0; }
    .directory-header .folder-icon { font-size: 1.2rem; }
    .directory-header .count {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.85rem;
    }
    
    .history-list { display: flex; flex-direction: column; }
    .history-item {
      background: #fff;
      padding: 15px 20px;
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      gap: 15px;
      align-items: center;
      border-bottom: 1px solid #f0f0f0;
      transition: all 0.3s ease;
    }
    .history-item:hover {
      background: #fafafa;
    }
    .history-item:last-child { border-bottom: none; }
    
    .platform-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
    }
    .platform-icon.douyin { background: linear-gradient(135deg, #000000, #333333); }
    .platform-icon.weixin { background: linear-gradient(135deg, #07c160, #09bb07); }
    
    .video-info h3 {
      color: #333;
      margin-bottom: 5px;
      font-size: 1rem;
      cursor: pointer;
    }
    .video-info h3:hover { color: #667eea; }
    .video-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: #888;
      font-size: 0.85rem;
    }
    .video-meta span { display: flex; align-items: center; gap: 4px; }
    
    .topics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .topic {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      padding: 3px 10px;
      border-radius: 15px;
      font-size: 0.8rem;
    }
    
    .publish-time {
      text-align: right;
      color: #666;
      min-width: 100px;
    }
    .publish-time .date { font-size: 0.95rem; font-weight: 600; color: #333; }
    .publish-time .time { font-size: 0.85rem; }
    .publish-time .status {
      margin-top: 5px;
      padding: 3px 10px;
      border-radius: 15px;
      font-size: 0.8rem;
      display: inline-block;
    }
    .publish-time .status.success { background: #e8f5e9; color: #2e7d32; }
    .publish-time .status.scheduled { background: #fff3e0; color: #ef6c00; }
    
    .delete-btn {
      background: #ff5252;
      color: white;
      border: none;
      padding: 8px 15px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.3s ease;
    }
    .delete-btn:hover { background: #ff1744; }
    
    .play-btn {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      border: none;
      padding: 8px 15px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.3s ease;
      margin-right: 8px;
    }
    .play-btn:hover { opacity: 0.9; }
    
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #999;
    }
    .empty-state .icon { font-size: 4rem; margin-bottom: 20px; }
    .empty-state h3 { color: #666; margin-bottom: 10px; }
    
    .video-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .video-modal.active { display: flex; }
    .video-modal video {
      max-width: 90%;
      max-height: 90%;
      border-radius: 10px;
    }
    .video-modal .close-btn {
      position: absolute;
      top: 20px;
      right: 30px;
      color: white;
      font-size: 2rem;
      cursor: pointer;
    }
    
    .description {
      margin-top: 8px;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 6px;
      font-size: 0.85rem;
      color: #555;
      border-left: 3px solid #667eea;
    }
    
    @media (max-width: 768px) {
      .history-item {
        grid-template-columns: 1fr;
        text-align: center;
        gap: 10px;
      }
      .platform-icon { margin: 0 auto; }
      .publish-time { text-align: center; }
      .video-meta { justify-content: center; }
      .topics { justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎬 视频发布历史记录</h1>
      <p>记录每一次精彩的发布时刻</p>
    </div>
    
    <div class="stats">
      <div class="stat-card">
        <div class="number">${stats.total}</div>
        <div class="label">总发布数</div>
      </div>
      <div class="stat-card">
        <div class="number">${stats.douyin}</div>
        <div class="label">抖音发布</div>
      </div>
      <div class="stat-card">
        <div class="number">${stats.weixin}</div>
        <div class="label">视频号发布</div>
      </div>
      <div class="stat-card">
        <div class="number">${stats.today}</div>
        <div class="label">今日发布</div>
      </div>
    </div>
    
    <div class="history-section">
      <div class="section-title">发布记录</div>
      
      <div class="filter-bar">
        <button class="filter-btn active" onclick="filterRecords('all')">全部</button>
        <button class="filter-btn" onclick="filterRecords('douyin')">抖音</button>
        <button class="filter-btn" onclick="filterRecords('weixin')">视频号</button>
        <button class="filter-btn" onclick="filterRecords('today')">今日</button>
      </div>
      
      <div id="historyList">
        ${Object.keys(groups).length === 0 ? `
          <div class="empty-state">
            <div class="icon">📭</div>
            <h3>暂无发布记录</h3>
            <p>发布视频后，记录将显示在这里</p>
          </div>
        ` : Object.entries(groups).map(([dir, records]) => `
          <div class="directory-group" data-directory="${escapeHtml(dir)}">
            <div class="directory-header" onclick="toggleGroup(this)">
              <span class="folder-icon">📁</span>
              <span>${escapeHtml(dir)}</span>
              <span class="count">${records.length} 个视频</span>
            </div>
            <div class="history-list">
              ${records.map(record => `
                <div class="history-item" data-id="${record.id}" data-platform="${record.platform}" data-date="${new Date(record.publishTime).toDateString()}">
                  <div class="platform-icon ${record.platform}">
                    ${record.platform === 'douyin' ? '🎵' : '📹'}
                  </div>
                  <div class="video-info">
                    <h3 onclick="playVideo('${escapeHtml(record.videoPath || '')}', '${escapeHtml(record.videoName || '')}')">${escapeHtml(record.videoName)}</h3>
                    <div class="video-meta">
                      <span>📱 ${record.platform === 'douyin' ? '抖音' : '视频号'}</span>
                      <span>📅 ${formatDate(record.publishTime)}</span>
                      <span>⏰ ${formatTime(record.publishTime)}</span>
                    </div>
                    ${record.topics && record.topics.length > 0 ? `
                      <div class="topics">
                        ${record.topics.map(t => `<span class="topic">${escapeHtml(t)}</span>`).join('')}
                      </div>
                    ` : ''}
                    ${record.description ? `
                      <div class="description">${escapeHtml(record.description)}</div>
                    ` : ''}
                  </div>
                  <div class="publish-time">
                    <div class="date">${formatDate(record.publishTime)}</div>
                    <div class="time">${formatTime(record.publishTime)}</div>
                    <span class="status ${record.scheduled ? 'scheduled' : 'success'}">
                      ${record.scheduled ? '⏰ 定时发布' : '✅ 已发布'}
                    </span>
                  </div>
                  <div>
                    <button class="play-btn" onclick="playVideo('${escapeHtml(record.videoPath || '')}', '${escapeHtml(record.videoName || '')}')">▶ 播放</button>
                    <button class="delete-btn" onclick="deleteRecord(${record.id})">删除</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
  
  <div class="video-modal" id="videoModal" onclick="closeVideoModal(event)">
    <span class="close-btn" onclick="closeVideoModal()">&times;</span>
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
          
          let visible = false;
          if (filter === 'all') {
            visible = true;
          } else if (filter === 'today') {
            visible = date === today;
          } else {
            visible = platform === filter;
          }
          
          item.style.display = visible ? 'grid' : 'none';
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
        const response = await fetch('/api/publish-record/' + id, {
          method: 'DELETE'
        });
        
        if (response.ok) {
          location.reload();
        } else {
          alert('删除失败');
        }
      } catch (e) {
        alert('删除失败: ' + e.message);
      }
    }
    
    function playVideo(videoPath, videoName) {
      if (!videoPath || videoPath === '未知目录') {
        alert('视频路径不存在');
        return;
      }
      
      const fullPath = videoPath.endsWith('/') 
        ? videoPath + videoName 
        : videoPath + '/' + videoName;
      
      const videoUrl = '/api/video/file?path=' + encodeURIComponent(fullPath);
      
      const modal = document.getElementById('videoModal');
      const video = document.getElementById('videoPlayer');
      
      video.src = videoUrl;
      modal.classList.add('active');
      video.play();
    }
    
    function closeVideoModal(event) {
      if (event && event.target.id !== 'videoModal') return;
      
      const modal = document.getElementById('videoModal');
      const video = document.getElementById('videoPlayer');
      
      video.pause();
      video.src = '';
      modal.classList.remove('active');
    }
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeVideoModal();
      }
    });
  </script>
</body>
</html>
  `);
});

app.post('/api/publish-record', (req, res) => {
  const record = {
    id: Date.now(),
    ...req.body,
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

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4'
    });

    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    });

    fs.createReadStream(filePath).pipe(res);
  }
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
      .filter(item => item.isDirectory())
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

// 执行更新 - git pull
app.post('/update', (req, res) => {
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
