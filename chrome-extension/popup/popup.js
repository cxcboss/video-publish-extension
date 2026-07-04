class PopupController {
  constructor() {
    this.selectedPlatform = null;
    this.selectedVideos = [];
    this.videoPath = '';
    this.isPublishing = false;
    this.videos = [];
    this.loadTimeout = null;
    this.draggedItem = null;
    this.videoStatuses = []; // 每个视频的发布状态
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
    // 平台选择
    document.getElementById('douyin-btn').addEventListener('click', () => this.selectPlatform('douyin'));
    document.getElementById('weixin-btn').addEventListener('click', () => this.selectPlatform('weixin'));

    // 打开创作者中心
    document.getElementById('open-douyin').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://creator.douyin.com/creator-micro/home' });
    });
    document.getElementById('open-weixin').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://channels.weixin.qq.com/platform' });
    });

    // 视频目录
    document.getElementById('browse-btn').addEventListener('click', () => this.showDirBrowser());
    document.getElementById('refresh-btn').addEventListener('click', () => {
      if (this.videoPath) this.loadVideos(this.videoPath);
    });

    // 发布按钮
    document.getElementById('publish-btn').addEventListener('click', () => this.togglePublish());

    // 定时发布开关
    document.getElementById('scheduled-publish').addEventListener('change', (e) => {
      document.getElementById('schedule-time-wrap').classList.toggle('hidden', !e.target.checked);
      this.updateScheduleHint();
    });

    // AI 生成开关
    document.getElementById('auto-generate').addEventListener('change', (e) => {
      document.getElementById('video-content-wrap').classList.toggle('hidden', !e.target.checked);
    });

    // 自动重试开关
    document.getElementById('auto-retry').addEventListener('change', (e) => {
      document.getElementById('retry-count-wrap').classList.toggle('hidden', !e.target.checked);
    });

    // AI 配置折叠
    document.getElementById('auto-generate-row').addEventListener('click', () => {
      const body = document.getElementById('ai-config-wrap');
      const arrow = document.getElementById('ai-arrow');
      body.classList.toggle('hidden');
      arrow.classList.toggle('open');
    });

    // AI 测试按钮
    document.getElementById('test-ai-btn').addEventListener('click', () => this.testAI());

    // 路径输入（延迟加载）
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

  // ==================== 服务状态 ====================

  async checkServerStatus() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const hint = document.getElementById('server-hint');

    try {
      const r = await fetch('http://localhost:3000/health');
      if (r.ok) {
        dot.className = 'status-dot on';
        text.textContent = '服务已连接';
        hint.classList.add('hidden');
        return;
      }
    } catch (_) {}

    dot.className = 'status-dot off';
    text.textContent = '服务未启动';
    hint.classList.remove('hidden');
  }

  // ==================== 设置管理 ====================

  async loadSettings() {
    try {
      const r = await chrome.storage.local.get([
        'videoPath', 'aiProvider', 'aiKey', 'aiModel',
        'autoGenerate', 'videoContent', 'scheduledPublish', 'scheduleTime',
        'autoRetry', 'maxRetries'
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
      if (r.autoRetry) {
        document.getElementById('auto-retry').checked = true;
        document.getElementById('retry-count-wrap').classList.remove('hidden');
      }
      if (r.maxRetries) document.getElementById('max-retries').value = r.maxRetries;
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
        scheduleTime: document.getElementById('schedule-time').value,
        autoRetry: document.getElementById('auto-retry').checked,
        maxRetries: parseInt(document.getElementById('max-retries').value) || 1
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

  // ==================== 平台选择 ====================

  selectPlatform(p) {
    this.selectedPlatform = p;
    document.querySelectorAll('.platform-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`${p}-btn`).classList.add('active');
    this.updateStatus(`已选择${p === 'douyin' ? '抖音' : '视频号'}`);
    this.updateScheduleHint();
  }

  // ==================== 视频目录 ====================

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
        // 自动按数字前缀排序
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

  /**
   * 按数字前缀排序视频：
   * 如果文件名开头是数字（如 "01.mp4", "12-xxx.mp4"），按数字大小排序
   * 否则保持原有顺序
   */
  sortVideosByNumber(videos) {
    if (!videos || videos.length === 0) return videos;

    // 检查是否所有文件名都有数字前缀
    const hasNumberPrefix = v => /^\d+/.test(v.name);

    const allHaveNumbers = videos.every(hasNumberPrefix);
    if (allHaveNumbers) {
      return [...videos].sort((a, b) => {
        const numA = parseInt(a.name.match(/^(\d+)/)[1], 10);
        const numB = parseInt(b.name.match(/^(\d+)/)[1], 10);
        return numA - numB;
      });
    }

    // 部分有数字前缀：有数字的排前面，按数字排序
    const withNum = [];
    const withoutNum = [];
    videos.forEach(v => {
      if (hasNumberPrefix(v)) withNum.push(v);
      else withoutNum.push(v);
    });
    withNum.sort((a, b) => {
      const numA = parseInt(a.name.match(/^(\d+)/)[1], 10);
      const numB = parseInt(b.name.match(/^(\d+)/)[1], 10);
      return numA - numB;
    });

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
      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') item.querySelector('input').checked = !item.querySelector('input').checked;
        this.syncSelected();
      });
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
      c.innerHTML = '<div style="color:var(--text-3);font-size:10px;text-align:center;padding:6px">无视频</div>';
      return;
    }
    c.innerHTML = this.selectedVideos.map((v, i) => {
      const status = this.videoStatuses[i] || 'pending';
      return `<div class="queue-item" data-index="${i}">
        <span class="dot ${status}"></span>
        <span class="queue-name">${i+1}. ${v.name}</span>
        <span class="queue-status">${this._statusLabel(status)}</span>
      </div>`;
    }).join('');

    // 发布模式下，点击排队中的视频可以跳过
    if (this.isPublishing) {
      c.querySelectorAll('.queue-item').forEach(item => {
        const idx = parseInt(item.dataset.index);
        if (this.videoStatuses[idx] === 'pending') {
          item.style.cursor = 'pointer';
          item.addEventListener('click', () => this.promptSkip(idx));
        }
      });
    }
  }

  _statusLabel(status) {
    const labels = { pending: '等待中', publishing: '发布中', done: '已发布', error: '失败', skipped: '已跳过' };
    return labels[status] || '';
  }

  promptSkip(index) {
    if (this.videoStatuses[index] !== 'pending') return;

    // 移除旧的 skip-hint
    const old = document.querySelector('.skip-hint');
    if (old) old.remove();

    const v = this.selectedVideos[index];
    const hint = document.createElement('div');
    hint.className = 'skip-hint';
    hint.innerHTML = `
      <div class="skip-hint-text">跳过「${v.name}」后将不再发布此视频</div>
      <div class="skip-hint-actions">
        <button class="skip-cancel">取消</button>
        <button class="skip-confirm">跳过</button>
      </div>`;
    document.body.appendChild(hint);

    hint.querySelector('.skip-cancel').onclick = () => hint.remove();
    hint.querySelector('.skip-confirm').onclick = () => {
      this.videoStatuses[index] = 'skipped';
      this.renderQueue();
      hint.remove();
      // 通知 background 跳过这个视频
      chrome.runtime.sendMessage({ action: 'skipVideo', index });
    };
  }

  fmtSize(b) {
    if (!b) return '0B';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b/1024).toFixed(1) + 'K';
    if (b < 1073741824) return (b/1048576).toFixed(1) + 'M';
    return (b/1073741824).toFixed(1) + 'G';
  }

  // ==================== 发布按钮 ====================

  togglePublish() {
    if (this.isPublishing) this.stopPublish();
    else this.startPublish();
  }

  setPublishButtonState(running) {
    const btn = document.getElementById('publish-btn');
    const container = document.getElementById('app-container');
    this.isPublishing = running;
    if (running) {
      btn.textContent = '停止';
      btn.classList.add('running');
      container.classList.add('publishing-mode');
    } else {
      btn.textContent = '发布';
      btn.classList.remove('running');
      container.classList.remove('publishing-mode');
    }
  }

  // ==================== 进度条 ====================

  showProgress(steps, current) {
    const section = document.getElementById('progress-section');
    section.classList.remove('hidden');
    const pct = steps.length > 0 ? Math.round(((current + 1) / steps.length) * 100) : 0;
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-step').textContent = steps[current] || '准备中...';
    document.getElementById('progress-detail').textContent = `${current + 1} / ${steps.length}`;
  }

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
    if (step) {
      document.getElementById('progress-section').classList.remove('hidden');
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('progress-step').textContent = step;
      document.getElementById('progress-detail').textContent = detail || `${current} / ${total}`;
    }
    if (videoIndex !== undefined && status) this.updateQueueStatus(videoIndex, status);
    if (done) {
      setTimeout(() => {
        this.setPublishButtonState(false);
        this.hideProgress();
        this.updateStatus('全部完成');
        this.videoStatuses = [];
      }, 1500);
    }
  }

  // ==================== 发布流程 ====================

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

    // 初始化所有视频状态
    this.videoStatuses = this.selectedVideos.map(() => 'pending');
    this.renderQueue();

    const settings = {
      autoGenerate: autoGen,
      aiProvider: document.getElementById('ai-provider').value,
      aiKey: document.getElementById('ai-key').value.trim(),
      aiModel: document.getElementById('ai-model').value.trim(),
      videoContent: document.getElementById('video-content').value.trim(),
      scheduledPublish: document.getElementById('scheduled-publish').checked,
      scheduleTime: document.getElementById('schedule-time').value,
      autoRetry: document.getElementById('auto-retry').checked,
      maxRetries: parseInt(document.getElementById('max-retries').value) || 1
    };

    // 显示进度
    const steps = [];
    for (let i = 0; i < this.selectedVideos.length; i++) {
      steps.push(`[${i+1}/${this.selectedVideos.length}] ${this.selectedVideos[i].name}`);
    }
    this.showProgress(steps, 0);

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
    // 标记未完成的视频为停止
    this.videoStatuses = this.videoStatuses.map(s =>
      s === 'pending' || s === 'publishing' ? 'pending' : s
    );
    this.renderQueue();
  }

  async pollPublishState() {
    setInterval(async () => {
      try {
        const s = await chrome.runtime.sendMessage({ action: 'getPublishState' });
        if (s?.isPublishing && !this.isPublishing) this.setPublishButtonState(true);
        else if (!s?.isPublishing && this.isPublishing) { this.setPublishButtonState(false); this.hideProgress(); }
      } catch (_) {}
    }, 2000);
  }

  updateStatus(t) {
    document.getElementById('status-text').textContent = t;
  }

  // ==================== AI 测试 ====================

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

  // ==================== 目录浏览器 ====================

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
      html += dirs.map(dd => `<div class="dir-item" data-path="${dd.path}"><span class="arrow">▸</span>${dd.name}</div>`).join('');
      list.innerHTML = html || '<div style="padding:16px;text-align:center;color:var(--text-3)">无子目录</div>';
      list.querySelectorAll('.dir-item').forEach(el => el.addEventListener('click', () => this.loadDir(mask, el.dataset.path)));
    } catch (_) { list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--dot-off)">加载失败</div>'; }
  }
}

document.addEventListener('DOMContentLoaded', () => new PopupController());
