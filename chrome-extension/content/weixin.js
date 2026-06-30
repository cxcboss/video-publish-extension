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
    
    this.setupMutationObserver();
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'startPublish') {
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
    });
    
    this.isReady = true;
    console.log('[视频号发布助手] 初始化完成');
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
        sendResponse({ success: true });
      } else {
        await this.publishFromMainPage(message);
        sendResponse({ success: true });
      }
    } catch (error) {
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
    
    const activityMatch = videoName.match(/小游戏-(.+?)(?:\.|$|_|-)/);
    if (activityMatch) {
      result.activityName = activityMatch[1].trim();
    }
    
    if (videoName.includes('原创')) {
      result.isOriginal = true;
    }
    
    return result;
  }

  async publishSingleVideo(video, settings, videoPath, videoIndex, totalVideos) {
    console.log(`[视频号发布助手] 发布视频 ${videoIndex + 1}/${totalVideos}: ${video.name}`);
    
    const videoInfo = this.parseVideoName(video.name);
    const useAI = this.shouldUseAI(video.name, settings);
    
    console.log('[视频号发布助手] 等待页面加载...');
    await this.waitForDomReady();
    await this.delay(3000);
    console.log('[视频号发布助手] 页面加载完成，开始操作');

    let uploadInput = await this.findUploadInputInDocument();
    
    if (!uploadInput) {
      uploadInput = await this.simulateDragUpload(videoPath, video.name);
    }
    
    if (!uploadInput) {
      throw new Error('未找到上传入口，请确保在正确的发布页面');
    }

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
    
    let aiContent = { topics: [], description: '' };
    if (useAI && aiPromise) {
      try {
        aiContent = await aiPromise;
      } catch (e) {}
    }

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
    await this.randomDelay();

    await this.setLocationNone();
    await this.randomDelay();

    const videoNameHasOriginal = video.name.includes('原创');
    
    if (videoInfo.activityName && !videoNameHasOriginal) {
      await this.joinActivity(videoInfo.activityName);
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
      await this.delay(3000);
      await this.closeAllPickers();
      await this.delay(1000);
    }

    await this.clickPublish(video.name, videoIndex, totalVideos, topics, fullDescription);
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

    let aiContent = { topics: [], description: '' };
    if (useAI && aiPromise) {
      try {
        aiContent = await aiPromise;
      } catch (e) {}
    }

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
    await this.randomDelay();

    await this.setLocationNone();
    await this.randomDelay();

    const videoNameHasOriginal = video.name.includes('原创');
    
    if (videoInfo.activityName && !videoNameHasOriginal) {
      await this.joinActivity(videoInfo.activityName);
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
      await this.randomDelay();
    }
    
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
   * 
   * 此函数用于在视频号发布页面选择活动
   * 
   * 关键逻辑：
   * 1. 点击活动按钮
   * 2. 输入活动名称搜索
   * 3. 等待下拉列表加载
   * 4. 选择匹配的活动（格式：微信小游戏 · 活动名称）
   * 5. 核对最终选择的活动是否正确
   * 
   * 【警告】不要随意修改此函数，可能导致活动选择失败！
   */
  async joinActivity(activityName) {
    console.log('[视频号发布助手] 开始选择活动:', activityName);
    
    const expectedActivityText = `微信小游戏 · ${activityName}`;
    console.log('[视频号发布助手] 期望的活动文本:', expectedActivityText);
    
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        const allDivs = host.shadowRoot.querySelectorAll('div');
        
        for (const div of allDivs) {
          const className = (div.className || '').toLowerCase();
          const text = (div.textContent || '').trim();
          
          if ((className.includes('activity') || text === '活动') && text.length < 20) {
            console.log('[视频号发布助手] 找到活动按钮，点击...');
            div.click();
            await this.delay(800);
            
            const allInputs = host.shadowRoot.querySelectorAll('input');
            
            for (const input of allInputs) {
              if (this.isElementVisible(input) && (input.type === 'text' || !input.type)) {
                console.log('[视频号发布助手] 找到活动输入框，聚焦...');
                input.focus();
                input.click();
                await this.delay(500);
                
                console.log('[视频号发布助手] 清空输入框...');
                input.value = '';
                await this.delay(300);
                
                console.log('[视频号发布助手] 逐字输入活动名称:', activityName);
                for (const char of activityName) {
                  input.value += char;
                  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: char }));
                  await this.delay(50);
                }
                
                input.dispatchEvent(new Event('change', { bubbles: true }));
                
                console.log('[视频号发布助手] 等待下拉列表加载...');
                await this.delay(2000);
                
                const dropdownItems = host.shadowRoot.querySelectorAll('div, li, span');
                const matchedItems = [];
                
                for (const item of dropdownItems) {
                  const itemText = (item.textContent || '').trim();
                  if (itemText.includes(activityName) && itemText.length > 0 && itemText.length < 100) {
                    const itemClass = (item.className || '').toLowerCase();
                    if (itemClass.includes('option') || itemClass.includes('item') || itemClass.includes('dropdown') || 
                        item.tagName === 'LI' || 
                        (item.tagName === 'DIV' && itemText.length > 5 && itemText.length < 50)) {
                      matchedItems.push({ item, text: itemText });
                      console.log('[视频号发布助手] 找到匹配项:', itemText);
                    }
                  }
                }
                
                let selectedItem = null;
                
                for (const matched of matchedItems) {
                  if (matched.text === expectedActivityText || matched.text.includes(activityName)) {
                    selectedItem = matched;
                    break;
                  }
                }
                
                if (!selectedItem && matchedItems.length > 0) {
                  selectedItem = matchedItems[0];
                }
                
                if (selectedItem) {
                  console.log('[视频号发布助手] 选择活动:', selectedItem.text);
                  selectedItem.item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  await this.delay(500);
                  selectedItem.item.click();
                  await this.delay(1500);
                  
                  const verifyResult = await this.verifySelectedActivity(expectedActivityText);
                  
                  if (verifyResult) {
                    console.log('[视频号发布助手] 活动选择成功，核对通过');
                    await this.clearShortTitleInput();
                    return true;
                  } else {
                    console.log('[视频号发布助手] 活动选择核对失败，尝试重新选择...');
                    
                    for (const matched of matchedItems) {
                      if (matched.text.includes(activityName) && matched !== selectedItem) {
                        console.log('[视频号发布助手] 尝试选择另一个匹配项:', matched.text);
                        matched.item.click();
                        await this.delay(1500);
                        
                        const retryVerify = await this.verifySelectedActivity(expectedActivityText);
                        if (retryVerify) {
                          console.log('[视频号发布助手] 重新选择成功');
                          await this.clearShortTitleInput();
                          return true;
                        }
                      }
                    }
                  }
                }
                
                break;
              }
            }
          }
        }
      }
    }
    
    console.log('[视频号发布助手] 活动选择失败');
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
            await this.delay(2000);
            
            const radios = host.shadowRoot.querySelectorAll('input[type="radio"]');
            for (const radio of radios) {
              const radioParent = radio.closest('label') || radio.closest('div') || radio.parentElement;
              const radioText = (radioParent?.textContent || '').trim();
              
              if (radioText.includes('定时') && !radioText.includes('不定时')) {
                console.log('[视频号发布助手] 选择定时发布选项');
                radio.click();
                await this.delay(2000);
                break;
              }
            }
            
            const timeInputs = host.shadowRoot.querySelectorAll('input[type="text"]');
            
            for (const input of timeInputs) {
              const placeholder = input.placeholder || '';
              
              if (placeholder.includes('时间') || placeholder.includes('日期') || placeholder.includes('选择')) {
                console.log('[视频号发布助手] 找到时间输入框，点击...');
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await this.delay(500);
                
                input.focus();
                input.click();
                await this.delay(2000);
                
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
    
    await this.delay(1000);
    
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
            await this.delay(800);
          } else {
            break;
          }
        } else {
          const prevBtn = this.findPrevMonthButton(panel);
          if (prevBtn) {
            console.log('[视频号发布助手] 点击上个月按钮');
            prevBtn.click();
            await this.delay(800);
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
          await this.delay(300);
          td.click();
          await this.delay(800);
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
          await this.delay(300);
          dd.click();
          await this.delay(1000);
          
          const timeLis = dd.querySelectorAll('li');
          
          let hourSelected = false;
          let minuteSelected = false;
          
          for (const li of timeLis) {
            const liText = (li.textContent || '').trim();
            
            if (liText === hour && !hourSelected) {
              console.log('[视频号发布助手] 选择小时:', hour);
              li.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delay(300);
              li.click();
              await this.delay(500);
              hourSelected = true;
            }
            
            if (liText === minute && hourSelected && !minuteSelected) {
              console.log('[视频号发布助手] 选择分钟:', minute);
              li.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await this.delay(300);
              li.click();
              await this.delay(500);
              minuteSelected = true;
            }
          }
        }
      }
      
      await this.delay(500);
      
      const allButtons = host.shadowRoot.querySelectorAll('button');
      for (const btn of allButtons) {
        const btnText = (btn.textContent || '').trim();
        if ((btnText === '确定' || btnText === '确认') && this.isElementVisible(btn)) {
          console.log('[视频号发布助手] 点击确定按钮');
          btn.click();
          await this.delay(1000);
          break;
        }
      }
      
      const timeInput = host.shadowRoot.querySelector('input[placeholder*="时间"]');
      if (timeInput) {
        timeInput.dispatchEvent(new Event('change', { bubbles: true }));
        timeInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await this.delay(300);
        document.body.click();
        await this.delay(300);
        timeInput.blur();
        await this.delay(1000);
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
              await this.randomDelay();
              checkbox.click();
              console.log('[视频号发布助手] 已点击原创声明复选框，等待弹窗完全加载...');
              
              await this.delay(2000);
              
              console.log('[视频号发布助手] 步骤2: 处理弹窗...');
              const popupResult = await this.handleOriginalPopupV2();
              
              if (popupResult) {
                await this.delay(800);
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
                await this.randomDelay();
                checkbox.click();
                await this.randomDelay();
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
    
    await this.randomDelay();
    
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
                await this.randomDelay();
                btn.click();
                await this.delay(800);
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
      
      console.log('[视频号发布助手] 发布流程完成，通知background...');
      this.notifyProgress(videoIndex + 1, totalVideos, videoName, 'done', topics, description);
      
      await this.delay(300);
      
      btn.click();
      console.log('[视频号发布助手] 已点击发布按钮');
      
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
