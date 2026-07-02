/**
 * 抖音发布助手 - Content Script
 *
 * 负责：
 * 1. 接收 background 的发布命令
 * 2. 在抖音创作者页面上传视频
 * 3. AI 生成文案和话题（与上传并行）
 * 4. 填写表单并点击发布
 * 5. 通知 background 发布结果
 *
 * 流程顺序：
 * 1. 等待页面加载
 * 2. 找到 file input 并上传
 * 3. 并行：AI 生成文案（不阻塞上传）
 * 4. 动态检测上传完成（轮询表单出现）
 * 5. 填写描述 + 话题（带重试）
 * 6. 定时发布（如果开启）
 * 7. 点击发布
 * 8. 检测发布完成
 */
class DouyinPublisher {
  constructor() {
    this.isReady = false;
    this.defaultTopics = ['#动画', '#奇葩游戏', '#游戏视频', '#小游戏', '#休闲游戏'];
    this.init();
  }

  init() {
    console.log('[抖音发布助手] 初始化中...');

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[抖音发布助手] 收到消息:', message.action);

      if (message.action === 'startPublish') {
        this.publishSingleVideo(message.videos[0], message.settings, message.videoPath, message.videoIndex, message.totalVideos)
          .then(() => {
            this.notifyProgress('发布完成', message.videoIndex + 1, message.totalVideos, 'done');
            sendResponse({ success: true });
          })
          .catch(error => {
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
    });

    this.isReady = true;
    console.log('[抖音发布助手] 初始化完成');
  }

  async publishSingleVideo(video, settings, videoPath, videoIndex, totalVideos) {
    const idx = videoIndex + 1;
    const step = (msg) => console.log(`[抖音发布助手] [${idx}/${totalVideos}] ${msg}`);
    step(`开始发布: ${video.name}`);

    // ── 步骤1: 等待页面加载 ──
    step('等待页面加载...');
    this.notifyProgress('等待页面加载...', idx, totalVideos);
    await this.waitForPageReady();
    await this.delay(1500);
    step('页面加载完成');

    // ── 解析文件名，提取活动任务名 ──
    const taskInfo = this.parseTaskFromName(video.name);
    if (taskInfo) {
      step(`检测到星图任务: ${taskInfo.searchTerm} (原始: ${taskInfo.activityName})`);
    }

    // ── 步骤2: 查找上传入口 ──
    step('查找上传入口...');
    this.notifyProgress('查找上传入口...', idx, totalVideos);
    const uploadInput = await this.findUploadInput();
    if (!uploadInput) {
      throw new Error('未找到上传入口，请确保在正确的发布页面');
    }
    step('找到上传入口');

    // ── 步骤3: 上传视频 + 并行 AI 生成 ──
    step('获取视频文件...');
    this.notifyProgress('获取视频文件...', idx, totalVideos);
    const file = await this.getVideoFile(videoPath, video.name);
    if (!file) throw new Error('无法获取视频文件');
    step(`视频大小: ${(file.size / 1024 / 1024).toFixed(1)}MB`);

    step('上传视频中...');
    this.notifyProgress('上传视频中...', idx, totalVideos);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([file], video.name, { type: 'video/mp4' }));
    uploadInput.files = dataTransfer.files;
    uploadInput.dispatchEvent(new Event('change', { bubbles: true }));

    // 并行启动 AI 生成（不阻塞上传等待）
    let aiPromise = null;
    if (settings.autoGenerate) {
      step('AI 生成文案中（后台并行）...');
      this.notifyProgress('AI 生成文案中...', idx, totalVideos);
      aiPromise = this.generateAIContent(video.name, settings);
    }

    // 动态检测上传完成：轮询发布表单是否出现，最多等60秒
    step('等待视频上传完成...');
    this.notifyProgress('等待视频处理...', idx, totalVideos);
    const uploadOk = await this.waitForUploadComplete(60);
    if (!uploadOk) step('上传检测超时，尝试继续...');
    else step('视频上传完成');

    // 等待表单稳定
    await this.delay(1500);
    step('发布表单已就绪');

    // ── 步骤4: 定时发布 ──
    if (settings.scheduledPublish && settings.scheduleTime) {
      step('设置定时发布...');
      this.notifyProgress('设置定时发布...', idx, totalVideos);
      await this.setScheduledPublish(settings.scheduleTime);
      await this.delay(500);
      step('定时发布设置完成');
    }

    // ── 步骤5: 选择星图任务 ──
    if (taskInfo) {
      step(`选择星图任务: ${taskInfo.searchTerm}`);
      this.notifyProgress('选择星图任务...', idx, totalVideos);
      const taskOk = await this.selectStarTask(taskInfo.searchTerm);
      step(`星图任务${taskOk ? '选择成功' : '选择失败'}`);
      await this.delay(500);
    }

    // ── 步骤6: 获取 AI 结果 ──
    let aiContent = { topics: [], description: '' };
    if (settings.autoGenerate && aiPromise) {
      try {
        aiContent = await aiPromise;
        step(`AI 结果: 描述="${aiContent.description?.substring(0,30)}" 话题=${JSON.stringify(aiContent.topics)}`);
      } catch (e) {
        step(`AI 生成失败: ${e.message}`);
      }
    }

    // ── 步骤7: 填写描述（带重试） ──
    if (settings.autoGenerate && aiContent.description) {
      step('填写描述...');
      this.notifyProgress('填写描述文案...', idx, totalVideos);
      let descOk = await this.fillDescription(aiContent.description);
      if (!descOk) {
        step('描述填写失败，重试...');
        await this.delay(500);
        descOk = await this.fillDescription(aiContent.description);
      }
      step(`描述填写${descOk ? '成功' : '失败'}`);
      await this.delay(500);
    }

    // ── 步骤8: 填写话题 ──
    let topicsToFill = [];
    if (settings.autoGenerate && aiContent.topics?.length > 0) {
      // AI 话题优先
      topicsToFill = aiContent.topics.slice(0, 5);
    } else if (taskInfo) {
      // 有星图任务但没开 AI → 只填 "#抖音小游戏"
      topicsToFill = ['#抖音小游戏'];
    } else {
      // 无任务无 AI → 默认话题
      topicsToFill = this.defaultTopics;
    }

    if (topicsToFill.length > 0) {
      step(`填写话题: ${topicsToFill.join(', ')}`);
      this.notifyProgress('填写话题标签...', idx, totalVideos);
      let topicOk = await this.fillTopics(topicsToFill);
      if (!topicOk) {
        step('话题填写失败，重试...');
        await this.delay(500);
        topicOk = await this.fillTopics(topicsToFill);
      }
      step(`话题填写${topicOk ? '成功' : '失败'}`);
      await this.delay(500);
    }

    // ── 步骤9: 点击发布 ──
    await this.delay(500);
    step('点击发布...');
    this.notifyProgress('点击发布...', idx, totalVideos);
    const publishResult = await this.clickPublish();
    step(`发布按钮${publishResult ? '已点击' : '点击失败'}`);

    // ── 步骤10: 等待发布完成 ──
    await this.delay(3000);
    step('发布流程完成');

    // 通知 background 保存发布记录
    chrome.runtime.sendMessage({
      action: 'douyinPublishDone',
      videoName: video.name,
      videoPath: videoPath,
      scheduled: settings.scheduledPublish || false
    }).catch(() => {});
  }

  // ===== 页面等待 =====

  async waitForPageReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve);
    });
  }

  /**
   * 动态检测上传完成
   * 轮询 contenteditable / textarea / editor 元素是否出现
   * 出现即表示上传完成、表单已加载
   */
  async waitForUploadComplete(maxSeconds) {
    const maxMs = maxSeconds * 1000;
    const interval = 1000;
    let waited = 0;

    while (waited < maxMs) {
      const editors = document.querySelectorAll(
        '[contenteditable="true"], textarea, [class*="editor"], [class*="Editor"], [class*="desc"], [class*="Desc"]'
      );
      for (const el of editors) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          console.log(`[抖音发布助手] 上传完成检测: ${(waited/1000).toFixed(1)}秒`);
          return true;
        }
      }
      await this.delay(interval);
      waited += interval;
    }
    console.log(`[抖音发布助手] 上传检测超时: ${maxSeconds}秒`);
    return false;
  }

  // ===== 上传入口查找 =====

  /**
   * 查找 file input 元素
   * 优先匹配 accept 含 video 的 input，兜底匹配所有 file input
   * 每 500ms 重试，最多 10 次
   */
  async findUploadInput() {
    const selectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*=".mp4"]',
      'input[type="file"][accept*=".mov"]',
      'input[type="file"][accept*=".flv"]',
      'input[type="file"]'
    ];

    for (let attempt = 0; attempt < 10; attempt++) {
      for (const selector of selectors) {
        const inputs = document.querySelectorAll(selector);
        for (const input of inputs) {
          if (input && input.type === 'file') {
            console.log('[抖音发布助手] 找到上传输入框:', selector, 'attempt:', attempt);
            return input;
          }
        }
      }

      // 兜底：遍历所有 input
      const allInputs = document.querySelectorAll('input');
      for (const input of allInputs) {
        if (input.type === 'file') {
          console.log('[抖音发布助手] 通过遍历找到文件输入框');
          return input;
        }
      }

      await this.delay(500);
    }

    console.error('[抖音发布助手] 未找到上传入口，页面DOM数量:', document.querySelectorAll('*').length);
    return null;
  }

  // ===== 视频文件获取 =====

  async getVideoFile(videoPath, videoName) {
    const fullPath = videoPath.endsWith('/')
      ? `${videoPath}${videoName}`
      : `${videoPath}/${videoName}`;

    console.log('[抖音发布助手] 获取视频文件:', fullPath);

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
          console.error('[抖音发布助手] AI生成错误:', chrome.runtime.lastError);
          resolve({ topics: [], description: '', error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { topics: [], description: '' });
        }
      });
    });
  }

  // ===== 描述填写 =====

  /**
   * 查找主编辑器（排除标签输入框）
   * 策略：找面积最大的 contenteditable，排除 placeholder 含"话题"的
   */
  findMainEditor() {
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    const candidates = [];
    for (const el of allEditable) {
      if (!this.isElementVisible(el)) continue;
      const cls = el.className || '';
      const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const isTagInput = placeholder.includes('话题') || placeholder.includes('tag') ||
                         placeholder.includes('搜索') || placeholder.includes('Tag') ||
                         cls.includes('tag') || cls.includes('Tag') ||
                         cls.includes('topic') || cls.includes('Topic');
      if (isTagInput) continue;
      candidates.push({ el, area });
    }
    candidates.sort((a, b) => b.area - a.area);
    return candidates[0]?.el || null;
  }

  async fillDescription(description) {
    console.log('[抖音发布助手] 尝试填写描述...');

    const editor = this.findMainEditor();
    if (editor) {
      console.log('[抖音发布助手] 找到主编辑器，填写描述');
      editor.focus();
      await this.delay(100);
      editor.click();
      await this.delay(100);
      editor.innerHTML = '';
      document.execCommand('insertText', false, description);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[抖音发布助手] 描述填写完成');
      return true;
    }

    const textareas = document.querySelectorAll('textarea');
    for (const textarea of textareas) {
      if (this.isElementVisible(textarea)) {
        console.log('[抖音发布助手] 找到textarea，填写描述');
        textarea.focus();
        textarea.value = description;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    console.log('[抖音发布助手] 未找到描述输入框');
    return false;
  }

  // ===== 话题填写 =====

  /**
   * 查找话题/标签输入框
   * 优先匹配 placeholder 含"话题""tag""搜索"的元素
   * 兜底：找最小的 contenteditable
   */
  findTagInput() {
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    for (const el of allEditable) {
      if (!this.isElementVisible(el)) continue;
      const cls = el.className || '';
      const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
      const isTagInput = placeholder.includes('话题') || placeholder.includes('tag') ||
                         placeholder.includes('搜索') || placeholder.includes('Tag') ||
                         cls.includes('tag') || cls.includes('Tag') ||
                         cls.includes('topic') || cls.includes('Topic') ||
                         placeholder.includes('#');
      if (isTagInput) return el;
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
    console.log('[抖音发布助手] 尝试填写话题:', topics);
    const topicText = topics.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');

    // 先找话题专用输入框
    const tagInput = this.findTagInput();
    if (tagInput) {
      console.log('[抖音发布助手] 找到话题输入框，填写话题');
      tagInput.focus();
      await this.delay(100);
      tagInput.click();
      await this.delay(100);
      document.execCommand('insertText', false, topicText + ' ');
      tagInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log('[抖音发布助手] 话题填写完成');
      return true;
    }

    // 兜底：追加到主编辑器末尾
    const editor = this.findMainEditor();
    if (editor) {
      console.log('[抖音发布助手] 追加话题到主编辑器末尾');
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
      console.log('[抖音发布助手] 话题追加完成');
      return true;
    }

    console.log('[抖音发布助手] 未找到填写话题的位置');
    return false;
  }

  // ===== 工具方法 =====

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
   * 查找并点击发布按钮
   * 优先级：发布/发表 > 立即发布 > 含"发布"的其他按钮
   * 排除：高清、定时相关按钮
   */
  async clickPublish() {
    console.log('[抖音发布助手] 查找发布按钮...');

    const allButtons = document.querySelectorAll('button');
    const publishButtons = [];

    for (const btn of allButtons) {
      const text = (btn.textContent || '').trim();

      if (this.isElementVisible(btn) && !btn.disabled) {
        if (text === '发布' || text === '发表') {
          publishButtons.push({ btn, text, priority: 1 });
        } else if (text === '立即发布' || text === '立即发表') {
          publishButtons.push({ btn, text, priority: 2 });
        } else if (text.includes('发布') && !text.includes('高清') && !text.includes('定时')) {
          publishButtons.push({ btn, text, priority: 3 });
        }
      }
    }

    publishButtons.sort((a, b) => a.priority - b.priority);

    if (publishButtons.length > 0) {
      const { btn, text } = publishButtons[0];
      console.log('[抖音发布助手] 找到发布按钮:', text);
      btn.click();
      return true;
    }

    console.log('[抖音发布助手] 未找到合适的发布按钮');
    return false;
  }

  // ===== 进度通知 =====

  /**
   * 通知 popup 更新进度条
   * 同时发送 publishProgress（兼容旧逻辑）和 progressUpdate（popup 进度条）
   */
  notifyProgress(step, current, total, status) {
    try {
      chrome.runtime.sendMessage({
        action: 'publishProgress',
        status: step,
        current, total
      }).catch(() => {});
      chrome.runtime.sendMessage({
        action: 'progressUpdate',
        step: step,
        detail: status || 'publishing',
        current: current,
        total: total,
        videoIndex: current - 1,
        status: status || 'publishing'
      }).catch(() => {});
    } catch (e) {
      console.log('[抖音发布助手] 通知进度失败:', e);
    }
  }

  // ===== 定时发布 =====

  /**
   * 查找定时发布选项并设置时间
   * 1. 找"定时发布"文字，点击其父级开关
   * 2. 找时间输入框，设置值
   */
  async setScheduledPublish(scheduleTime) {
    console.log('====== [抖音定时发布 DEBUG] ======');
    console.log('[抖音定时] 输入 scheduleTime:', scheduleTime);

    // 手动解析时间字符串，避免时区问题
    const parts = scheduleTime.replace('T', ' ').split(' ');
    const datePart = parts[0];
    const timePart = parts[1] || '00:00';
    const [year, month, day] = datePart.split('-');
    const [hour, minute] = timePart.split(':');
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${year}-${pad(month)}-${pad(day)}`;
    const timeStr = `${pad(hour)}:${pad(minute)}`;
    console.log('[抖音定时] 解析结果 - 日期:', dateStr, '时间:', timeStr);

    // 查找定时发布开关
    const allElements = document.querySelectorAll('*');
    let scheduleToggle = null;

    for (const el of allElements) {
      if (!this.isElementVisible(el)) continue;
      const text = el.textContent?.trim() || '';
      if (text === '定时发布' || text === '定时' || text === '预约发布') {
        let target = el;
        for (let i = 0; i < 5; i++) {
          if (target.tagName === 'BUTTON' || target.tagName === 'LABEL' ||
              target.tagName === 'INPUT' || target.getAttribute('role') === 'switch' ||
              target.getAttribute('role') === 'checkbox' || target.onclick) {
            scheduleToggle = target;
            break;
          }
          target = target.parentElement;
          if (!target) break;
        }
        if (!scheduleToggle) scheduleToggle = el;
        break;
      }
    }

    if (!scheduleToggle) {
      const switches = document.querySelectorAll('[role="switch"], [class*="switch"], [class*="Switch"], [class*="toggle"], [class*="Toggle"]');
      for (const sw of switches) {
        if (sw.textContent?.includes('定时') || sw.parentElement?.textContent?.includes('定时')) {
          scheduleToggle = sw;
          break;
        }
      }
    }

    if (!scheduleToggle) {
      console.log('[抖音定时] 未找到定时发布选项');
      console.log('====== DEBUG END ======');
      return false;
    }

    console.log('[抖音定时] 找到定时开关，点击开启...');
    scheduleToggle.click();
    await this.delay(1500);

    // dump 所有可见 input 元素
    const allInputs = document.querySelectorAll('input');
    console.log('[抖音定时] 页面 input 总数:', allInputs.length);
    for (const inp of allInputs) {
      if (!this.isElementVisible(inp)) continue;
      const rect = inp.getBoundingClientRect();
      console.log(`[抖音定时]   input type=${inp.type} placeholder="${inp.placeholder}" class="${(inp.className||'').substring(0,80)}" value="${inp.value}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }

    const fullDatetime = `${dateStr} ${timeStr}`;
    console.log('[抖音定时] 目标完整日期时间:', fullDatetime);
    let didSet = false;

    // 策略1: 联合日期时间 input（如 placeholder="日期和时间"），一次性设完整值
    // 抖音的日期和时间可能是同一个 input，格式 YYYY-MM-DD HH:MM
    const combinedInputs = document.querySelectorAll('input[placeholder*="日期"]');
    for (const input of combinedInputs) {
      if (!this.isElementVisible(input)) continue;
      const ph = (input.placeholder || '').toLowerCase();
      // 同时包含"日期"和"时间"的，或值格式含空格的（如 2026-07-01 20:40），说明是联合 input
      if (ph.includes('日期') && ph.includes('时间') || (input.value && input.value.includes(' ') && input.value.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/))) {
        console.log('[抖音定时] 发现联合日期时间 input:', input.placeholder, '当前值:', input.value);
        input.focus();
        input.click();
        await this.delay(300);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, fullDatetime);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[抖音定时] 联合设置后 value:', input.value);
        didSet = true;
        break;
      }
    }
    if (didSet) {
      console.log('[抖音定时] 联合设置成功，跳过分开设置');
      console.log('====== DEBUG END ======');
      return true;
    }

    // 策略2: 分开设置 date 和 time input（兼容旧版抖音）
    let dateSet = false;
    const dateInputs = document.querySelectorAll('input[type="date"], input[placeholder*="日期"], input[placeholder*="选择日期"]');
    for (const input of dateInputs) {
      if (!this.isElementVisible(input)) continue;
      console.log('[抖音定时] 设置日期:', dateStr, '到', input.type, input.placeholder);
      input.focus();
      input.click();
      await this.delay(300);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, dateStr);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[抖音定时] 日期设置后 value:', input.value);
      dateSet = true;
      break;
    }
    if (!dateSet) console.log('[抖音定时] 未找到日期输入框');

    let timeSet = false;
    const timeInputs = document.querySelectorAll('input[type="time"], input[type="datetime-local"], input[placeholder*="时间"], input[placeholder*="选择"]');
    for (const input of timeInputs) {
      if (!this.isElementVisible(input)) continue;
      const val = input.type === 'datetime-local' ? `${dateStr}T${timeStr}` : timeStr;
      console.log('[抖音定时] 设置时间:', val, '到', input.type, input.placeholder);
      input.focus();
      input.click();
      await this.delay(300);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[抖音定时] 时间设置后 value:', input.value);
      timeSet = true;
      break;
    }
    if (!timeSet) {
      const pickerInputs = document.querySelectorAll('[class*="picker"] input, [class*="Picker"] input, [class*="calendar"] input');
      for (const input of pickerInputs) {
        if (!this.isElementVisible(input)) continue;
        const dateTimeStr = `${dateStr} ${timeStr}`;
        console.log('[抖音定时] 设置 picker:', dateTimeStr);
        input.focus();
        input.click();
        await this.delay(300);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, dateTimeStr);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[抖音定时] picker 设置后 value:', input.value);
        timeSet = true;
        break;
      }
    }

    console.log('[抖音定时] 日期设置:', dateSet ? '成功' : '失败', '时间设置:', timeSet ? '成功' : '失败');
    console.log('====== DEBUG END ======');
    return dateSet || timeSet;
  }

  // ===== 星图任务 =====

  /**
   * 从文件名解析星图任务信息
   * 匹配 "小游戏-xxx" 格式，提取 xxx 作为活动任务名
   * 如果 xxx 以"推广"结尾，搜索时去掉"推广"
   */
  parseTaskFromName(fileName) {
    const match = fileName.match(/^小游戏-(.+)/);
    if (!match) return null;
    const activityName = match[1].replace(/\.[^.]+$/, ''); // 去掉扩展名
    // 搜索关键词：去掉末尾的"推广"
    const searchTerm = activityName.replace(/推广$/, '').trim();
    if (!searchTerm) return null;
    console.log(`[抖音发布助手] 解析任务: "${activityName}" → 搜索: "${searchTerm}"`);
    return { activityName, searchTerm };
  }

  /**
   * 选择抖音星图任务
   * 1. 找到"星图任务"按钮并点击
   * 2. 在弹窗搜索框中输入任务名
   * 3. 等待列表刷新，选择匹配项
   * 4. 点击确认按钮
   */
  async selectStarTask(searchTerm) {
    console.log('====== [星图任务 DEBUG] ======');
    console.log('[星图] 搜索词:', searchTerm);

    // 步骤1: 点击"请选择星图任务"按钮（.star-btn）
    console.log('[星图] === 步骤1: 查找并点击星图任务按钮 ===');

    // 策略1: 找 class 含 star-btn 的元素（最精准）
    let starBtn = document.querySelector('[class*="star-btn"]');

    // 策略2: 找包含"请选择星图任务"文本的可点击元素
    if (!starBtn) {
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (!this.isElementVisible(el)) continue;
        const text = (el.textContent || '').trim();
        if (text.includes('请选择星图任务') || text === '星图任务') {
          const cls = (el.className || '').toLowerCase();
          if (cls.includes('star-btn') || cls.includes('star_btn') || cls.includes('star_btn_active')) {
            starBtn = el;
            break;
          }
        }
      }
    }

    // 策略3: 找标题"星图任务"的兄弟元素"请选择星图任务"
    if (!starBtn) {
      const allSpans = document.querySelectorAll('span, div');
      for (const el of allSpans) {
        if (!this.isElementVisible(el)) continue;
        const text = (el.textContent || '').trim();
        if (text === '请选择星图任务' || (text.includes('请选择') && text.includes('星图任务'))) {
          const r = el.getBoundingClientRect();
          if (r.width > 50) {
            starBtn = el;
            break;
          }
        }
      }
    }

    if (!starBtn) {
      console.log('[星图] 未找到星图任务按钮');
      console.log('====== [星图 DEBUG END] ======');
      return false;
    }

    const btnInfo = { tag: starBtn.tagName, text: (starBtn.textContent||'').substring(0,40), cls: (starBtn.className||'').substring(0,80) };
    console.log('[星图] 找到按钮:', JSON.stringify(btnInfo));
    console.log('[星图] 点击按钮...');
    starBtn.click();
    await this.delay(2000);

    // 步骤2: 等待并 dump 弹窗
    console.log('[星图] === 步骤2: 等待弹窗出现 ===');

    // 等待最多 5 秒找新出现的弹窗（可能 class 含 modal/dialog/drawer/popover/semi-modal）
    for (let wait = 0; wait < 5; wait++) {
      const modals = document.querySelectorAll(
        '[class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [class*="drawer"], [class*="Drawer"], [class*="popover"], [class*="Popover"], [class*="semi-modal"], [class*="popup"], [class*="Popup"]'
      );
      for (const m of modals) {
        if (this.isElementVisible(m)) {
          console.log('[星图] 发现弹窗:', m.tagName, 'class:', (m.className||'').substring(0,80));
          // dump 弹窗内的 input
          const inputs = m.querySelectorAll('input');
          for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            console.log(`[星图] 弹窗内 input: type="${inp.type}" placeholder="${inp.placeholder}" ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
      }
      // dump 所有可见 input
      const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
      for (const inp of allInputs) {
        if (!this.isElementVisible(inp)) continue;
        const r = inp.getBoundingClientRect();
        const ph = inp.placeholder || '';
        if (ph.includes('搜索') || ph.includes('任务') || ph.includes('search') || ph.includes('查找')) {
          console.log(`[星图] 找到搜索框: placeholder="${ph}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      // dump 含关键词文本
      const allTextEls = document.querySelectorAll('*');
      for (const el of allTextEls) {
        if (!this.isElementVisible(el)) continue;
        const text = (el.textContent || '').trim();
        if (text.length > 0 && text.length < 60 && el.children.length <= 2) {
          if (text.includes('搜索') || text.includes('确认') || text.includes('确定') ||
              text.includes('选择') || text.includes('取消') || text.includes('关闭') ||
              text.includes('关联') || text.includes('星图') || text.includes('任务')) {
            const r = el.getBoundingClientRect();
            console.log(`[星图] 文本: <${el.tagName}> "${text}" class="${(el.className||'').substring(0,60)}" ${Math.round(r.width)}x${Math.round(r.height)} @(${Math.round(r.x)},${Math.round(r.y)})`);
          }
        }
      }
      if (wait < 4) await this.delay(1000);
    }

    // 步骤3: 查找搜索框
    console.log('[星图] === 步骤3: 查找搜索框 ===');
    let searchInput = null;
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const inp of inputs) {
      if (!this.isElementVisible(inp)) continue;
      const ph = (inp.placeholder || '').toLowerCase();
      if (ph.includes('搜索') || ph.includes('任务') || ph.includes('search') || ph.includes('查找')) {
        searchInput = inp;
        console.log('[星图] 匹配搜索框:', inp.placeholder);
        break;
      }
    }

    if (!searchInput) {
      console.log('[星图] 未找到搜索框，跳过');
      console.log('====== [星图 DEBUG END] ======');
      return false;
    }

    // 步骤4: 输入搜索词
    console.log('[星图] === 步骤4: 输入搜索词 ===');
    searchInput.focus();
    await this.delay(300);
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await this.delay(200);
    for (const char of searchTerm) {
      searchInput.value += char;
      searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      await this.delay(100);
    }
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[星图] 输入完成:', searchInput.value);
    await this.delay(3000);

    // 步骤5: 选择任务
    console.log('[星图] === 步骤5: 选择任务 ===');
    let selected = false;
    const clickables = document.querySelectorAll('[class*="option"], [class*="item"], [class*="task"], li, [role="option"]');
    for (const item of clickables) {
      if (!this.isElementVisible(item)) continue;
      const text = (item.textContent || '').trim();
      if (text.includes(searchTerm)) {
        console.log('[星图] 匹配选择:', text.substring(0,50));
        item.click();
        selected = true;
        break;
      }
    }
    if (!selected) {
      const allDivs = document.querySelectorAll('div, span');
      for (const el of allDivs) {
        if (!this.isElementVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.height > 60) continue;
        const text = (el.textContent || '').trim();
        if (text.includes(searchTerm) && text.length < 80 && el.children.length <= 3) {
          console.log('[星图] 模糊匹配:', text.substring(0,50));
          el.click();
          selected = true;
          break;
        }
      }
    }

    if (!selected) {
      console.log('[星图] 未找到匹配任务');
      console.log('====== [星图 DEBUG END] ======');
      return false;
    }
    await this.delay(1000);

    // 步骤6: 确认
    console.log('[星图] === 步骤6: 确认按钮 ===');
    const confirmBtns = document.querySelectorAll('button');
    for (const btn of confirmBtns) {
      if (!this.isElementVisible(btn)) continue;
      const text = (btn.textContent || '').trim();
      if (text === '确认' || text === '确定' || text === '完成' ||
          text.includes('确认') || text.includes('确定')) {
        console.log('[星图] 点击确认:', text);
        btn.click();
        await this.delay(1000);
        console.log('====== [星图 DEBUG END] ======');
        return true;
      }
    }

    // 如果没有明确的确认按钮，可能选择了就自动关闭
    console.log('[星图] 未找到确认按钮，可能已自动选择');
    console.log('====== [星图 DEBUG END] ======');
    return true;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

console.log('[抖音发布助手] 脚本加载');
const publisher = new DouyinPublisher();
