class DouyinPublisher {
  constructor() {
    this.isReady = false;
    this.init();
  }

  init() {
    console.log('[抖音发布助手] 初始化中...');
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[抖音发布助手] 收到消息:', message.action);
      
      if (message.action === 'startPublish') {
        this.publishSingleVideo(message.videos[0], message.settings, message.videoPath, message.videoIndex, message.totalVideos)
          .then(() => {
            this.notifyProgress(message.videoIndex + 1, message.totalVideos, message.videos[0].name, 'done');
            sendResponse({ success: true });
          })
          .catch(error => {
            console.error('[抖音发布助手] 发布失败:', error);
            this.notifyProgress(message.videoIndex + 1, message.totalVideos, message.videos[0].name, 'error');
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
    console.log(`[抖音发布助手] 发布视频 ${idx}/${totalVideos}: ${video.name}`);
    this.notifyProgress('等待页面加载...');

    await this.waitForPageReady();
    await this.delay(2000);

    console.log('[抖音发布助手] 查找上传入口...');
    this.notifyProgress('查找上传入口...');
    const uploadInput = await this.findUploadInput();
    if (!uploadInput) {
      throw new Error('未找到上传入口，请确保在正确的发布页面');
    }
    console.log('[抖音发布助手] 找到上传入口');

    console.log('[抖音发布助手] 获取视频文件...');
    this.notifyProgress('获取视频文件...');
    const file = await this.getVideoFile(videoPath, video.name);
    if (!file) {
      throw new Error('无法获取视频文件');
    }
    console.log('[抖音发布助手] 视频文件获取成功，大小:', file.size);

    console.log('[抖音发布助手] 上传视频...');
    this.notifyProgress('上传视频中...');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([file], video.name, { type: 'video/mp4' }));
    uploadInput.files = dataTransfer.files;
    uploadInput.dispatchEvent(new Event('change', { bubbles: true }));

    console.log('[抖音发布助手] 等待视频上传和处理（约15秒）...');
    this.notifyProgress('等待视频处理...');
    await this.delay(15000);

    console.log('[抖音发布助手] 等待发布表单加载...');
    this.notifyProgress('等待表单加载...');
    await this.waitForPublishForm();
    await this.delay(2000);

    // 定时发布设置
    if (settings.scheduledPublish && settings.scheduleTime) {
      console.log('[抖音发布助手] 设置定时发布:', settings.scheduleTime);
      this.notifyProgress('设置定时发布...');
      await this.setScheduledPublish(settings.scheduleTime);
      await this.delay(500);
    }

    let aiContent = { topics: [], description: '' };
    if (settings.autoGenerate) {
      console.log('[抖音发布助手] 生成AI内容...');
      this.notifyProgress('等待 AI 生成文案...');
      aiContent = await this.generateAIContent(video.name, settings);
      console.log('[抖音发布助手] AI内容:', JSON.stringify(aiContent));

      if (aiContent.error) {
        console.error('[抖音发布助手] AI生成错误:', aiContent.error);
      }
    }

    if (settings.autoGenerate && aiContent.description) {
      console.log('[抖音发布助手] 填写描述:', aiContent.description);
      this.notifyProgress('填写描述文案...');
      const descResult = await this.fillDescription(aiContent.description);
      console.log('[抖音发布助手] 描述填写结果:', descResult);
      await this.delay(500);
    }

    if (settings.autoGenerate && aiContent.topics && aiContent.topics.length > 0) {
      const topics = aiContent.topics.slice(0, 5);
      console.log('[抖音发布助手] 填写话题:', topics);
      this.notifyProgress('填写话题标签...');
      const topicResult = await this.fillTopics(topics);
      console.log('[抖音发布助手] 话题填写结果:', topicResult);
      await this.delay(500);
    }

    await this.delay(1000);
    console.log('[抖音发布助手] 点击发布按钮...');
    this.notifyProgress('点击发布...');
    const publishResult = await this.clickPublish();
    console.log('[抖音发布助手] 发布按钮点击结果:', publishResult);

    await this.delay(2000);
    console.log('[抖音发布助手] 视频发布完成');
  }

  async waitForPageReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'complete') {
        resolve();
      } else {
        window.addEventListener('load', resolve);
      }
    });
  }

  async waitForPublishForm() {
    console.log('[抖音发布助手] 等待发布表单出现...');
    
    for (let i = 0; i < 30; i++) {
      const formElements = document.querySelectorAll([
        '[class*="editor"]',
        '[class*="Editor"]',
        '[contenteditable="true"]',
        'textarea'
      ].join(', '));
      
      if (formElements.length > 0) {
        console.log('[抖音发布助手] 找到表单元素:', formElements.length);
        return true;
      }
      
      await this.delay(500);
    }
    
    console.log('[抖音发布助手] 等待表单超时，继续尝试...');
    return false;
  }

  async findUploadInput() {
    const selectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*=".mp4"]',
      'input[type="file"][accept*=".mov"]',
      'input[type="file"][accept*=".flv"]',
      'input[type="file"]'
    ];

    for (let attempt = 0; attempt < 15; attempt++) {
      for (const selector of selectors) {
        const inputs = document.querySelectorAll(selector);
        for (const input of inputs) {
          if (input && input.type === 'file') {
            console.log('[抖音发布助手] 找到上传输入框:', selector, 'attempt:', attempt);
            return input;
          }
        }
      }

      const allInputs = document.querySelectorAll('input');
      for (const input of allInputs) {
        if (input.type === 'file') {
          console.log('[抖音发布助手] 通过遍历找到文件输入框');
          return input;
        }
      }

      await this.delay(1000);
    }

    console.error('[抖音发布助手] 未找到上传入口，页面DOM数量:', document.querySelectorAll('*').length);
    return null;
  }

  async getVideoFile(videoPath, videoName) {
    const fullPath = videoPath.endsWith('/') 
      ? `${videoPath}${videoName}` 
      : `${videoPath}/${videoName}`;
    
    console.log('[抖音发布助手] 获取视频文件:', fullPath);
    
    try {
      const response = await fetch(`http://localhost:3000/api/video/file?path=${encodeURIComponent(fullPath)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      return blob;
    } catch (error) {
      console.error('[抖音发布助手] 获取视频文件失败:', error);
      return null;
    }
  }

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

  findMainEditor() {
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    const candidates = [];
    for (const el of allEditable) {
      if (!this.isElementVisible(el)) continue;
      const cls = el.className || '';
      const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      // 排除话题/标签输入框（通常很小，或 placeholder 含"话题""tag""搜索"）
      const isTagInput = placeholder.includes('话题') || placeholder.includes('tag') ||
                         placeholder.includes('搜索') || placeholder.includes('Tag') ||
                         cls.includes('tag') || cls.includes('Tag') ||
                         cls.includes('topic') || cls.includes('Topic');
      if (isTagInput) continue;
      candidates.push({ el, area, placeholder, cls });
    }
    // 选面积最大的 contenteditable（主编辑器通常最大）
    candidates.sort((a, b) => b.area - a.area);
    return candidates[0]?.el || null;
  }

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
    // 兜底：找最小的 contenteditable
    const all = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(el => this.isElementVisible(el));
    if (all.length > 1) {
      all.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) -
                          (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
      return all[0];
    }
    return null;
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

  isElementVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           element.offsetWidth > 0 && 
           element.offsetHeight > 0;
  }

  async clickPublish() {
    console.log('[抖音发布助手] 查找发布按钮...');
    
    const allButtons = document.querySelectorAll('button');
    console.log('[抖音发布助手] 找到按钮数量:', allButtons.length);
    
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

  notifyProgress(step) {
    try {
      chrome.runtime.sendMessage({
        action: 'publishProgress',
        status: step
      });
      // 同时通知 popup 更新进度条
      chrome.runtime.sendMessage({
        action: 'progressUpdate',
        step: step,
        detail: 'publishing'
      }).catch(() => {});
    } catch (e) {
      console.log('[抖音发布助手] 通知进度失败:', e);
    }
  }

  async setScheduledPublish(scheduleTime) {
    console.log('[抖音发布助手] 查找定时发布选项...');

    // 查找"定时发布"文字或相关选项
    const allElements = document.querySelectorAll('*');
    let scheduleToggle = null;

    for (const el of allElements) {
      if (!this.isElementVisible(el)) continue;
      const text = el.textContent?.trim() || '';
      if (text === '定时发布' || text === '定时' || text === '预约发布') {
        // 找到文字，向上找可点击的开关/按钮
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
      // 尝试找包含"定时"的开关元素
      const switches = document.querySelectorAll('[role="switch"], [class*="switch"], [class*="Switch"], [class*="toggle"], [class*="Toggle"]');
      for (const sw of switches) {
        if (sw.textContent?.includes('定时') || sw.parentElement?.textContent?.includes('定时')) {
          scheduleToggle = sw;
          break;
        }
      }
    }

    if (scheduleToggle) {
      console.log('[抖音发布助手] 找到定时发布选项，点击开启');
      scheduleToggle.click();
      await this.delay(1000);

      // 设置时间 - 查找时间输入框
      const timeInputs = document.querySelectorAll('input[type="time"], input[type="datetime-local"], input[placeholder*="时间"], input[placeholder*="选择"]');
      for (const input of timeInputs) {
        if (this.isElementVisible(input)) {
          // 解析 scheduleTime (格式: "2025-01-01 12:00" 或 ISO)
          const dt = new Date(scheduleTime);
          if (!isNaN(dt.getTime())) {
            const pad = n => String(n).padStart(2, '0');
            const timeStr = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
            console.log('[抖音发布助手] 设置定时时间:', timeStr);

            // 聚焦并设置值
            input.focus();
            input.click();
            await this.delay(200);

            // 尝试直接设置值
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, timeStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('[抖音发布助手] 定时时间设置完成');
            return true;
          }
        }
      }

      // 尝试查找日历/时间选择器中的输入框
      const pickerInputs = document.querySelectorAll('[class*="picker"] input, [class*="Picker"] input, [class*="calendar"] input');
      for (const input of pickerInputs) {
        if (this.isElementVisible(input)) {
          const dt = new Date(scheduleTime);
          if (!isNaN(dt.getTime())) {
            const pad = n => String(n).padStart(2, '0');
            const dateTimeStr = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
            input.focus();
            input.click();
            await this.delay(200);

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, dateTimeStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('[抖音发布助手] 定时时间设置完成 (picker)');
            return true;
          }
        }
      }

      console.log('[抖音发布助手] 未找到时间输入框');
      return true; // 开关已开启，时间设置可能需要手动
    }

    console.log('[抖音发布助手] 未找到定时发布选项');
    return false;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

console.log('[抖音发布助手] 脚本加载');
const publisher = new DouyinPublisher();
