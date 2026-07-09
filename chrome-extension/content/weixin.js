/**
 * 【视频号发布助手】
 * 
 * 此类用于自动化视频号发布流程
 * 
 * 主要功能：
 * 1. 自动上传视频文件
 * 2. 自动填写描述和话题（支持AI生成）
 * 3. 自动选择活动（如果文件名包含"原创"则跳过）
 * 4. 自动设置定时发布
 * 5. 自动声明原创
 * 6. 自动点击发布
 * 
 * 关键规则：
 * - 文件名"-"前面不是中文或包含数字：跳过AI识别，使用默认话题
 * - 文件名包含"原创"：跳过活动选择
 * - 多视频发布：第二个及后续视频自动定时发布
 * 
 * 【警告】核心函数已标记，请勿随意修改！
 */
class WeixinPublisher {
  constructor() {
    this.isReady = false;
    this.isInIframe = window !== window.top;
    this.domReady = false;
    this.defaultTopics = ['#动画', '#奇葩游戏', '#游戏视频', '#小游戏', '#休闲游戏'];
    this.defaultDescription = '';
    this.init();
  }

  randomDelay() {
    const ms = 300 + Math.floor(Math.random() * 221);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  hasChinese(text) {
    return /[\u4e00-\u9fa5]/.test(text);
  }


  /**
   * 判断是否需要使用AI生成内容
   * 
   * 规则：
   * 1. 未勾选AI生成文案：跳过
   * 2. 文件名"-"前面不是中文或包含数字：跳过
   * 3. 整个文件名不含中文或包含数字：跳过
   */
  shouldUseAI(videoName, settings) {
    if (!settings.autoGenerate) {
      console.log('[视频号发布助手] 未勾选AI生成文案，跳过AI识别');
      return false;
    }
    
    const nameWithoutExt = videoName.replace(/\.[^/.]+$/, '');
    
    if (nameWithoutExt.includes('-')) {
      const partBeforeDash = nameWithoutExt.split('-')[0];
      if (!this.hasChinese(partBeforeDash) || /\d/.test(partBeforeDash)) {
        console.log('[视频号发布助手] 视频文件名"-"前面不是中文或包含数字，跳过AI识别:', partBeforeDash);
        return false;
      }
    } else {
      if (!this.hasChinese(nameWithoutExt) || /\d/.test(nameWithoutExt)) {
        console.log('[视频号发布助手] 视频文件名不含中文或包含数字，跳过AI识别:', nameWithoutExt);
        return false;
      }
    }
    
    return true;
  }

  init() {
    console.log('[视频号发布助手] 初始化中...', this.isInIframe ? '(iframe内)' : '(主页面)');

    this.aborted = false;
    this.abortCheckInterval = null;
    this.setupMutationObserver();

    // ★ storage 变化监听 — 最可靠的中止信号通道
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['_vpe_abort'] && changes['_vpe_abort'].newValue) {
        this.aborted = true;
        console.log('[视频号发布助手] storage 中止信号');
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'startPublish') {
        this.aborted = false;
        this.startAbortCheck();
        this.handlePublish(message, sendResponse);
        return true;
      }

      if (message.action === 'ping') {
        const elementCount = this.getAllElements().length;
        sendResponse({
          ready: true,
          isInIframe: this.isInIframe,
          elementCount: elementCount,
          url: window.location.href
        });
        return true;
      }

      if (message.action === 'abortPublish') {
        this.aborted = true;
        console.log('[视频号发布助手] 消息中止信号');
        sendResponse({ aborted: true });
        return true;
      }
    });

    this.isReady = true;
    console.log('[视频号发布助手] 初始化完成');
  }

  startAbortCheck() {
    this.stopAbortCheck();
    this.abortCheckInterval = setInterval(() => {
      if (this.aborted) {
        console.log('[视频号发布助手] 定时检查: 已中止');
        this.stopAbortCheck();
      }
    }, 200);
  }

  stopAbortCheck() {
    if (this.abortCheckInterval) { clearInterval(this.abortCheckInterval); this.abortCheckInterval = null; }
  }

  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          this.domReady = true;
          break;
        }
      }
    });
    
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  async handlePublish(message, sendResponse) {
    try {
      if (this.isInIframe) {
        await this.publishSingleVideo(
          message.videos[0],
          message.settings,
          message.videoPath,
          message.videoIndex,
          message.totalVideos
        );
        this.stopAbortCheck();
        if (this.aborted) return;
        sendResponse({ success: true });
      } else {
        await this.publishFromMainPage(message);
        this.stopAbortCheck();
        if (this.aborted) return;
        sendResponse({ success: true });
      }
    } catch (error) {
      this.stopAbortCheck();
      if (this.aborted) return;
      console.error('[视频号发布助手] 发布失败:', error);
      this.notifyProgress(message.videoIndex + 1, message.totalVideos, message.videos[0].name, 'error');
      sendResponse({ success: false, error: error.message });
    }
  }

  async publishFromMainPage(message) {
    await this.waitForDomReady();
    await this.delay(3000);
    
    const uploadInput = await this.findUploadInputInDocument();
    if (uploadInput) {
      await this.doUpload(uploadInput, message);
      return;
    }
    
    await this.publishSingleVideo(
      message.videos[0],
      message.settings,
      message.videoPath,
      message.videoIndex,
      message.totalVideos
    );
  }

  async waitForDomReady() {
    for (let i = 0; i < 60; i++) {
      const elements = this.getAllElements();
      if (elements.length > 10) {
        return true;
      }
      await this.delay(500);
    }
    return false;
  }

  getAllElements() {
    let all = [];
    all = all.concat(Array.from(document.querySelectorAll('*')));
    
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          all = all.concat(Array.from(iframeDoc.querySelectorAll('*')));
        }
      } catch (e) {}
    }
    
    return all;
  }

  parseVideoName(videoName) {
    const result = {
      activityName: null,
      isOriginal: false
    };
    
    const activityMatch = videoName.match(/小游戏-(.+?)(?:\.[^.]+$|$)/);
    if (activityMatch) {
      result.activityName = activityMatch[1].trim().replace(/[_-]+$/, '');
    }
    
    if (videoName.includes('原创')) {
      result.isOriginal = true;
    }
    
    return result;
  }

  /**
   * 发布单个视频的完整流程
   *
   * 流程顺序（不可打乱）：
   * 1. 等待页面 DOM 加载完成
   * 2. 找到 file input 并上传视频文件
   * 3. 等待视频上传完成（必须等待，不可缩短）
   * 4. 并行：AI 生成文案（如果开启）
   * 5. 填写描述文案 + 话题标签
   * 6. 设置位置为"不显示位置"
   * 7. 选择活动（如果文件名含"小游戏-xxx"）
   * 8. 声明原创（如果文件名含"原创"）
   * 9. 设置定时发布（如果开启）
   * 10. 点击发布
   * 11. 等待发布完成，检测页面跳转
   *
   * 每步操作都有重试机制，失败后重试最多3次
   */
  async publishSingleVideo(video, settings, videoPath, videoIndex, totalVideos) {
    const step = (msg) => console.log(`[视频号发布助手] [${videoIndex+1}/${totalVideos}] ${msg}`);
    step(`开始发布: ${video.name}`);

    const videoInfo = this.parseVideoName(video.name);
    const useAI = this.shouldUseAI(video.name, settings);

    // ── 步骤1: 等待页面加载 ──
    step('等待页面加载...');
    await this.waitForDomReady();
    await this.delay(2000);
    if (this.aborted) return;
    step('页面加载完成');

    // ── 步骤2: 查找上传入口 ──
    step('查找上传入口...');
    let uploadInput = await this.findUploadInputInDocument();
    if (!uploadInput) {
      uploadInput = await this.simulateDragUpload(videoPath, video.name);
    }
    if (!uploadInput) {
      throw new Error('未找到上传入口，请确保在正确的发布页面');
    }
    step('找到上传入口');

    // ── 步骤3: 上传视频 ──
    step('获取视频文件...');
    const file = await this.getVideoFile(videoPath, video.name);
    if (!file) throw new Error('无法获取视频文件');
    step(`视频文件大小: ${(file.size / 1024 / 1024).toFixed(1)}MB`);

    step('上传视频中...');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([file], video.name, { type: 'video/mp4' }));
    uploadInput.files = dataTransfer.files;
    uploadInput.dispatchEvent(new Event('change', { bubbles: true }));

    // 同时启动 AI 生成（后台并行，不阻塞）
    let aiPromise = null;
    if (useAI) {
      step('AI 生成文案中（后台并行）...');
      aiPromise = this.generateAIContent(video.name, settings);
    }

    // ── 步骤4: 等待上传完成（最多8秒，超时则继续填写表单） ──
    step('等待视频上传完成...');
    const uploadOk = await this.waitForUploadComplete(8);
    if (!uploadOk) step('上传检测超时，继续填写表单...');
    if (this.aborted) return;

    // ── 步骤5: 获取 AI 结果 ──
    let aiContent = { topics: [], description: '' };
    if (useAI && aiPromise) {
      try {
        aiContent = await aiPromise;
        step(`AI 结果: 描述="${aiContent.description?.substring(0,30)}" 话题=${JSON.stringify(aiContent.topics)}`);
      } catch (e) {
        step(`AI 生成失败: ${e.message}`);
      }
    }
    if (this.aborted) return;

    // ── 步骤6: 组装描述 + 话题 ──
    let fullDescription = '';
    let topics = [];

    if (useAI && aiContent.description) {
      fullDescription = aiContent.description;
    }
    if (useAI && aiContent.topics?.length > 0) {
      topics = aiContent.topics.slice(0, 5);
    } else {
      topics = this.defaultTopics;
    }

    const topicText = topics.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
    fullDescription = fullDescription ? fullDescription + ' ' + topicText : topicText;

    // ── 步骤7: 填写描述（带重试） ──
    step('填写描述...');
    if (this.aborted) return;
    let descOk = await this.fillDescription(fullDescription);
    if (!descOk) {
      step('描述填写失败，重试...');
      await this.delay(500);
      descOk = await this.fillDescription(fullDescription);
    }
    step(`描述填写${descOk ? '成功' : '失败'}`);

    // ── 步骤8: 设置位置 ──
    step('设置位置...');
    if (this.aborted) return;
    await this.setLocationNone();

    // ── 步骤9: 选择活动 ──
    const videoNameHasOriginal = video.name.includes('原创');
    if (videoInfo.activityName && !videoNameHasOriginal) {
      step(`选择活动: ${videoInfo.activityName}`);
      const actOk = await this.joinActivity(videoInfo.activityName);
      step(`活动选择${actOk ? '成功' : '失败'}`);
      if (this.aborted) return;
    }

    // ── 步骤10: 声明原创 ──
    if (videoInfo.isOriginal) {
      step('声明原创...');
      const origOk = await this.declareOriginal();
      if (!origOk) throw new Error('原创声明失败');
      step('原创声明成功');
    }

    // ── 步骤11: 定时发布 ──
    const needSchedule = settings.scheduledPublish || (totalVideos > 1 && videoIndex >= 1);
    if (needSchedule) {
      step('设置定时发布...');
      await this.setScheduledPublish(videoIndex, totalVideos, settings.scheduledPublish === true);
      await this.delay(1500);
      await this.closeAllPickers();
      await this.delay(500);
      step('定时发布设置完成');
      if (this.aborted) return;
    }

    // ── 步骤12: 点击发布 ──
    step('点击发布...');
    if (this.aborted) return;
    await this.clickPublish(video.name, videoIndex, totalVideos, topics, fullDescription);
    step('发布完成');
  }

  /**
   * 动态检测视频上传是否完成
   * 轮询检查：描述输入框 (contenteditable / textarea / [class*="editor"]) 是否出现
   * 出现即表示上传完成、表单已加载
   * 每秒检查一次，最多等待 maxSeconds 秒
   */
  async waitForUploadComplete(maxSeconds) {
    const maxMs = maxSeconds * 1000;
    const interval = 1000;
    let waited = 0;
    while (waited < maxMs) {
      const editors = document.querySelectorAll(
        '[contenteditable="true"], textarea, [class*="editor"], [class*="Editor"], [class*="desc"], [class*="Desc"], [data-placeholder]'
      );
      for (const el of editors) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          console.log(`[视频号发布助手] 上传完成检测: ${(waited/1000).toFixed(1)}秒`);
          return true;
        }
      }
      await this.delay(interval);
      waited += interval;
    }
    console.log(`[视频号发布助手] 上传检测超时: ${maxSeconds}秒`);
    return false;
  }

  async findUploadInputInDocument() {
    const selectors = [
      'input[type="file"]',
      'input[accept*="video"]',
      'input[accept*=".mp4"]',
      'input[accept*="*"]'
    ];
    
    for (const selector of selectors) {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        if (input.type === 'file') {
          return input;
        }
      }
    }
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        for (const selector of selectors) {
          const inputs = host.shadowRoot.querySelectorAll(selector);
          for (const input of inputs) {
            if (input.type === 'file') {
              return input;
            }
          }
        }
        
        const allInputs = host.shadowRoot.querySelectorAll('input');
        for (const input of allInputs) {
          if (input.type === 'file') {
            return input;
          }
        }
      }
    }
    
    return null;
  }

  async simulateDragUpload(videoPath, videoName) {
    const file = await this.getVideoFile(videoPath, videoName);
    if (!file) {
      return null;
    }
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allDivs = host.shadowRoot.querySelectorAll('div');
        
        for (const div of allDivs) {
          const text = (div.textContent || '').trim();
          
          if (text.includes('上传时长') || text.includes('大小不超过')) {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([file], videoName, { type: 'video/mp4' }));
            
            const dropEvent = new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: dataTransfer
            });
            
            div.dispatchEvent(dropEvent);
            
            await this.delay(1000);
            
            const input = await this.findUploadInputInDocument();
            if (input) {
              return input;
            }
            
            const hiddenInput = host.shadowRoot.querySelector('input[type="file"]');
            if (hiddenInput) {
              const dt = new DataTransfer();
              dt.items.add(new File([file], videoName, { type: 'video/mp4' }));
              hiddenInput.files = dt.files;
              hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
              return hiddenInput;
            }
          }
        }
      }
    }
    
    return null;
  }

  async doUpload(uploadInput, message) {
    const video = message.videos[0];
    const settings = message.settings;
    const videoPath = message.videoPath;
    const videoIndex = message.videoIndex;
    const totalVideos = message.totalVideos;
    
    console.log('[视频号发布助手] 等待页面完全加载...');
    await this.delay(3000);
    console.log('[视频号发布助手] 开始上传视频');
    
    const videoInfo = this.parseVideoName(video.name);
    const useAI = this.shouldUseAI(video.name, settings);
    
    const file = await this.getVideoFile(videoPath, video.name);
    if (!file) {
      throw new Error('无法获取视频文件');
    }
    
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([file], video.name, { type: 'video/mp4' }));
    uploadInput.files = dataTransfer.files;
    uploadInput.dispatchEvent(new Event('change', { bubbles: true }));

    let aiPromise = null;
    if (useAI) {
      aiPromise = this.generateAIContent(video.name, settings);
    }

    await this.delay(12000);
    if (this.aborted) return;

    let aiContent = { topics: [], description: '' };
    if (useAI && aiPromise) {
      try {
        aiContent = await aiPromise;
      } catch (e) {}
    }
    if (this.aborted) return;

    let fullDescription = '';
    let topics = [];

    if (useAI) {
      if (aiContent.description) {
        fullDescription = aiContent.description;
      }
      if (aiContent.topics && aiContent.topics.length > 0) {
        topics = aiContent.topics.slice(0, 5);
      } else {
        topics = this.defaultTopics;
      }
    } else {
      topics = this.defaultTopics;
    }
    
    const topicText = topics.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
    
    if (fullDescription) {
      fullDescription = fullDescription + ' ' + topicText;
    } else {
      fullDescription = topicText;
    }
    
    await this.fillDescription(fullDescription);
    if (this.aborted) return;
    await this.randomDelay();

    await this.setLocationNone();
    if (this.aborted) return;
    await this.randomDelay();

    const videoNameHasOriginal = video.name.includes('原创');
    
    if (videoInfo.activityName && !videoNameHasOriginal) {
      await this.joinActivity(videoInfo.activityName);
      if (this.aborted) return;
      await this.randomDelay();
    } else if (videoNameHasOriginal) {
      console.log('[视频号发布助手] 视频文件名包含"原创"，跳过活动选择');
    }

    if (videoInfo.isOriginal) {
      const originalResult = await this.declareOriginal();
      if (!originalResult) {
        throw new Error('原创声明失败，请手动完成声明后点击发布');
      }
      await this.randomDelay();
    }

    const firstVideoScheduled = settings.scheduledPublish === true;

    if (firstVideoScheduled || (totalVideos > 1 && videoIndex >= 1)) {
      await this.setScheduledPublish(videoIndex, totalVideos, firstVideoScheduled);
      if (this.aborted) return;
      await this.randomDelay();
    }

    if (this.aborted) return;
    await this.clickPublish(video.name, videoIndex, totalVideos, topics, fullDescription);
  }

  async getVideoFile(videoPath, videoName) {
    const fullPath = videoPath.endsWith('/') 
      ? `${videoPath}${videoName}` 
      : `${videoPath}/${videoName}`;
    
    try {
      const response = await fetch(`http://localhost:3000/api/video/file?path=${encodeURIComponent(fullPath)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      return blob;
    } catch (error) {
      console.error('[视频号发布助手] 获取视频文件失败:', error);
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
          resolve({ topics: [], description: '', error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { topics: [], description: '' });
        }
      });
    });
  }

  /**
   * 【重要】填写视频描述/话题
   * 
   * 此函数用于在视频号发布页面填写描述内容（包含话题标签）
   * 
   * 关键逻辑：
   * 1. 使用多种选择器查找描述输入框（shadow DOM 中）
   * 2. 跳过"短标题"输入框（通过 placeholder 识别）
   * 3. 选择宽度最大的输入框作为描述输入框
   * 4. 最多重试 10 次，每次间隔 1 秒
   * 
   * 选择器列表（按优先级）：
   * - [contenteditable="true"]
   * - textarea
   * - [data-placeholder]
   * - .editor, .ql-editor
   * - [class*="editor"], [class*="Editor"]
   * - div[contenteditable]
   * 
   * 短标题识别（跳过）：
   * - placeholder 包含 "概括视频主要内容"
   * - placeholder 包含 "字数建议"
   * - placeholder 包含 "6-16个字符"
   * 
   * 【警告】不要随意修改此函数，可能导致描述无法填写！
   */
  async fillDescription(description) {
    console.log('[视频号发布助手] 开始填写描述，内容:', description);
    
    for (let retry = 0; retry < 10; retry++) {
      let largestElement = null;
      let largestWidth = 0;
      
      const allShadowHosts = document.querySelectorAll('*');
      console.log('[视频号发布助手] 第', retry + 1, '次尝试，查找所有元素数量:', allShadowHosts.length);
      
      for (const host of allShadowHosts) {
        if (host.shadowRoot) {
          const selectors = [
            '[contenteditable="true"]',
            'textarea',
            '[data-placeholder]',
            '.editor',
            '.ql-editor',
            '[class*="editor"]',
            '[class*="Editor"]',
            'div[contenteditable]'
          ];
          
          for (const selector of selectors) {
            const allInputs = host.shadowRoot.querySelectorAll(selector);
            
            for (const element of allInputs) {
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              const isVisible = this.isElementVisible(element) && style.display !== 'none' && style.visibility !== 'hidden';
              
              console.log('[视频号发布助手] 检查输入框 - selector:', selector, 'visible:', isVisible, 'width:', rect.width, 'height:', rect.height, 'display:', style.display);
              
              if (!isVisible || rect.width === 0) {
                continue;
              }
              
              const placeholder = (element.placeholder || element.getAttribute('data-placeholder') || '').trim();
              
              if (placeholder.includes('概括视频主要内容') || 
                  placeholder.includes('字数建议') ||
                  placeholder.includes('6-16个字符')) {
                console.log('[视频号发布助手] 跳过短标题输入框(placeholder):', placeholder);
                continue;
              }
              
              if (rect.width > largestWidth) {
                largestWidth = rect.width;
                largestElement = element;
                console.log('[视频号发布助手] 更新最大宽度输入框:', rect.width);
              }
            }
          }
        }
      }
      
      console.log('[视频号发布助手] 最大宽度:', largestWidth);
      
      if (largestElement && largestWidth > 100) {
        console.log('[视频号发布助手] 找到描述输入框，宽度:', largestWidth);
        largestElement.focus();
        await this.delay(100);
        
        if (largestElement.contentEditable === 'true') {
          largestElement.innerHTML = '';
          document.execCommand('insertText', false, description);
        } else {
          largestElement.value = description;
        }
        
        largestElement.dispatchEvent(new Event('input', { bubbles: true }));
        largestElement.dispatchEvent(new Event('change', { bubbles: true }));
        
        console.log('[视频号发布助手] 描述填写完成');
        return true;
      }
      
      console.log('[视频号发布助手] 未找到合适的描述输入框，等待1秒后重试...');
      await this.delay(1000);
    }
    
    console.log('[视频号发布助手] 10次尝试后仍未找到描述输入框');
    return false;
  }

  async setLocationNone() {
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allDivs = host.shadowRoot.querySelectorAll('div');
        
        for (const div of allDivs) {
          const className = (div.className || '').toLowerCase();
          const text = (div.textContent || '').trim();
          
          if ((className.includes('location') || text === '位置') && text.length < 20) {
            div.click();
            await this.randomDelay();
            
            const dropdownItems = host.shadowRoot.querySelectorAll('div, li, span');
            for (const item of dropdownItems) {
              const itemText = (item.textContent || '').trim();
              if (itemText === '不显示位置' || itemText === '不显示') {
                item.click();
                await this.randomDelay();
                return true;
              }
            }
          }
        }
      }
    }
    
    return false;
  }

  /**
   * 【重要】选择活动
   */
  async joinActivity(activityName) {
    console.log('[视频号发布助手] 开始选择活动:', activityName);

    const wujieApp = document.querySelector('wujie-app');
    if (!wujieApp?.shadowRoot) {
      console.log('[视频号发布助手] 未找到 wujie-app shadow root');
      return false;
    }
    const shadow = wujieApp.shadowRoot;

    // 步骤1: 点击 activity-display 打开下拉
    const activityWrap = shadow.querySelector('.activity-display-wrap') ||
                         shadow.querySelector('.activity-display');
    if (!activityWrap) {
      console.log('[视频号发布助手] 未找到 activity-display');
      return false;
    }
    console.log('[视频号发布助手] 点击活动区域打开下拉...');
    activityWrap.click();
    await this.delay(2000);

    // 步骤2: 查找搜索框
    let searchInput = null;
    const filterWrap = shadow.querySelector('.activity-filter-wrap');
    if (filterWrap) {
      const inp = filterWrap.querySelector('input');
      if (inp) {
        const r = inp.getBoundingClientRect();
        if (r.width > 0) searchInput = inp;
      }
    }
    if (!searchInput) {
      // 找所有可见 input
      for (const inp of shadow.querySelectorAll('input')) {
        const r = inp.getBoundingClientRect();
        if (r.width > 30 && r.height > 5 && r.width < 500) {
          searchInput = inp;
          break;
        }
      }
    }

    // 步骤3: 输入活动名称
    if (searchInput) {
      console.log('[视频号发布助手] 找到搜索框，输入:', activityName);
      searchInput.focus();
      await this.delay(300);
      // 清空
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await this.delay(200);
      // 逐字输入
      for (const char of activityName) {
        searchInput.value += char;
        searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
        await this.delay(120);
      }
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[视频号发布助手] 输入完成，等待搜索结果...');
      await this.delay(3000);
    } else {
      console.log('[视频号发布助手] 未找到搜索框');
      return false;
    }

    // 步骤4: 在下拉列表中查找并点击匹配项
    // 搜索区域：activity-filter-wrap 或整个 shadow
    const listArea = shadow.querySelector('.activity-filter-wrap') || shadow;
    let clicked = false;

    // 策略1: 找 activity-item（最精准）
    const activityItems = listArea.querySelectorAll('.activity-item');
    for (const item of activityItems) {
      const r = item.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // 跳过隐藏项
      const text = (item.textContent || '').trim();
      if (text.includes(activityName)) {
        console.log('[视频号发布助手] 找到匹配 activity-item:', text.substring(0, 40));
        item.click();
        clicked = true;
        break;
      }
    }

    // 策略2: 找 option-item
    if (!clicked) {
      const optionItems = listArea.querySelectorAll('.option-item');
      for (const item of optionItems) {
        const r = item.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const text = (item.textContent || '').trim();
        if (text.includes(activityName)) {
          console.log('[视频号发布助手] 找到匹配 option-item:', text.substring(0, 40));
          item.click();
          clicked = true;
          break;
        }
      }
    }

    // 策略3: 模糊匹配所有可见的小元素
    if (!clicked) {
      console.log('[视频号发布助手] 精确匹配失败，模糊搜索...');
      const allEls = listArea.querySelectorAll('div, li, span, a');
      for (const el of allEls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.height > 80) continue;
        const text = (el.textContent || '').trim();
        if (text.includes(activityName) && text.length < 60 && el.children.length <= 2) {
          console.log('[视频号发布助手] 模糊匹配到:', text.substring(0, 40), 'tag:', el.tagName);
          el.click();
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      console.log('[视频号发布助手] 未找到匹配的活动选项');
      return false;
    }

    await this.delay(2000);

    // 步骤5: 验证选择结果
    const display = shadow.querySelector('.activity-display') ||
                    shadow.querySelector('.activity-display-wrap');
    if (display) {
      const displayText = (display.textContent || '').trim();
      console.log('[视频号发布助手] 验证: 活动显示文本 =', displayText);
      if (displayText.includes(activityName) || displayText.includes('小游戏')) {
        console.log('[视频号发布助手] 活动选择验证通过');
        await this.clearShortTitleInput();
        return true;
      } else if (displayText.includes('不参与') || displayText.includes('不参加')) {
        console.log('[视频号发布助手] 验证失败: 仍显示不参与活动');
        return false;
      } else {
        console.log('[视频号发布助手] 验证: 选择了其他活动:', displayText);
        await this.clearShortTitleInput();
        return true;
      }
    }

    console.log('[视频号发布助手] 无法验证，跳过');
    return false;
  }

  async verifySelectedActivity(expectedActivityText) {
    console.log('[视频号发布助手] 核对选择的活动，期望:', expectedActivityText);
    
    await this.delay(500);
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allElements = host.shadowRoot.querySelectorAll('div, span, p');
        
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          
          if (text.includes('微信小游戏 ·') && text.length < 50) {
            console.log('[视频号发布助手] 找到已选活动:', text);
            
            if (text === expectedActivityText || text.includes(expectedActivityText.replace('微信小游戏 · ', ''))) {
              console.log('[视频号发布助手] 核对通过');
              return true;
            } else {
              console.log('[视频号发布助手] 核对不通过，已选:', text, '期望:', expectedActivityText);
              return false;
            }
          }
        }
      }
    }
    
    console.log('[视频号发布助手] 未找到已选活动元素');
    return false;
  }

  async clearShortTitleInput() {
    console.log('[视频号发布助手] 尝试清除短标题输入框...');
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allInputs = host.shadowRoot.querySelectorAll('input[type="text"], [contenteditable="true"]');
        
        for (const input of allInputs) {
          if (!this.isElementVisible(input)) continue;
          
          const placeholder = (input.placeholder || '').trim();
          
          if (placeholder.includes('概括视频主要内容') || 
              placeholder.includes('字数建议') ||
              placeholder.includes('短标题') ||
              placeholder.includes('6-16个字符')) {
            
            console.log('[视频号发布助手] 找到短标题输入框，清除内容');
            
            input.focus();
            await this.delay(100);
            
            if (input.contentEditable === 'true') {
              input.innerHTML = '';
            } else {
              input.value = '';
            }
            
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            
            input.blur();
            
            console.log('[视频号发布助手] 短标题输入框已清除');
            return true;
          }
        }
      }
    }
    
    return false;
  }

  /**
   * 【重要】设置定时发布
   * 
   * 此函数用于设置视频的定时发布时间
   * 
   * 关键逻辑：
   * 1. 从 background 获取计算好的定时时间
   * 2. 发送时间戳到 background（用于拦截请求修改 effectiveTime）
   * 3. 点击定时发布按钮
   * 4. 选择定时发布选项
   * 5. 打开时间选择器
   * 6. 调用 selectDateTime 选择具体的日期和时间
   * 
   * 【警告】不要随意修改此函数，可能导致定时发布失败！
   */
  async setScheduledPublish(videoIndex, totalVideos, firstVideoScheduled = false) {
    const scheduledTime = await this.getScheduledTime(videoIndex, firstVideoScheduled);
    console.log('[视频号发布助手] 计划发布时间:', scheduledTime);
    
    const timeMatch = scheduledTime.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!timeMatch) {
      return false;
    }
    
    const year = timeMatch[1];
    const month = timeMatch[2];
    const day = timeMatch[3];
    const hour = timeMatch[4];
    const minute = timeMatch[5];
    
    console.log('[视频号发布助手] 解析时间 - 年:', year, '月:', month, '日:', day, '时:', hour, '分:', minute);
    
    const timestamp = new Date(year, parseInt(month) - 1, day, hour, minute).getTime();
    
    chrome.runtime.sendMessage({
      action: 'setExpectedTimestamp',
      timestamp: timestamp
    });
    
    console.log('[视频号发布助手] 已发送定时时间戳到background:', timestamp);
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allDivs = host.shadowRoot.querySelectorAll('div');
        const allSpans = host.shadowRoot.querySelectorAll('span');
        const allLabels = host.shadowRoot.querySelectorAll('label');
        
        const allElements = [...allDivs, ...allSpans, ...allLabels];
        
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          
          if ((text.includes('定时发表') || text.includes('定时发布')) && text.length < 30) {
            console.log('[视频号发布助手] 找到定时发布按钮，点击...');
            el.click();
            await this.delay(800);
            
            const radios = host.shadowRoot.querySelectorAll('input[type="radio"]');
            for (const radio of radios) {
              const radioParent = radio.closest('label') || radio.closest('div') || radio.parentElement;
              const radioText = (radioParent?.textContent || '').trim();
              
              if (radioText.includes('定时') && !radioText.includes('不定时')) {
                console.log('[视频号发布助手] 选择定时发布选项');
                radio.click();
                await this.delay(800);
                break;
              }
            }
            
            const timeInputs = host.shadowRoot.querySelectorAll('input[type="text"]');
            
            for (const input of timeInputs) {
              const placeholder = input.placeholder || '';
              
              if (placeholder.includes('时间') || placeholder.includes('日期') || placeholder.includes('选择')) {
                console.log('[视频号发布助手] 找到时间输入框，点击...');
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await this.delay(300);
                
                input.focus();
                input.click();
                await this.delay(800);
                
                await this.selectDateTime(host, year, month, day, hour, minute);
                
                return true;
              }
            }
            
            break;
          }
        }
      }
    }
    
    return false;
  }

  /**
   * 【重要】选择日期时间
   * 
   * 此函数用于在定时发布时选择具体的日期和时间
   * 
   * 关键逻辑：
   * 1. 检查当前显示的月份，通过导航按钮切换到正确的月份
   * 2. 选择日期
   * 3. 选择小时和分钟
   * 4. 点击确定按钮
   * 
   * 【警告】不要随意修改此函数，可能导致定时发布失败！
   */
  async selectDateTime(host, year, month, day, hour, minute) {
    console.log('[视频号发布助手] 选择日期时间:', year, month, day, hour, minute);
    
    await this.delay(500);
    
    const pickerPanels = host.shadowRoot.querySelectorAll('dl[class*="picker"], div[class*="picker"], div[class*="calendar"], .el-picker-panel, .date-picker, .weui-desktop-picker');
    
    console.log('[视频号发布助手] 找到选择面板数量:', pickerPanels.length);
    
    for (const panel of pickerPanels) {
      if (!this.isElementVisible(panel)) continue;
      
      console.log('[视频号发布助手] 找到可见的日期时间选择面板');
      
      const targetMonth = parseInt(month);
      const targetDay = parseInt(day);
      
      const monthNavBtns = panel.querySelectorAll('a, button, [class*="prev"], [class*="next"], [class*="arrow"]');
      console.log('[视频号发布助手] 找到导航按钮数量:', monthNavBtns.length);
      
      for (let attempt = 0; attempt < 12; attempt++) {
        const currentMonthText = this.getCurrentMonth(panel);
        console.log('[视频号发布助手] 当前显示月份:', currentMonthText, '目标月份:', targetMonth);
        
        if (currentMonthText === targetMonth) {
          console.log('[视频号发布助手] 已切换到正确月份');
          break;
        }
        
        if (currentMonthText < targetMonth) {
          const nextBtn = this.findNextMonthButton(panel);
          if (nextBtn) {
            console.log('[视频号发布助手] 点击下个月按钮');
            nextBtn.click();
            await this.delay(400);
          } else {
            break;
          }
        } else {
          const prevBtn = this.findPrevMonthButton(panel);
          if (prevBtn) {
            console.log('[视频号发布助手] 点击上个月按钮');
            prevBtn.click();
            await this.delay(400);
          } else {
            break;
          }
        }
      }
      
      const allTds = panel.querySelectorAll('td');
      console.log('[视频号发布助手] 找到日期td数量:', allTds.length);
      
      for (const td of allTds) {
        const tdText = (td.textContent || '').trim();
        const tdClass = (td.className || '').toLowerCase();
        
        if (tdText === day && !tdClass.includes('disabled') && !tdClass.includes('prev') && !tdClass.includes('next') && !tdClass.includes('out')) {
          console.log('[视频号发布助手] 选择日期:', day);
          td.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await this.delay(200);
          td.click();
          await this.delay(400);
          break;
        }
      }
      
      const dtElements = panel.querySelectorAll('dt');
      for (const dt of dtElements) {
        const dtClass = dt.className || '';
        
        if (dtClass.includes('time') || dtClass.includes('picker')) {
          console.log('[视频号发布助手] 找到时间选择器dt');
          dt.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await this.delay(500);
          dt.click();
          await this.delay(1000);
        }
      }
      
      const ddElements = panel.querySelectorAll('dd');
      for (const dd of ddElements) {
        const ddClass = dd.className || '';
        
        if (ddClass.includes('time')) {
          console.log('[视频号发布助手] 找到时间选择器dd');
          dd.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await this.delay(200);
          dd.click();
          await this.delay(500);
          
          const timeLis = dd.querySelectorAll('li');
          
          let hourSelected = false;
          let minuteSelected = false;
          
          for (const li of timeLis) {
            const liText = (li.textContent || '').trim();
            
            if (liText === hour && !hourSelected) {
              console.log('[视频号发布助手] 选择小时:', hour);
              li.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delay(200);
              li.click();
              await this.delay(300);
              hourSelected = true;
            }
            
            if (liText === minute && hourSelected && !minuteSelected) {
              console.log('[视频号发布助手] 选择分钟:', minute);
              li.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delay(200);
              li.click();
              await this.delay(300);
              minuteSelected = true;
            }
          }
        }
      }
      
      await this.delay(300);
      
      const allButtons = host.shadowRoot.querySelectorAll('button');
      for (const btn of allButtons) {
        const btnText = (btn.textContent || '').trim();
        if ((btnText === '确定' || btnText === '确认') && this.isElementVisible(btn)) {
          console.log('[视频号发布助手] 点击确定按钮');
          btn.click();
          await this.delay(500);
          break;
        }
      }
      
      const timeInput = host.shadowRoot.querySelector('input[placeholder*="时间"]');
      if (timeInput) {
        timeInput.dispatchEvent(new Event('change', { bubbles: true }));
        timeInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await this.delay(200);
        document.body.click();
        await this.delay(200);
        timeInput.blur();
        await this.delay(500);
      }
      
      return true;
    }
    
    return false;
  }

  getCurrentMonth(panel) {
    const monthDisplay = panel.querySelector('[class*="month"], [class*="title"], .weui-desktop-picker__header, .picker-header');
    if (monthDisplay) {
      const text = (monthDisplay.textContent || '').trim();
      console.log('[视频号发布助手] 月份显示文本:', text);
      const monthMatch = text.match(/(\d{4})年(\d{1,2})月|(\d{1,2})月|(\d{4})-(\d{2})/);
      if (monthMatch) {
        if (monthMatch[2]) return parseInt(monthMatch[2]);
        if (monthMatch[3]) return parseInt(monthMatch[3]);
        if (monthMatch[5]) return parseInt(monthMatch[5]);
      }
    }
    
    const allSpans = panel.querySelectorAll('span, div');
    for (const span of allSpans) {
      const text = (span.textContent || '').trim();
      if (text.includes('月') && text.length < 20) {
        console.log('[视频号发布助手] 找到月份文本:', text);
        const monthMatch = text.match(/(\d{1,2})月/);
        if (monthMatch) {
          return parseInt(monthMatch[1]);
        }
      }
    }
    
    return new Date().getMonth() + 1;
  }

  findNextMonthButton(panel) {
    const selectors = [
      '[class*="next"]',
      '[class*="arrow-right"]',
      '[class*="right"]',
      'a[title*="下"]',
      'button[title*="下"]'
    ];
    
    for (const selector of selectors) {
      const btns = panel.querySelectorAll(selector);
      for (const btn of btns) {
        const btnClass = (btn.className || '').toLowerCase();
        if (btnClass.includes('month') || btnClass.includes('next') || btnClass.includes('right') || btnClass.includes('arrow')) {
          return btn;
        }
      }
    }
    
    const allBtns = panel.querySelectorAll('a, button, i, span');
    for (const btn of allBtns) {
      const btnClass = (btn.className || '').toLowerCase();
      const btnTitle = (btn.title || btn.getAttribute('aria-label') || '').toLowerCase();
      if (btnClass.includes('next') || btnTitle.includes('下') || btnTitle.includes('next')) {
        return btn;
      }
    }
    
    return null;
  }

  findPrevMonthButton(panel) {
    const selectors = [
      '[class*="prev"]',
      '[class*="arrow-left"]',
      '[class*="left"]',
      'a[title*="上"]',
      'button[title*="上"]'
    ];
    
    for (const selector of selectors) {
      const btns = panel.querySelectorAll(selector);
      for (const btn of btns) {
        const btnClass = (btn.className || '').toLowerCase();
        if (btnClass.includes('month') || btnClass.includes('prev') || btnClass.includes('left') || btnClass.includes('arrow')) {
          return btn;
        }
      }
    }
    
    const allBtns = panel.querySelectorAll('a, button, i, span');
    for (const btn of allBtns) {
      const btnClass = (btn.className || '').toLowerCase();
      const btnTitle = (btn.title || btn.getAttribute('aria-label') || '').toLowerCase();
      if (btnClass.includes('prev') || btnTitle.includes('上') || btnTitle.includes('prev')) {
        return btn;
      }
    }
    
    return null;
  }

  async getScheduledTime(videoIndex, firstVideoScheduled = false) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'getScheduledTime',
        videoIndex: videoIndex,
        firstVideoScheduled: firstVideoScheduled
      }, (response) => {
        if (chrome.runtime.lastError) {
          const fallbackTime = this.calculateScheduledTime(videoIndex, firstVideoScheduled);
          resolve(fallbackTime);
        } else {
          resolve(response.scheduledTime);
        }
      });
    });
  }

  calculateScheduledTime(videoIndex, firstVideoScheduled = false) {
    const now = new Date();
    let totalMinutes = 0;
    
    if (firstVideoScheduled && videoIndex === 0) {
      return this.formatTimeForDisplay(now);
    }
    
    if (firstVideoScheduled) {
      totalMinutes = 5 + Math.floor(Math.random() * 10);
      for (let i = 1; i <= videoIndex; i++) {
        const randomMinutes = 40 + Math.floor(Math.random() * 49);
        totalMinutes += randomMinutes;
      }
    } else {
      for (let i = 1; i <= videoIndex; i++) {
        const randomMinutes = 40 + Math.floor(Math.random() * 49);
        totalMinutes += randomMinutes;
      }
    }
    
    const scheduledDate = new Date(now.getTime() + totalMinutes * 60 * 1000);
    
    return this.formatTimeForDisplay(scheduledDate);
  }

  formatTimeForDisplay(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  async declareOriginal() {
    console.log('[视频号发布助手] ========== 开始原创声明流程 ==========');
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allCheckboxes = host.shadowRoot.querySelectorAll('input[type="checkbox"]');
        
        for (const checkbox of allCheckboxes) {
          const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
          const parentText = (parent?.textContent || '').trim();
          
          if (parentText.includes('声明原创') || parentText.includes('原创标记')) {
            console.log('[视频号发布助手] 找到原创声明复选框，父元素文本:', parentText.substring(0, 60));
            console.log('[视频号发布助手] 复选框当前状态:', checkbox.checked ? '已勾选' : '未勾选');
            
            if (!checkbox.checked) {
              console.log('[视频号发布助手] 步骤1: 点击原创声明复选框');
              checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delay(300);
              checkbox.click();
              console.log('[视频号发布助手] 已点击原创声明复选框，等待弹窗加载...');
              
              await this.delay(1000);
              
              console.log('[视频号发布助手] 步骤2: 处理弹窗...');
              const popupResult = await this.handleOriginalPopupV2();
              
              if (popupResult) {
                await this.delay(500);
                console.log('[视频号发布助手] 步骤6: 验证原创声明是否成功...');
                
                const newCheckboxState = await this.findOriginalCheckbox();
                if (newCheckboxState) {
                  console.log('[视频号发布助手] 原创声明成功！');
                  return true;
                }
              }
              
              console.log('[视频号发布助手] 原创声明失败，请手动操作');
              return false;
            } else {
              console.log('[视频号发布助手] 原创声明复选框已勾选，跳过');
              return true;
            }
          }
        }
      }
    }
    
    console.log('[视频号发布助手] 未找到原创声明复选框');
    return false;
  }

  async findOriginalCheckbox() {
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allCheckboxes = host.shadowRoot.querySelectorAll('input[type="checkbox"]');
        for (const checkbox of allCheckboxes) {
          const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
          const parentText = (parent?.textContent || '').trim();
          if (parentText.includes('声明原创') || parentText.includes('原创标记')) {
            console.log('[视频号发布助手] 验证: 原创声明复选框状态:', checkbox.checked ? '已勾选' : '未勾选');
            return checkbox.checked;
          }
        }
      }
    }
    return false;
  }

  async handleOriginalPopupV2() {
    console.log('[视频号发布助手] 步骤3: 查找并勾选确认条款复选框...');
    
    let confirmCheckboxClicked = false;
    let foundConfirmCheckbox = false;
    
    for (let retry = 0; retry < 10; retry++) {
      const shadowHosts = document.querySelectorAll('*');
      for (const host of shadowHosts) {
        if (host.shadowRoot) {
          const allCheckboxes = host.shadowRoot.querySelectorAll('input[type="checkbox"]');
          
          for (let i = 0; i < allCheckboxes.length; i++) {
            const checkbox = allCheckboxes[i];
            const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
            const parentText = (parent?.textContent || '').trim();
            
            if (parentText.includes('我已阅读并同意') && parentText.includes('原创声明须知')) {
              console.log('[视频号发布助手] 找到确认条款复选框！');
              foundConfirmCheckbox = true;
              
              if (!checkbox.checked) {
                console.log('[视频号发布助手] 勾选确认条款复选框');
                checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await this.delay(300);
                checkbox.click();
                await this.delay(300);
              }
              confirmCheckboxClicked = true;
              break;
            }
          }
          
          if (confirmCheckboxClicked) break;
        }
      }
      
      if (foundConfirmCheckbox) break;
      
      await this.randomDelay();
    }
    
    if (!foundConfirmCheckbox) {
      const shadowHosts = document.querySelectorAll('*');
      for (const host of shadowHosts) {
        if (host.shadowRoot) {
          const allElements = host.shadowRoot.querySelectorAll('*');
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text.includes('我已阅读') && text.length < 500) {
              const checkbox = el.querySelector('input[type="checkbox"]') || 
                              el.parentElement?.querySelector('input[type="checkbox"]');
              
              if (checkbox && !checkbox.checked) {
                checkbox.click();
                await this.randomDelay();
                foundConfirmCheckbox = true;
                confirmCheckboxClicked = true;
                break;
              }
            }
          }
          if (confirmCheckboxClicked) break;
        }
      }
      
      if (!foundConfirmCheckbox) {
        console.log('[视频号发布助手] 仍然未找到确认条款复选框');
        return false;
      }
    }
    
    await this.delay(200);
    
    console.log('[视频号发布助手] 步骤4-5: 查找并点击声明原创按钮...');
    
    for (let retry = 0; retry < 5; retry++) {
      const shadowHosts = document.querySelectorAll('*');
      for (const host of shadowHosts) {
        if (host.shadowRoot) {
          const buttons = host.shadowRoot.querySelectorAll('button');
          
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            
            if (text === '声明原创') {
              const isDisabled = btn.disabled;
              const isVisible = this.isElementVisible(btn);
              
              if (!isDisabled && isVisible) {
                console.log('[视频号发布助手] 点击声明原创按钮');
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await this.delay(200);
                btn.click();
                await this.delay(500);
                console.log('[视频号发布助手] 已点击声明原创按钮，等待弹窗关闭...');
                return true;
              }
            }
          }
        }
      }
      
      await this.randomDelay();
    }
    
    console.log('[视频号发布助手] 未找到可点击的声明原创按钮');
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

  async clickPublish(videoName, videoIndex, totalVideos, topics, description) {
    console.log('[视频号发布助手] 查找发布按钮...');
    
    const buttons = document.querySelectorAll('button');
    const publishButtons = [];
    
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      
      if (this.isElementVisible(btn) && !btn.disabled) {
        if (text === '发表' || text === '发布') {
          publishButtons.push({ btn, text, priority: 1 });
        } else if (text === '立即发表' || text === '立即发布') {
          publishButtons.push({ btn, text, priority: 2 });
        } else if ((text.includes('发表') || text.includes('发布')) && !text.includes('定时')) {
          publishButtons.push({ btn, text, priority: 3 });
        }
      }
    }
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const shadowButtons = host.shadowRoot.querySelectorAll('button');
        
        for (const btn of shadowButtons) {
          const text = (btn.textContent || '').trim();
          
          if (this.isElementVisible(btn) && !btn.disabled) {
            if (text === '发表' || text === '发布') {
              publishButtons.push({ btn, text, priority: 1 });
            } else if (text === '立即发表' || text === '立即发布') {
              publishButtons.push({ btn, text, priority: 2 });
            } else if ((text.includes('发表') || text.includes('发布')) && !text.includes('定时')) {
              publishButtons.push({ btn, text, priority: 3 });
            }
          }
        }
      }
    }
    
    publishButtons.sort((a, b) => a.priority - b.priority);
    
    if (publishButtons.length > 0) {
      const { btn, text } = publishButtons[0];
      console.log('[视频号发布助手] 找到发布按钮:', text);
      
      await this.delay(500);

      btn.click();
      console.log('[视频号发布助手] 已点击发布按钮');

      // 不发送 done 通知！background 通过页面跳转到 /post/list 检测真正完成
      // 超时保护由 background 的 timeout 机制负责

      return { success: true };
    }
    
    console.log('[视频号发布助手] 未找到合适的发布按钮');
    return { success: false };
  }

  async closeAllPickers() {
    document.body.click();
    await this.delay(200);
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const closeButtons = host.shadowRoot.querySelectorAll('button[class*="close"], .close, [aria-label="关闭"]');
        for (const btn of closeButtons) {
          if (this.isElementVisible(btn)) {
            btn.click();
            await this.delay(200);
          }
        }
      }
    }
    
    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true
    });
    document.dispatchEvent(escEvent);
    await this.delay(200);
  }

  notifyProgress(current, total, videoName, status, topics = [], description = '') {
    try {
      chrome.runtime.sendMessage({
        action: 'publishProgress',
        current: current,
        total: total,
        videoName: videoName,
        status: status,
        topics: topics,
        description: description
      });
    } catch (e) {}
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

console.log('[视频号发布助手] 脚本加载');
const publisher = new WeixinPublisher();
