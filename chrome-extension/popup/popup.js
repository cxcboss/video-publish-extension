class PopupController {
  constructor() {
    this.selectedPlatform = null;
    this.selectedVideos = [];
    this.videoPath = '';
    this.isPublishing = false;
    this.videos = [];
    this.loadTimeout = null;
    this.draggedItem = null;
    this.progressSteps = [];
    this.currentStep = -1;
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadSettings();
    this.checkServerStatus();
    this.pollPublishState();
    this.listenProgress();
  }

  bindEvents() {
    document.getElementById('douyin-btn').addEventListener('click', () => this.selectPlatform('douyin'));
    document.getElementById('weixin-btn').addEventListener('click', () => this.selectPlatform('weixin'));
    document.getElementById('browse-btn').addEventListener('click', () => this.browseFolder());
    document.getElementById('publish-btn').addEventListener('click', () => this.togglePublish());

    document.getElementById('scheduled-publish').addEventListener('change', (e) => {
      document.getElementById('schedule-time-wrap').classList.toggle('hidden', !e.target.checked);
      this.updateScheduleHint();
    });

    document.getElementById('auto-generate').addEventListener('change', (e) => {
      document.getElementById('video-content-wrap').classList.toggle('hidden', !e.target.checked);
    });

    document.getElementById('ai-toggle').addEventListener('click', () => {
      const body = document.getElementById('ai-body');
      const arrow = document.getElementById('ai-arrow');
      body.classList.toggle('hidden');
      arrow.classList.toggle('open');
    });

    document.getElementById('test-ai-btn').addEventListener('click', () => this.testAI());
    document.getElementById('update-btn').addEventListener('click', () => this.checkUpdate());

    const pathInput = document.getElementById('video-path');
    pathInput.addEventListener('input', (e) => {
      this.videoPath = e.target.value;
      if (this.loadTimeout) clearTimeout(this.loadTimeout);
      this.loadTimeout = setTimeout(() => {
        if (e.target.value.trim()) this.loadVideos(e.target.value.trim());
      }, 600);
    });
    pathInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        if (this.loadTimeout) clearTimeout(this.loadTimeout);
        this.loadVideos(e.target.value);
      }
    });
  }

  updateScheduleHint() {
    const hint = document.getElementById('schedule-hint');
    const on = document.getElementById('scheduled-publish').checked;
    hint.textContent = on
      ? (this.selectedPlatform === 'douyin' ? '抖音：调用平台原生定时发布' : '视频号：首个视频定时，后续延后40-88分钟')
      : '抖音：调用平台原生定时发布';
  }

  async checkServerStatus() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    try {
      const r = await fetch('http://localhost:3000/health');
      if (r.ok) { dot.className = 'status-dot on'; text.textContent = '服务已连接'; return; }
    } catch (_) {}
    dot.className = 'status-dot off';
    text.textContent = '服务未启动';
  }

  async loadSettings() {
    try {
      const r = await chrome.storage.local.get([
        'videoPath', 'aiProvider', 'aiKey', 'aiModel',
        'autoGenerate', 'videoContent', 'scheduledPublish', 'scheduleTime'
      ]);
      if (r.videoPath) {
        document.getElementById('video-path').value = r.videoPath;
        this.videoPath = r.videoPath;
        this.loadVideos(r.videoPath);
      }
      if (r.aiProvider) document.getElementById('ai-provider').value = r.aiProvider;
      if (r.aiKey) document.getElementById('ai-key').value = r.aiKey;
      if (r.aiModel) document.getElementById('ai-model').value = r.aiModel;
      if (r.autoGenerate) {
        document.getElementById('auto-generate').checked = true;
        document.getElementById('video-content-wrap').classList.remove('hidden');
      }
      if (r.videoContent) document.getElementById('video-content').value = r.videoContent;
      if (r.scheduledPublish) {
        document.getElementById('scheduled-publish').checked = true;
        document.getElementById('schedule-time-wrap').classList.remove('hidden');
      }
      if (r.scheduleTime) document.getElementById('schedule-time').value = r.scheduleTime;
      else this.setDefaultScheduleTime();
    } catch (e) { console.error(e); }
  }

  setDefaultScheduleTime() {
    const n = new Date(); n.setMinutes(n.getMinutes() + 10);
    const p = v => String(v).padStart(2, '0');
    document.getElementById('schedule-time').value =
      `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}`;
  }

  async saveSettings() {
    try {
      await chrome.storage.local.set({
        videoPath: this.videoPath,
        aiProvider: document.getElementById('ai-provider').value,
        aiKey: document.getElementById('ai-key').value,
        aiModel: document.getElementById('ai-model').value,
        autoGenerate: document.getElementById('auto-generate').checked,
        videoContent: document.getElementById('video-content').value,
        scheduledPublish: document.getElementById('scheduled-publish').checked,
        scheduleTime: document.getElementById('schedule-time').value
      });
    } catch (e) { console.error(e); }
  }

  selectPlatform(p) {
    this.selectedPlatform = p;
    document.querySelectorAll('.platform-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`${p}-btn`).classList.add('active');
    this.updateStatus(`已选择${p === 'douyin' ? '抖音' : '视频号'}`);
    this.updateScheduleHint();
  }

  async loadVideos(path) {
    if (!path?.trim()) { this.updateStatus('请输入目录路径'); return; }
    path = path.trim();
    this.videoPath = path;
    this.updateStatus('加载中...');
    try {
      const r = await fetch(`http://localhost:3000/api/videos?path=${encodeURIComponent(path)}`);
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.status); }
      const d = await r.json();
      if (d.videos?.length > 0) {
        this.videos = d.videos;
        this.selectedVideos = [...d.videos];
        this.renderVideoList(d.videos);
        this.renderQueue();
        this.updateStatus(`已加载 ${d.videos.length} 个视频`);
      } else {
        this.updateStatus(d.error || '未找到视频');
        this.clearList();
      }
    } catch (e) {
      this.updateStatus(e.message.includes('Failed') ? '服务未连接' : `错误: ${e.message}`);
      this.clearList();
    }
  }

  clearList() {
    document.getElementById('video-list').innerHTML = '';
    this.videos = [];
    this.selectedVideos = [];
    this.renderQueue();
  }

  // ===== 浏览文件夹 =====
  async browseFolder() {
    if (window.showDirectoryPicker) {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        const dirName = dirHandle.name;
        const videos = [];
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'file') {
            const ext = entry.name.split('.').pop().toLowerCase();
            if (['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'webm'].includes(ext)) {
              const file = await entry.getFile();
              videos.push({ name: entry.name, size: file.size, path: '' });
            }
          }
        }
        if (videos.length > 0) {
          this.videos = videos;
          this.selectedVideos = [...videos];
          this.videoPath = dirName;
          document.getElementById('video-path').value = dirName;
          this.renderVideoList(videos);
          this.renderQueue();
          this.updateStatus(`已加载 ${videos.length} 个视频`);
        } else {
          this.updateStatus('该目录下没有视频文件');
        }
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    this.showDirBrowser();
  }

  showDirBrowser() {
    if (document.getElementById('dir-mask')) return;
    const cur = document.getElementById('video-path').value.trim() || '';
    const mask = document.createElement('div');
    mask.id = 'dir-mask';
    mask.className = 'dir-modal-mask';
    mask.innerHTML = `
      <div class="dir-modal">
        <div class="dir-modal-head">
          <span>选择目录</span>
          <button id="dir-close">✕</button>
        </div>
        <div class="dir-modal-path" id="dir-path"></div>
        <div class="dir-modal-list" id="dir-list"></div>
        <div class="dir-modal-foot">
          <button id="dir-ok">选择此目录</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    mask.querySelector('#dir-close').onclick = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#dir-ok').onclick = () => {
      const p = mask.dataset.path || '';
      if (p) {
        document.getElementById('video-path').value = p;
        this.videoPath = p;
        this.loadVideos(p);
      }
      mask.remove();
    };
    this.loadDir(mask, cur || '/');
  }

  async loadDir(mask, dir) {
    const list = mask.querySelector('#dir-list');
    const pathEl = mask.querySelector('#dir-path');
    pathEl.textContent = dir;
    mask.dataset.path = dir;
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-3)">加载中...</div>';
    try {
      const r = await fetch(`http://localhost:3000/api/directories?path=${encodeURIComponent(dir)}`);
      const d = await r.json();
      const dirs = d.directories || [];
      let html = '';
      if (dir !== '/') {
        const parent = dir.split('/').slice(0, -1).join('/') || '/';
        html += `<div class="dir-item up" data-path="${parent}"><span class="arrow">▴</span>返回上级</div>`;
      }
      html += dirs.map(dd => `
        <div class="dir-item" data-path="${dd.path}"><span class="arrow">▸</span>${dd.name}</div>
      `).join('');
      list.innerHTML = html || '<div style="padding:16px;text-align:center;color:var(--text-3)">无子目录</div>';
      list.querySelectorAll('.dir-item').forEach(el => {
        el.addEventListener('click', () => this.loadDir(mask, el.dataset.path));
      });
    } catch (_) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--dot-off)">加载失败</div>';
    }

  renderVideoList(videos) {
    const c = document.getElementById('video-list');
    c.innerHTML = videos.map((v, i) => `
      <div class="video-item" data-index="${i}" draggable="true">
        <input type="checkbox" id="v-${i}" checked>
        <span class="idx">${i+1}</span>
        <span class="name" title="${v.name}">${v.name}</span>
        <span class="size">${this.fmtSize(v.size)}</span>
      </div>
    `).join('');

    c.querySelectorAll('.video-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          item.querySelector('input').checked = !item.querySelector('input').checked;
        }
        this.syncSelected();
      });
      item.querySelector('input').addEventListener('change', () => this.syncSelected());

      item.addEventListener('dragstart', () => { this.draggedItem = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.draggedItem = null;
        c.querySelectorAll('.video-item').forEach(i => i.classList.remove('drag-over'));
      });
      item.addEventListener('dragover', (e) => { e.preventDefault(); return false; });
      item.addEventListener('dragenter', () => { if (item !== this.draggedItem) item.classList.add('drag-over'); });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        e.stopPropagation();
        if (item !== this.draggedItem) {
          const vids = [...this.selectedVideos];
          const from = parseInt(this.draggedItem.dataset.index);
          const to = parseInt(item.dataset.index);
          const [m] = vids.splice(from, 1);
          vids.splice(to, 0, m);
          this.selectedVideos = vids;
          this.renderVideoList(vids);
          this.renderQueue();
        }
        item.classList.remove('drag-over');
        return false;
      });
    });
  }

  syncSelected() {
    const checked = document.querySelectorAll('#video-list input:checked');
    this.selectedVideos = Array.from(checked).map(cb => {
      const i = parseInt(cb.id.replace('v-', ''));
      return this.videos[i];
    }).filter(Boolean);
    this.renderQueue();
  }

  renderQueue() {
    const c = document.getElementById('publish-queue');
    const n = document.getElementById('queue-count');
    n.textContent = this.selectedVideos.length;
    if (!this.selectedVideos.length) {
      c.innerHTML = '<div style="color:#333;font-size:10px;text-align:center;padding:6px">无视频</div>';
      return;
    }
    c.innerHTML = this.selectedVideos.map((v, i) => `
      <div class="queue-item"><span class="dot pending"></span>${i+1}. ${v.name}</div>
    `).join('');
  }

  fmtSize(b) {
    if (!b) return '0B';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b/1024).toFixed(1) + 'K';
    if (b < 1073741824) return (b/1048576).toFixed(1) + 'M';
    return (b/1073741824).toFixed(1) + 'G';
  }

  // ===== 发布按钮（合并 start/stop） =====
  togglePublish() {
    if (this.isPublishing) {
      this.stopPublish();
    } else {
      this.startPublish();
    }
  }

  setPublishButtonState(running) {
    const btn = document.getElementById('publish-btn');
    this.isPublishing = running;
    if (running) {
      btn.textContent = '停止';
      btn.classList.add('running');
    } else {
      btn.textContent = '发布';
      btn.classList.remove('running');
    }
  }

  // ===== 进度条 =====
  showProgress(steps, current) {
    const section = document.getElementById('progress-section');
    const fill = document.getElementById('progress-fill');
    const stepEl = document.getElementById('progress-step');
    const detailEl = document.getElementById('progress-detail');
    section.classList.remove('hidden');
    const pct = steps.length > 0 ? Math.round(((current + 1) / steps.length) * 100) : 0;
    fill.style.width = pct + '%';
    stepEl.textContent = steps[current] || '准备中...';
    detailEl.textContent = `${current + 1} / ${steps.length}`;
  }

  updateProgressText(text) {
    document.getElementById('progress-step').textContent = text;
  }

  hideProgress() {
    document.getElementById('progress-section').classList.add('hidden');
    document.getElementById('progress-fill').style.width = '0%';
  }

  updateQueueStatus(index, status) {
    const items = document.querySelectorAll('.queue-item .dot');
    if (items[index]) {
      items[index].className = 'dot ' + status;
    }
  }

  listenProgress() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'progressUpdate') {
        this.handleProgressUpdate(msg);
      }
    });
  }

  handleProgressUpdate(msg) {
    const { step, detail, current, total, videoIndex, status } = msg;

    if (step) {
      const section = document.getElementById('progress-section');
      section.classList.remove('hidden');
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('progress-step').textContent = step;
      document.getElementById('progress-detail').textContent = detail || `${current} / ${total}`;
    }

    if (videoIndex !== undefined && status) {
      this.updateQueueStatus(videoIndex, status);
    }

    if (msg.done) {
      setTimeout(() => {
        this.setPublishButtonState(false);
        this.hideProgress();
        this.updateStatus('全部完成');
      }, 1500);
    }
  }

  // ===== 发布流程 =====
  async startPublish() {
    if (!this.selectedPlatform) { this.updateStatus('请选择平台'); return; }
    if (!this.selectedVideos.length) { this.updateStatus('请选择视频'); return; }

    const autoGen = document.getElementById('auto-generate').checked;
    if (autoGen) {
      if (!document.getElementById('ai-provider').value) { this.updateStatus('请选择 AI Provider'); return; }
      if (!document.getElementById('ai-key').value.trim()) { this.updateStatus('请填写 API Key'); return; }
      if (!document.getElementById('video-content').value.trim()) { this.updateStatus('请填写视频内容'); return; }
    }

    await this.saveSettings();
    this.setPublishButtonState(true);

    const settings = {
      autoGenerate: autoGen,
      aiProvider: document.getElementById('ai-provider').value,
      aiKey: document.getElementById('ai-key').value.trim(),
      aiModel: document.getElementById('ai-model').value.trim(),
      videoContent: document.getElementById('video-content').value.trim(),
      scheduledPublish: document.getElementById('scheduled-publish').checked,
      scheduleTime: document.getElementById('schedule-time').value
    };

    // 构建进度步骤
    const steps = [];
    for (let i = 0; i < this.selectedVideos.length; i++) {
      steps.push(`[${i+1}/${this.selectedVideos.length}] 准备: ${this.selectedVideos[i].name}`);
      if (autoGen) steps.push(`[${i+1}/${this.selectedVideos.length}] AI 生成文案...`);
      steps.push(`[${i+1}/${this.selectedVideos.length}] 上传视频...`);
      steps.push(`[${i+1}/${this.selectedVideos.length}] 填写信息...`);
      steps.push(`[${i+1}/${this.selectedVideos.length}] 发布中...`);
    }
    this.showProgress(steps, 0);

    // 重置队列状态
    this.renderQueue();

    try {
      const r = await chrome.runtime.sendMessage({
        action: 'startPublishFlow',
        videos: this.selectedVideos,
        settings, videoPath: this.videoPath,
        platform: this.selectedPlatform
      });
      if (!r?.success) throw new Error('启动失败');
    } catch (e) {
      this.updateStatus(`失败: ${e.message}`);
      this.setPublishButtonState(false);
      this.hideProgress();
    }
  }

  async stopPublish() {
    await chrome.runtime.sendMessage({ action: 'stopPublish' });
    this.setPublishButtonState(false);
    this.hideProgress();
    this.updateStatus('已停止');
    // 重置队列 dot
    document.querySelectorAll('.queue-item .dot').forEach(d => d.className = 'dot pending');
  }

  async pollPublishState() {
    setInterval(async () => {
      try {
        const s = await chrome.runtime.sendMessage({ action: 'getPublishState' });
        if (s?.isPublishing && !this.isPublishing) {
          this.setPublishButtonState(true);
        } else if (!s?.isPublishing && this.isPublishing) {
          this.setPublishButtonState(false);
          this.hideProgress();
        }
      } catch (_) {}
    }, 2000);
  }

  updateStatus(t) {
    document.getElementById('status-text').textContent = t;
  }

  async testAI() {
    const provider = document.getElementById('ai-provider').value;
    const apiKey = document.getElementById('ai-key').value.trim();
    const model = document.getElementById('ai-model').value.trim();
    const resultEl = document.getElementById('test-result');
    const btn = document.getElementById('test-ai-btn');

    if (!provider) { resultEl.className = 'test-result fail'; resultEl.textContent = '请先选择 Provider'; resultEl.classList.remove('hidden'); return; }
    if (!apiKey) { resultEl.className = 'test-result fail'; resultEl.textContent = '请先填写 API Key'; resultEl.classList.remove('hidden'); return; }

    btn.disabled = true;
    btn.textContent = '测试中...';
    resultEl.className = 'test-result';
    resultEl.textContent = '';
    resultEl.classList.remove('hidden');

    try {
      const r = await chrome.runtime.sendMessage({ action: 'testAI', provider, apiKey, model });
      if (r?.success) {
        resultEl.className = 'test-result ok';
        resultEl.textContent = `连接成功! 回复: ${r.reply?.substring(0, 100) || '(空)'}`;
      } else {
        resultEl.className = 'test-result fail';
        resultEl.textContent = `失败: ${r?.error || '未知错误'}`;
      }
    } catch (e) {
      resultEl.className = 'test-result fail';
      resultEl.textContent = `错误: ${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  }

  async checkUpdate() {
    const btn = document.getElementById('update-btn');
    const statusEl = document.getElementById('status-text');
    btn.disabled = true;
    btn.textContent = '...';
    statusEl.textContent = '检查更新中...';

    try {
      const check = await fetch('http://localhost:3000/check-update');
      const info = await check.json();

      if (!info.success) {
        btn.textContent = '!';
        statusEl.textContent = info.error || '检查失败';
        setTimeout(() => { btn.textContent = '↻'; }, 3000);
        return;
      }

      if (!info.hasUpdate) {
        btn.textContent = '✓';
        statusEl.textContent = `v${info.localVersion} 已是最新`;
        setTimeout(() => { btn.textContent = '↻'; }, 2000);
        return;
      }

      // 有更新，显示更新日志弹窗
      this.showUpdateModal(info);
      btn.classList.add('has-update');
      btn.textContent = '✓';
      statusEl.textContent = `发现新版本 v${info.remoteVersion}`;
    } catch (e) {
      btn.textContent = '!';
      statusEl.textContent = '服务未连接';
      setTimeout(() => { btn.textContent = '↻'; }, 3000);
    } finally {
      btn.disabled = false;
    }
  }

  showUpdateModal(info) {
    if (document.getElementById('update-mask')) return;
    const mask = document.createElement('div');
    mask.id = 'update-mask';
    mask.className = 'dir-modal-mask';
    const changelog = (info.changelog || '无更新说明')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    mask.innerHTML = `
      <div class="dir-modal" style="max-height:70vh">
        <div class="dir-modal-head">
          <span>发现新版本 v${info.remoteVersion}</span>
          <button id="update-close">✕</button>
        </div>
        <div style="padding:10px 14px;overflow-y:auto;max-height:40vh;font-size:12px;color:var(--text-2);line-height:1.6">
          <div style="font-size:11px;color:var(--text-3);margin-bottom:8px">
            当前版本: v${info.localVersion} → v${info.remoteVersion}
            ${info.publishedAt ? ' | ' + new Date(info.publishedAt).toLocaleDateString('zh-CN') : ''}
          </div>
          <div style="background:var(--bg-input);padding:8px 10px;border-radius:6px;border:1px solid var(--border)">
            ${changelog}
          </div>
        </div>
        <div class="dir-modal-foot" style="gap:8px">
          <button id="update-later" style="background:var(--bg-input);color:var(--text-2)">稍后</button>
          <button id="update-download" style="background:var(--accent);color:var(--accent-text)">下载更新</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    mask.querySelector('#update-close').onclick = () => mask.remove();
    mask.querySelector('#update-later').onclick = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#update-download').onclick = () => {
      window.open(info.releaseUrl || 'https://github.com/cxcboss/video-publish-extension/releases', '_blank');
      mask.remove();
    };
  }
}

document.addEventListener('DOMContentLoaded', () => new PopupController());
