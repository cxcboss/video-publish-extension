/**
 * 抖音发布助手 - Content Script
 *
 * 负责在抖音创作者平台 (creator.douyin.com) 自动发布视频：
 * 1. 接收 background 的发布命令
 * 2. 上传视频文件（DataTransfer API 注入 input[type="file"]）
 * 3. AI 生成文案和话题（可选，与上传并行）
 * 4. 填写描述、话题、定时发布、星图任务等表单
 * 5. 点击发布按钮，通知 background 发布结果
 *
 * 发布流程：页面加载 → 上传视频 → 并行AI生成 → 填写表单 → 点击发布
 *
 * 关键技术点：
 * - React 合成事件系统：原生 .click() 无法触发 React onClick，必须用 reactClick()
 * - React 懒加载：星图任务等区域在页面底部，需渐进式滚动触发渲染
 * - contenteditable 填写：用 document.execCommand('insertText') 而非 value 赋值
 * - React 受控组件：input[type="file"] 用 DataTransfer API 注入（不受 React 控制）
 */
class DouyinPublisher {
  constructor() {
    this.isReady = false;
    this.defaultTopics = ['#动画', '#奇葩游戏', '#游戏视频', '#小游戏', '#休闲游戏'];
    this.aborted = false;
    this.init();
  }

  init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'startPublish') {
        this.aborted = false;
        this.publishSingleVideo(message.videos[0], message.settings, message.videoPath, message.videoIndex, message.totalVideos)
          .then(() => {
            if (this.aborted) return;
            this.notifyProgress('发布完成', message.videoIndex + 1, message.totalVideos, 'done');
            sendResponse({ success: true });
          })
          .catch(error => {
            if (this.aborted) return;
            console.error('[抖音发布助手] 发布失败:', error);
            this.notifyProgress('发布失败: ' + error.message, message.videoIndex + 1, message.totalVideos, 'error');
            sendResponse({ success: false, error: error.message });
          });
        return true;
      }
      if (message.action === 'ping') {
        sendResponse({ ready: true, elementCount: document.querySelectorAll('*').length });
        return true;
      }
      if (message.action === 'abortPublish') {
        this.aborted = true;
        console.log('[抖音发布助手] 收到中止信号');
        sendResponse({ aborted: true });
        return true;
      }
    });
    this.isReady = true;
  }

  async publishSingleVideo(video, settings, videoPath, videoIndex, totalVideos) {
    const idx = videoIndex + 1;
    const step = (msg) => console.log(`[抖音发布助手] [${idx}/${totalVideos}] ${msg}`);
    step(`开始发布: ${video.name}`);

    // 步骤1: 等待页面加载
    this.notifyProgress('等待页面加载...', idx, totalVideos);
    await this.waitForPageReady();
    if (this.aborted) return;
    await this.delay(1500);
    if (this.aborted) return;

    // 解析文件名，提取星图任务名（格式：小游戏-xxx.mp4）
    const taskInfo = this.parseTaskFromName(video.name);

    // 步骤2: 查找上传入口并上传视频
    this.notifyProgress('查找上传入口...', idx, totalVideos);
    const uploadInput = await this.findUploadInput();
    if (!uploadInput) throw new Error('未找到上传入口，请确保在正确的发布页面');

    this.notifyProgress('上传视频中...', idx, totalVideos);
    const file = await this.getVideoFile(videoPath, video.name);
    if (!file) throw new Error('无法获取视频文件');
    if (this.aborted) return;
    step(`视频大小: ${(file.size / 1024 / 1024).toFixed(1)}MB`);

    // DataTransfer API 注入文件到 input[type="file]（React 不拦截 file input）
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([file], video.name, { type: 'video/mp4' }));
    uploadInput.files = dataTransfer.files;
    uploadInput.dispatchEvent(new Event('change', { bubbles: true }));

    // 并行启动 AI 生成（不阻塞上传等待）
    let aiPromise = null;
    if (settings.autoGenerate) {
      this.notifyProgress('AI 生成文案中...', idx, totalVideos);
      aiPromise = this.generateAIContent(video.name, settings);
    }

    // 轮询等待上传完成（最多8秒，超时则继续填写表单）
    this.notifyProgress('等待视频处理...', idx, totalVideos);
    const uploadOk = await this.waitForUploadComplete(8);
    if (!uploadOk) step('上传检测超时，继续填写表单...');
    if (this.aborted) return;

    // 步骤3: 定时发布
    if (settings.scheduledPublish && settings.scheduleTime) {
      this.notifyProgress('设置定时发布...', idx, totalVideos);
      await this.setScheduledPublish(settings.scheduleTime);
      if (this.aborted) return;
    }

    // 步骤4: 选择星图任务（文件名含"小游戏-"前缀时触发）
    if (taskInfo) {
      this.notifyProgress('选择星图任务...', idx, totalVideos);
      const taskOk = await this.selectStarTask(taskInfo.searchTerm);
      step(`星图任务${taskOk ? '选择成功' : '选择失败'}`);
      await this.delay(500);
      if (this.aborted) return;
    }

    // 步骤5: 获取 AI 结果
    let aiContent = { topics: [], description: '' };
    if (settings.autoGenerate && aiPromise) {
      try { aiContent = await aiPromise; } catch (e) { step(`AI 生成失败: ${e.message}`); }
    }
    if (this.aborted) return;

    // 步骤6: 填写描述
    if (settings.autoGenerate && aiContent.description) {
      this.notifyProgress('填写描述文案...', idx, totalVideos);
      let descOk = await this.fillDescription(aiContent.description);
      if (!descOk) { await this.delay(500); descOk = await this.fillDescription(aiContent.description); }
      if (!descOk) step('描述填写失败');
    }

    // 步骤7: 填写话题
    let topicsToFill = [];
    if (settings.autoGenerate && aiContent.topics?.length > 0) {
      topicsToFill = aiContent.topics.slice(0, 5);
    } else if (taskInfo) {
      topicsToFill = ['#抖音小游戏']; // 有星图任务但无AI → 固定话题
    } else {
      topicsToFill = this.defaultTopics; // 无任务无AI → 默认话题
    }
    if (topicsToFill.length > 0) {
      this.notifyProgress('填写话题标签...', idx, totalVideos);
      let topicOk = await this.fillTopics(topicsToFill);
      if (!topicOk) { await this.delay(500); topicOk = await this.fillTopics(topicsToFill); }
    }

    // 步骤8: 点击发布
    await this.delay(500);
    if (this.aborted) return;
    this.notifyProgress('点击发布...', idx, totalVideos);
    const publishResult = await this.clickPublish();
    if (!publishResult) step('发布按钮点击失败');

    // 步骤9: 通知 background 保存发布记录
    await this.delay(3000);
    chrome.runtime.sendMessage({
      action: 'douyinPublishDone',
      videoName: video.name,
      videoPath: videoPath,
      scheduled: settings.scheduledPublish || false
    }).catch(() => {});
  }

  async waitForPageReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve);
    });
  }

  /**
   * 轮询等待上传完成：检测 contenteditable / textarea / editor 出现
   * 这些元素只在视频上传完成、表单加载后才会渲染
   */
  async waitForUploadComplete(maxSeconds) {
    const maxMs = maxSeconds * 1000;
    let waited = 0;
    while (waited < maxMs) {
      const editors = document.querySelectorAll(
        '[contenteditable="true"], textarea, [class*="editor"], [class*="Editor"], [class*="desc"], [class*="Desc"]'
      );
      for (const el of editors) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
      }
      await this.delay(1000);
      waited += 1000;
    }
    return false;
  }

  /**
   * 查找 file input 元素（按优先级匹配 accept 类型）
   */
  async findUploadInput() {
    const selectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*=".mp4"]',
      'input[type="file"][accept*=".mov"]',
      'input[type="file"]'
    ];
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const selector of selectors) {
        for (const input of document.querySelectorAll(selector)) {
          if (input.type === 'file') return input;
        }
      }
      await this.delay(500);
    }
    return null;
  }

  async getVideoFile(videoPath, videoName) {
    const fullPath = videoPath.endsWith('/') ? `${videoPath}${videoName}` : `${videoPath}/${videoName}`;
    try {
      const response = await fetch(`http://localhost:3000/api/video/file?path=${encodeURIComponent(fullPath)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.blob();
    } catch (error) {
      console.error('[抖音发布助手] 获取视频文件失败:', error);
      return null;
    }
  }

  // ===== AI 内容生成 =====

  async generateAIContent(videoName, settings) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'generateContent',
        videoName: videoName,
        settings: settings
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ topics: [], description: '', error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { topics: [], description: '' });
        }
      });
    });
  }

  // ===== 描述填写 =====

  /**
   * 查找主编辑器：选面积最大的 contenteditable，排除话题/标签输入框
   */
  findMainEditor() {
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    const candidates = [];
    for (const el of allEditable) {
      if (!this.isElementVisible(el)) continue;
      const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
      const cls = el.className || '';
      const isTagInput = placeholder.includes('话题') || placeholder.includes('tag') ||
                         placeholder.includes('搜索') || placeholder.includes('Tag') ||
                         cls.includes('tag') || cls.includes('Tag') ||
                         cls.includes('topic') || cls.includes('Topic');
      if (isTagInput) continue;
      const rect = el.getBoundingClientRect();
      candidates.push({ el, area: rect.width * rect.height });
    }
    candidates.sort((a, b) => b.area - a.area);
    return candidates[0]?.el || null;
  }

  async fillDescription(description) {
    const editor = this.findMainEditor();
    if (editor) {
      editor.focus();
      await this.delay(100);
      editor.click();
      await this.delay(100);
      editor.innerHTML = '';
      document.execCommand('insertText', false, description);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const textareas = document.querySelectorAll('textarea');
    for (const textarea of textareas) {
      if (this.isElementVisible(textarea)) {
        textarea.focus();
        textarea.value = description;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // ===== 话题填写 =====

  /**
   * 查找话题/标签输入框
   * 优先匹配 placeholder 含"话题""tag""#""搜索"的元素，兜底选最小的 contenteditable
   */
  findTagInput() {
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    for (const el of allEditable) {
      if (!this.isElementVisible(el)) continue;
      const cls = el.className || '';
      const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
      if (placeholder.includes('话题') || placeholder.includes('tag') ||
          placeholder.includes('搜索') || placeholder.includes('Tag') ||
          cls.includes('tag') || cls.includes('Tag') ||
          cls.includes('topic') || cls.includes('Topic') ||
          placeholder.includes('#')) {
        return el;
      }
    }
    const all = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(el => this.isElementVisible(el));
    if (all.length > 1) {
      all.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) -
                          (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
      return all[0];
    }
    return null;
  }

  async fillTopics(topics) {
    const topicText = topics.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
    const tagInput = this.findTagInput();
    if (tagInput) {
      tagInput.focus();
      await this.delay(100);
      tagInput.click();
      await this.delay(100);
      document.execCommand('insertText', false, topicText + ' ');
      tagInput.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const editor = this.findMainEditor();
    if (editor) {
      editor.focus();
      await this.delay(100);
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, '\n' + topicText + ' ');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  isElementVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           element.offsetWidth > 0 &&
           element.offsetHeight > 0;
  }

  // ===== 发布按钮 =====

  /**
   * 查找并点击发布按钮（优先级：发布 > 立即发布 > 其他含"发布"按钮）
   */
  async clickPublish() {
    const allButtons = document.querySelectorAll('button');
    const publishButtons = [];
    for (const btn of allButtons) {
      const text = (btn.textContent || '').trim();
      if (this.isElementVisible(btn) && !btn.disabled) {
        if (text === '发布' || text === '发表') publishButtons.push({ btn, priority: 1 });
        else if (text === '立即发布' || text === '立即发表') publishButtons.push({ btn, priority: 2 });
        else if (text.includes('发布') && !text.includes('高清') && !text.includes('定时')) publishButtons.push({ btn, priority: 3 });
      }
    }
    publishButtons.sort((a, b) => a.priority - b.priority);
    if (publishButtons.length > 0) { publishButtons[0].btn.click(); return true; }
    return false;
  }

  // ===== 进度通知 =====

  notifyProgress(step, current, total, status) {
    try {
      chrome.runtime.sendMessage({ action: 'publishProgress', status: step, current, total }).catch(() => {});
      chrome.runtime.sendMessage({
        action: 'progressUpdate', step, detail: status || 'publishing',
        current, total, videoIndex: current - 1, status: status || 'publishing'
      }).catch(() => {});
    } catch (e) {}
  }

  // ===== 定时发布 =====

  /**
   * 设置定时发布：查找"定时发布"开关 → 开启 → 设置日期时间
   * 抖音的日期和时间是同一个 input（placeholder="日期和时间"），格式 YYYY-MM-DD HH:MM
   */
  async setScheduledPublish(scheduleTime) {
    const parts = scheduleTime.replace('T', ' ').split(' ');
    const [year, month, day] = parts[0].split('-');
    const [hour, minute] = (parts[1] || '00:00').split(':');
    const pad = n => String(n).padStart(2, '0');
    const fullDatetime = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;

    // 查找"定时发布"开关并点击
    let scheduleToggle = null;
    for (const el of document.querySelectorAll('*')) {
      if (!this.isElementVisible(el)) continue;
      const text = el.textContent?.trim() || '';
      if (text === '定时发布' || text === '定时' || text === '预约发布') {
        let target = el;
        for (let i = 0; i < 5; i++) {
          if (target.tagName === 'BUTTON' || target.tagName === 'LABEL' ||
              target.tagName === 'INPUT' || target.getAttribute('role') === 'switch' ||
              target.getAttribute('role') === 'checkbox' || target.onclick) {
            scheduleToggle = target; break;
          }
          target = target.parentElement;
          if (!target) break;
        }
        if (!scheduleToggle) scheduleToggle = el;
        break;
      }
    }
    if (!scheduleToggle) {
      for (const sw of document.querySelectorAll('[role="switch"], [class*="switch"], [class*="toggle"]')) {
        if (sw.textContent?.includes('定时') || sw.parentElement?.textContent?.includes('定时')) {
          scheduleToggle = sw; break;
        }
      }
    }
    if (!scheduleToggle) return false;

    scheduleToggle.click();
    await this.delay(1500);

    // 策略1: 联合日期时间 input（placeholder 含"日期"，值格式含空格分隔的日期时间）
    for (const input of document.querySelectorAll('input[placeholder*="日期"]')) {
      if (!this.isElementVisible(input)) continue;
      const ph = (input.placeholder || '').toLowerCase();
      if (ph.includes('日期') && ph.includes('时间') ||
          (input.value && input.value.includes(' ') && input.value.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/))) {
        input.focus(); input.click(); await this.delay(300);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, fullDatetime);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    // 策略2: 分开设置 date 和 time
    for (const input of document.querySelectorAll('input[type="date"], input[placeholder*="日期"], input[placeholder*="选择日期"]')) {
      if (!this.isElementVisible(input)) continue;
      input.focus(); input.click(); await this.delay(300);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, `${year}-${pad(month)}-${pad(day)}`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    for (const input of document.querySelectorAll('input[type="time"], input[type="datetime-local"], input[placeholder*="时间"], input[placeholder*="选择"]')) {
      if (!this.isElementVisible(input)) continue;
      const val = input.type === 'datetime-local' ? `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}` : `${pad(hour)}:${pad(minute)}`;
      input.focus(); input.click(); await this.delay(300);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    return true;
  }

  // ===== 星图任务 =====

  /**
   * 从文件名解析星图任务：匹配 "小游戏-xxx" 格式，去尾"推广"
   */
  parseTaskFromName(fileName) {
    const match = fileName.match(/^小游戏-(.+)/);
    if (!match) return null;
    const activityName = match[1].replace(/\.[^.]+$/, '');
    const searchTerm = activityName.replace(/推广$/, '').trim();
    if (!searchTerm) return null;
    return { activityName, searchTerm };
  }

  /**
   * 选择抖音星图任务（已验证可用的方法）
   *
   * 流程：
   * 1. 渐进式滚动页面触发 React 懒加载 → 找到"请选择星图任务"按钮
   * 2. reactClick 点击按钮 → 等待弹窗 + 搜索框出现
   * 3. 在搜索框中逐字符输入任务名（React 受控 input 需要 InputEvent）
   * 4. 等待搜索结果加载 → 在匹配行内找到 radio/circle 选择控件并点击
   * 5. 点击弹窗中的"确定"按钮
   *
   * 关键技术：
   * - React 懒加载：星图区域在页面底部，必须渐进式滚动触发渲染
   * - React onClick：原生 .click() 无效，必须通过 fiber 树找到 onClick 函数直接调用
   * - 搜索结果选择：选择控件（圆形 radio）在任务描述文字前面，需排除 modal 容器
   */
  async selectStarTask(searchTerm) {
    // 步骤0: 渐进式滚动触发 React 懒加载，同时尝试查找按钮
    let starBtn = null;
    const pageHeight = document.body.scrollHeight;
    const viewportH = window.innerHeight;
    for (let round = 0; round < 10; round++) {
      window.scrollTo({ top: Math.min((round + 1) * viewportH, pageHeight), behavior: 'instant' });
      await this.delay(800);

      starBtn = document.querySelector('[class*="star-btn"]');
      if (starBtn) break;
      for (const el of document.querySelectorAll('span, div')) {
        if (el.textContent?.trim() === '请选择星图任务' && this.isElementVisible(el)) { starBtn = el; break; }
      }
      if (starBtn) break;
      for (const el of document.querySelectorAll('[class*="star"]')) {
        if (this.isElementVisible(el) && (el.textContent || '').includes('星图') && el.getBoundingClientRect().width > 50) { starBtn = el; break; }
      }
      if (starBtn) break;
    }

    // 滚动后额外等待 + 重试（React 渲染可能滞后）
    if (!starBtn) {
      await this.delay(2000);
      for (let i = 0; i < 5; i++) {
        starBtn = document.querySelector('[class*="star-btn"]');
        if (starBtn) break;
        for (const el of document.querySelectorAll('span, div')) {
          if (el.textContent?.trim() === '请选择星图任务' && this.isElementVisible(el)) { starBtn = el; break; }
        }
        if (starBtn) break;
        await this.delay(1000);
      }
    }
    if (!starBtn) return false;

    // 点击星图任务按钮（必须用 reactClick 触发 React 合成事件）
    starBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this.delay(500);
    this.reactClick(starBtn);
    await this.delay(2000);

    // 步骤3: 查找搜索框（placeholder 含"任务"/"搜索"）
    let searchInput = null;
    for (let i = 0; i < 3; i++) {
      for (const inp of document.querySelectorAll('input[type="text"], input:not([type])')) {
        if (!this.isElementVisible(inp)) continue;
        const ph = (inp.placeholder || '').toLowerCase();
        if (ph.includes('搜索') || ph.includes('任务') || ph.includes('search')) {
          searchInput = inp; break;
        }
      }
      if (searchInput) break;
      await this.delay(1000);
    }
    if (!searchInput) return false;

    // 步骤4: 逐字符输入搜索词（React 受控 input 需要 InputEvent）
    searchInput.focus(); await this.delay(300);
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await this.delay(200);
    for (const char of searchTerm) {
      searchInput.value += char;
      searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      await this.delay(100);
    }
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));

    // 步骤5: 等待搜索结果加载（检测 loading 指示器消失）
    await this.delay(2000);
    for (let w = 0; w < 5; w++) {
      const loading = document.querySelector('[class*="loading"], [class*="skeleton"], [class*="spinner"]');
      if (!loading || !this.isElementVisible(loading)) break;
      await this.delay(1000);
    }
    await this.delay(1500);

    // 步骤6: 在匹配行中找到 radio/circle 选择控件并点击
    let selected = false;
    const excludeClass = ['semi-modal', 'modal', 'drawer', 'popover', 'popup'];
    for (const item of document.querySelectorAll('div, span, li, label')) {
      if (!this.isElementVisible(item)) continue;
      if (excludeClass.some(ex => (item.className || '').toLowerCase().includes(ex))) continue;
      const r = item.getBoundingClientRect();
      if (r.width < 30 || r.height < 10 || r.height > 200) continue;
      if (!(item.textContent || '').includes(searchTerm)) continue;
      if ((item.textContent || '').trim().length > 150) continue;

      // 在匹配行内查找选择控件：radio/circle/checkbox
      let ctrl = item.querySelector(
        'input[type="radio"], input[type="checkbox"], ' +
        '[class*="radio"], [class*="circle"], [class*="check"], [class*="Radio"], [class*="Check"]'
      );
      if (!ctrl && item.previousElementSibling) {
        const prevCls = (item.previousElementSibling.className || '').toLowerCase();
        if (prevCls.includes('radio') || prevCls.includes('circle') || prevCls.includes('check')) ctrl = item.previousElementSibling;
      }
      if (!ctrl) {
        const parent = item.parentElement;
        if (parent) ctrl = parent.querySelector('input[type="radio"], [class*="radio"], [class*="circle"], [class*="Radio"]');
      }
      if (ctrl) { this.reactClick(ctrl); selected = true; break; }

      // 回退：遍历所有 radio 元素，检查其容器是否含搜索词
      for (const radio of document.querySelectorAll('[class*="radio"], [class*="circle"], input[type="radio"]')) {
        if (!this.isElementVisible(radio)) continue;
        const rr = radio.getBoundingClientRect();
        if (rr.width < 10 || rr.width > 80) continue;
        const container = radio.closest('[class*="item"], [class*="row"], [class*="task"], li') || radio.parentElement;
        if (container && (container.textContent || '').includes(searchTerm)) { this.reactClick(radio); selected = true; break; }
      }
      if (selected) break;

      // 最终回退：点击整行
      this.reactClick(item); selected = true; break;
    }
    if (!selected) return false;
    await this.delay(1000);

    // 步骤7: 点击确认按钮
    for (const btn of document.querySelectorAll('button')) {
      if (!this.isElementVisible(btn)) continue;
      const text = (btn.textContent || '').trim();
      if (text === '确认' || text === '确定' || text === '完成' || text.includes('确认') || text.includes('确定')) {
        this.reactClick(btn);
        await this.delay(1000);
        return true;
      }
    }
    return true;
  }

  /**
   * 可靠的 React 元素点击
   * React 通过事件委托在根节点监听，原生 .click() 可能无法触发 onClick
   * 解决方案：
   *   1. 遍历 React fiber 树找到 memoizedProps.onClick 直接调用
   *   2. 回退：派发完整 PointerEvent + MouseEvent 序列
   */
  reactClick(el) {
    if (!el) return false;
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (fiberKey) {
      let fiber = el[fiberKey];
      for (let depth = 0; depth < 10 && fiber; depth++) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props && typeof props.onClick === 'function') {
          props.onClick({ target: el, currentTarget: el, preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click') });
          return true;
        }
        fiber = fiber.return;
      }
    }
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const publisher = new DouyinPublisher();
