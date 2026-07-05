class PopupController {
  constructor() {
    this.selectedPlatform = null;
    this.selectedVideos = [];
    this.videoPath = '';
    this.isPublishing = false;
    this.videos = [];
    this.loadTimeout = null;
    this.draggedItem = null;
    this.videoStatuses = [];
    this.skipConfirmIndex = -1;
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadSettings();
    this.checkServerStatus();
    this.pollPublishState();
    this.listenProgress();
  }

  // ========== 跳过：直接写 storage ==========

  async writeSkipToStorage(index) {
    const key = '_vpe_skipped_indices';
    try {
      const data = await chrome.storage.local.get(key);
      const arr = data[key] || [];
      if (!arr.includes(index)) arr.push(index);
      await chrome.storage.local.set({ [key]: arr });
      console.log('[Popup] 写入跳过索引:', index, '全部:', arr);
    } catch (e) { console.error('[Popup] 写入跳过失败:', e); }
  }

  async readSkipFromStorage() {
    try {
      const data = await chrome.storage.local.get('_vpe_skipped_indices');
      return new Set(data._vpe_skipped_indices || []);
    } catch (_) { return new Set(); }
  }

  // ========== 事件绑定 ==========

  bindEvents() {
    document.getElementById('douyin-btn').addEventListener('click', () => this.selectPlatform('douyin'));
    document.getElementById('weixin-btn').addEventListener('click', () => this.selectPlatform('weixin'));
    document.getElementById('open-douyin').addEventListener('click', () => chrome.tabs.create({ url: 'https://creator.douyin.com/creator-micro/home' }));
    document.getElementById('open-weixin').addEventListener('click', () => chrome.tabs.create({ url: 'https://channels.weixin.qq.com/platform' }));
    document.getElementById('browse-btn').addEventListener('click', () => this.showDirBrowser());
    document.getElementById('refresh-btn').addEventListener('click', () => { if (this.videoPath) this.loadVideos(this.videoPath); });
    document.getElementById('publish-btn').addEventListener('click', () => this.togglePublish());

    document.getElementById('scheduled-publish').addEventListener('change', (e) => {
      document.getElementById('schedule-time-wrap').classList.toggle('hidden', !e.target.checked);
      this.updateScheduleHint();
    });
    document.getElementById('auto-generate').addEventListener('change', (e) => {
      document.getElementById('video-content-wrap').classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('auto-retry').addEventListener('change', (e) => {
      document.getElementById('retry-options').classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('auto-generate-row').addEventListener('click', () => {
      document.getElementById('ai-config-wrap').classList.toggle('hidden');
      document.getElementById('ai-arrow').classList.toggle('open');
    });
    document.getElementById('test-ai-btn').addEventListener('click', () => this.testAI());

    const pathInput = document.getElementById('video-path');
    pathInput.addEventListener('input', (e) => {
      this.videoPath = e.target.value;
      if (this.loadTimeout) clearTimeout(this.loadTimeout);
      this.loadTimeout = setTimeout(() => { if (e.target.value.trim()) this.loadVideos(e.target.value.trim()); }, 600);
    });
    pathInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') { if (this.loadTimeout) clearTimeout(this.loadTimeout); this.loadVideos(e.target.value); }
    });
  }

  // ========== 服务状态 ==========

  async checkServerStatus() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const hint = document.getElementById('server-hint');
    try {
      const r = await fetch('http://localhost:3000/health');
      if (r.ok) { dot.className = 'status-dot on'; text.textContent = '服务已连接'; hint.classList.add('hidden'); return; }
    } catch (_) {}
    dot.className = 'status-dot off'; text.textContent = '服务未启动'; hint.classList.remove('hidden');
  }

  // ========== 设置管理 ==========

  async loadSettings() {
    try {
      const r = await chrome.storage.local.get([
        'videoPath', 'aiProvider', 'aiKey', 'aiModel',
        'autoGenerate', 'videoContent', 'scheduledPublish', 'scheduleTime',
        'autoRetry', 'maxRetries', 'timeoutSeconds'
      ]);
      if (r.videoPath) { document.getElementById('video-path').value = r.videoPath; this.videoPath = r.videoPath; this.loadVideos(r.videoPath); }
      if (r.aiProvider) document.getElementById('ai-provider').value = r.aiProvider;
      if (r.aiKey) document.getElementById('ai-key').value = r.aiKey;
      if (r.aiModel) document.getElementById('ai-model').value = r.aiModel;
      if (r.autoGenerate) { document.getElementById('auto-generate').checked = true; document.getElementById('video-content-wrap').classList.remove('hidden'); }
      if (r.videoContent) document.getElementById('video-content').value = r.videoContent;
      if (r.scheduledPublish) { document.getElementById('scheduled-publish').checked = true; document.getElementById('schedule-time-wrap').classList.remove('hidden'); }
      if (r.scheduleTime) document.getElementById('schedule-time').value = r.scheduleTime;
      else this.setDefaultScheduleTime();
      if (r.autoRetry !== undefined) document.getElementById('auto-retry').checked = r.autoRetry;
      else document.getElementById('auto-retry').checked = true; // 默认开启
      if (r.maxRetries) document.getElementById('max-retries').value = r.maxRetries;
      if (r.timeoutSeconds) document.getElementById('timeout-seconds').value = r.timeoutSeconds;
      // 根据 auto-retry 状态显示/隐藏选项
      document.getElementById('retry-options').classList.toggle('hidden', !document.getElementById('auto-retry').checked);
    } catch (e) { console.error(e); }
  }

  setDefaultScheduleTime() {
    const n = new Date(); n.setMinutes(n.getMinutes() + 10);
    const p = v => String(v).padStart(2, '0');
    document.getElementById('schedule-time').value = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}`;
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
        scheduleTime: document.getElementById('schedule-time').value,
        autoRetry: document.getElementById('auto-retry').checked,
        maxRetries: parseInt(document.getElementById('max-retries').value) || 1,
        timeoutSeconds: parseInt(document.getElementById('timeout-seconds').value) || 120
      });
    } catch (e) { console.error(e); }
  }

  updateScheduleHint() {
    const hint = document.getElementById('schedule-hint');
    const on = document.getElementById('scheduled-publish').checked;
    hint.textContent = on
      ? (this.selectedPlatform === 'douyin' ? '抖音：调用平台原生定时发布' : '视频号：首个定时，后续延后40-88分钟')
      : '抖音：调用平台原生定时发布';
  }

  // ========== 平台选择 ==========

  selectPlatform(p) {
    this.selectedPlatform = p;
    document.querySelectorAll('.platform-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`${p}-btn`).classList.add('active');
    this.updateStatus(`已选择${p === 'douyin' ? '抖音' : '视频号'}`);
    this.updateScheduleHint();
  }

  // ========== 视频目录 ==========

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
        const sorted = this.sortVideosByNumber(d.videos);
        this.videos = sorted;
        this.selectedVideos = [...sorted];
        this.renderVideoList(sorted);
        this.renderQueue();
        this.updateStatus(`已加载 ${sorted.length} 个视频`);
      } else {
        this.updateStatus(d.error || '未找到视频');
        this.clearList();
      }
    } catch (e) {
      this.updateStatus(e.message.includes('Failed') ? '服务未连接' : `错误: ${e.message}`);
      this.clearList();
    }
  }

  sortVideosByNumber(videos) {
    if (!videos || videos.length === 0) return videos;
    const hasNum = v => /^\d+/.test(v.name);
    if (videos.every(hasNum)) return [...videos].sort((a, b) => parseInt(a.name.match(/^(\d+)/)[1]) - parseInt(b.name.match(/^(\d+)/)[1]));
    const withNum = [], withoutNum = [];
    videos.forEach(v => (hasNum(v) ? withNum : withoutNum).push(v));
    withNum.sort((a, b) => parseInt(a.name.match(/^(\d+)/)[1]) - parseInt(b.name.match(/^(\d+)/)[1]));
    return [...withNum, ...withoutNum];
  }

  clearList() {
    document.getElementById('video-list').innerHTML = '';
    this.videos = [];
    this.selectedVideos = [];
    this.renderQueue();
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
      item.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') item.querySelector('input').checked = !item.querySelector('input').checked; this.syncSelected(); });
      item.querySelector('input').addEventListener('change', () => this.syncSelected());
      item.addEventListener('dragstart', () => { this.draggedItem = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); this.draggedItem = null; c.querySelectorAll('.video-item').forEach(i => i.classList.remove('drag-over')); });
      item.addEventListener('dragover', (e) => { e.preventDefault(); return false; });
      item.addEventListener('dragenter', () => { if (item !== this.draggedItem) item.classList.add('drag-over'); });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        e.stopPropagation();
        if (item !== this.draggedItem) {
          const vids = [...this.selectedVideos];
          const from = parseInt(this.draggedItem.dataset.index), to = parseInt(item.dataset.index);
          const [m] = vids.splice(from, 1); vids.splice(to, 0, m);
          this.selectedVideos = vids; this.renderVideoList(vids); this.renderQueue();
        }
        item.classList.remove('drag-over');
        return false;
      });
    });
  }

  syncSelected() {
    const checked = document.querySelectorAll('#video-list input:checked');
    this.selectedVideos = Array.from(checked).map(cb => this.videos[parseInt(cb.id.replace('v-', ''))]).filter(Boolean);
    this.renderQueue();
  }

  renderQueue() {
    const c = document.getElementById('publish-queue');
    const n = document.getElementById('queue-count');
    n.textContent = this.selectedVideos.length;
    if (!this.selectedVideos.length) {
      c.innerHTML = '<div style="color:var(--text-3);font-size:10px;text-align:center;padding:6px">无视频</div>';
      return;
    }
    c.innerHTML = this.selectedVideos.map((v, i) => {
      const status = this.videoStatuses[i] || 'pending';
      const isSkipped = status === 'skipped';
      const showConfirm = this.isPublishing && this.skipConfirmIndex === i;
      return `<div class="queue-item${isSkipped ? ' skipped' : ''}" data-index="${i}">
        <span class="dot ${status}"></span>
        <span class="queue-name">${i+1}. ${v.name}</span>
        ${isSkipped ? '<span class="queue-status">已跳过</span>' : ''}
        ${showConfirm ? `<span class="skip-inline">
          <button class="skip-yes" data-skip="${i}">跳过</button>
          <button class="skip-no" data-cancel="${i}">取消</button>
        </span>` : ''}
      </div>`;
    }).join('');

    c.querySelectorAll('.skip-yes').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmSkip(parseInt(btn.dataset.skip)); });
    });
    c.querySelectorAll('.skip-no').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.skipConfirmIndex = -1; this.renderQueue(); });
    });

    if (this.isPublishing) {
      c.querySelectorAll('.queue-item').forEach(item => {
        const idx = parseInt(item.dataset.index);
        if (this.videoStatuses[idx] === 'pending') {
          item.style.cursor = 'pointer';
          item.addEventListener('click', () => this.showSkipConfirm(idx));
        }
      });
    }
  }

  showSkipConfirm(index) {
    if (this.videoStatuses[index] !== 'pending') return;
    this.skipConfirmIndex = this.skipConfirmIndex === index ? -1 : index;
    this.renderQueue();
  }

  async confirmSkip(index) {
    this.videoStatuses[index] = 'skipped';
    this.skipConfirmIndex = -1;
    this.renderQueue();
    // ★ 核心修复：直接写 storage，不依赖消息传递
    await this.writeSkipToStorage(index);
    // 同时发消息通知 background（作为辅助，不依赖其可靠性）
    try { chrome.runtime.sendMessage({ action: 'skipVideo', index }); } catch (_) {}
  }

  fmtSize(b) {
    if (!b) return '0B';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b/1024).toFixed(1) + 'K';
    if (b < 1073741824) return (b/1048576).toFixed(1) + 'M';
    return (b/1073741824).toFixed(1) + 'G';
  }

  // ========== 发布按钮 ==========

  togglePublish() {
    if (this.isPublishing) this.stopPublish();
    else this.startPublish();
  }

  setPublishButtonState(running) {
    const btn = document.getElementById('publish-btn');
    const container = document.getElementById('app-container');
    const anim = document.getElementById('publish-animation');
    this.isPublishing = running;
    if (running) {
      btn.textContent = '停止'; btn.classList.add('running');
      container.classList.add('publishing-mode');
      anim.classList.remove('hidden');
    } else {
      btn.textContent = '发布'; btn.classList.remove('running');
      container.classList.remove('publishing-mode');
      anim.classList.add('hidden');
    }
  }

  // ========== 传送带动画 ==========

  updateAnimation(currentName, currentIdx, total, statusText) {
    const belt = document.getElementById('anim-belt');
    const status = document.getElementById('anim-status');
    if (!belt || !status) return;

    // 构建传送带内容
    let html = '';
    const maxShow = Math.min(total, 8);
    for (let i = 0; i < maxShow; i++) {
      const s = this.videoStatuses[i] || 'pending';
      let cls = 'belt-item';
      if (s === 'done') cls += ' done';
      else if (s === 'publishing' || (i === currentIdx && !this.videoStatuses[i])) cls += ' active';
      else if (s === 'skipped') cls += ' skipped';
      else if (s === 'error') cls += ' error';

      // 只显示缩写文件名
      const shortName = this.selectedVideos[i]?.name || '';
      const label = shortName.length > 8 ? shortName.substring(0, 6) + '..' : shortName;

      html += `<div class="${cls}" title="${shortName}">
        <span class="belt-icon">${s === 'done' ? '✓' : s === 'skipped' ? '—' : s === 'error' ? '✗' : '🎬'}</span>
        <span class="belt-label">${label}</span>
      </div>`;
    }
    if (total > maxShow) {
      html += `<div class="belt-item belt-more">+${total - maxShow}</div>`;
    }
    belt.innerHTML = html;

    // 状态文字
    status.textContent = statusText || (currentName ? `发布中：${currentName}（${currentIdx + 1}/${total}）` : '准备中...');
  }

  hideAnimation() {
    const belt = document.getElementById('anim-belt');
    const status = document.getElementById('anim-status');
    if (belt) belt.innerHTML = '';
    if (status) status.textContent = '';
  }

  // ========== 进度 ==========

  hideProgress() {
    document.getElementById('progress-section').classList.add('hidden');
    document.getElementById('progress-fill').style.width = '0%';
  }

  updateQueueStatus(index, status) {
    this.videoStatuses[index] = status;
    this.renderQueue();
  }

  listenProgress() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'progressUpdate') this.handleProgressUpdate(msg);
    });
  }

  handleProgressUpdate(msg) {
    const { step, detail, current, total, videoIndex, status, done } = msg;
    if (videoIndex !== undefined && status) this.updateQueueStatus(videoIndex, status);

    if (step) {
      document.getElementById('progress-section').classList.remove('hidden');
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('progress-step').textContent = step;
      document.getElementById('progress-detail').textContent = detail || `${current} / ${total}`;
    }

    // 更新传送带动画
    const curVideo = this.selectedVideos[videoIndex] || this.selectedVideos[this.selectedVideos.length - 1];
    const curName = curVideo?.name || '';
    this.updateAnimation(curName, videoIndex || 0, this.selectedVideos.length, step);

    if (done) {
      setTimeout(() => {
        this.setPublishButtonState(false);
        this.hideProgress();
        this.hideAnimation();
        this.updateStatus('全部完成');
        this.videoStatuses = [];
        this.skipConfirmIndex = -1;
      }, 1500);
    }
  }

  // ========== 发布流程 ==========

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
    this.videoStatuses = this.selectedVideos.map(() => 'pending');
    this.skipConfirmIndex = -1;
    this.renderQueue();
    this.updateAnimation(this.selectedVideos[0]?.name, 0, this.selectedVideos.length, '准备发布...');

    const settings = {
      autoGenerate: autoGen,
      aiProvider: document.getElementById('ai-provider').value,
      aiKey: document.getElementById('ai-key').value.trim(),
      aiModel: document.getElementById('ai-model').value.trim(),
      videoContent: document.getElementById('video-content').value.trim(),
      scheduledPublish: document.getElementById('scheduled-publish').checked,
      scheduleTime: document.getElementById('schedule-time').value,
      autoRetry: document.getElementById('auto-retry').checked,
      maxRetries: parseInt(document.getElementById('max-retries').value) || 1,
      timeoutSeconds: parseInt(document.getElementById('timeout-seconds').value) || 120
    };

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
      this.hideAnimation();
    }
  }

  async stopPublish() {
    await chrome.runtime.sendMessage({ action: 'stopPublish' });
    this.setPublishButtonState(false);
    this.hideProgress();
    this.hideAnimation();
    this.updateStatus('已停止');
    this.skipConfirmIndex = -1;
    this.renderQueue();
  }

  async pollPublishState() {
    setInterval(async () => {
      try {
        const s = await chrome.runtime.sendMessage({ action: 'getPublishState' });
        if (s?.isPublishing && !this.isPublishing) this.setPublishButtonState(true);
        else if (!s?.isPublishing && this.isPublishing) { this.setPublishButtonState(false); this.hideProgress(); this.hideAnimation(); }
      } catch (_) {}
    }, 2000);
  }

  updateStatus(t) { document.getElementById('status-text').textContent = t; }

  // ========== AI 测试 ==========

  async testAI() {
    const provider = document.getElementById('ai-provider').value;
    const apiKey = document.getElementById('ai-key').value.trim();
    const model = document.getElementById('ai-model').value.trim();
    const resultEl = document.getElementById('test-result');
    const btn = document.getElementById('test-ai-btn');
    if (!provider) { resultEl.className = 'test-result fail'; resultEl.textContent = '请先选择 Provider'; resultEl.classList.remove('hidden'); return; }
    if (!apiKey) { resultEl.className = 'test-result fail'; resultEl.textContent = '请先填写 API Key'; resultEl.classList.remove('hidden'); return; }
    btn.disabled = true; btn.textContent = '测试中...';
    resultEl.className = 'test-result'; resultEl.textContent = ''; resultEl.classList.remove('hidden');
    try {
      const r = await chrome.runtime.sendMessage({ action: 'testAI', provider, apiKey, model });
      if (r?.success) { resultEl.className = 'test-result ok'; resultEl.textContent = `连接成功! 回复: ${r.reply?.substring(0, 100) || '(空)'}`; }
      else { resultEl.className = 'test-result fail'; resultEl.textContent = `失败: ${r?.error || '未知错误'}`; }
    } catch (e) { resultEl.className = 'test-result fail'; resultEl.textContent = `错误: ${e.message}`; }
    finally { btn.disabled = false; btn.textContent = '测试连接'; }
  }

  // ========== 目录浏览器 ==========

  showDirBrowser() {
    if (document.getElementById('dir-mask')) return;
    const cur = document.getElementById('video-path').value.trim() || '';
    const mask = document.createElement('div');
    mask.id = 'dir-mask'; mask.className = 'dir-modal-mask';
    mask.innerHTML = `<div class="dir-modal">
      <div class="dir-modal-head"><span>选择目录</span><button id="dir-close">✕</button></div>
      <div class="dir-modal-path" id="dir-path"></div>
      <div class="dir-modal-list" id="dir-list"></div>
      <div class="dir-modal-foot"><button id="dir-ok">选择此目录</button></div>
    </div>`;
    document.body.appendChild(mask);
    mask.querySelector('#dir-close').onclick = () => mask.remove();
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#dir-ok').onclick = () => {
      const p = mask.dataset.path || '';
      if (p) { document.getElementById('video-path').value = p; this.videoPath = p; this.loadVideos(p); }
      mask.remove();
    };
    this.loadDir(mask, cur || '/');
  }

  async loadDir(mask, dir) {
    const list = mask.querySelector('#dir-list');
    const pathEl = mask.querySelector('#dir-path');
    pathEl.textContent = dir; mask.dataset.path = dir;
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
      html += dirs.map(dd => `<div class="dir-item" data-path="${dd.path}"><span class="arrow">▸</span>${dd.name}</div>`).join('');
      list.innerHTML = html || '<div style="padding:16px;text-align:center;color:var(--text-3)">无子目录</div>';
      list.querySelectorAll('.dir-item').forEach(el => el.addEventListener('click', () => this.loadDir(mask, el.dataset.path)));
    } catch (_) { list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--dot-off)">加载失败</div>'; }
  }
}

document.addEventListener('DOMContentLoaded', () => new PopupController());
