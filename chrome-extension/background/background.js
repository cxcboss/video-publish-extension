let publishState = {
  isPublishing: false,
  videos: [],
  settings: {},
  videoPath: '',
  currentIndex: 0,
  targetTabId: null,
  platform: null,
  commandSent: false,
  scheduledTime: null,
  expectedTimestamp: null,
  debuggerAttached: false,
  publishRecords: [],
  waitingForNavigation: false
};

let debuggerTargets = new Map();

async function attachDebugger(tabId) {
  if (debuggerTargets.has(tabId)) {
    return true;
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');

    if (publishState.platform === 'weixin') {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [
          {
            urlPattern: '*channels.weixin.qq.com*/post_create*',
            requestStage: 'Request'
          }
        ]
      });
    } else if (publishState.platform === 'douyin') {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [
          {
            urlPattern: '*creator.douyin.com*/upload*',
            requestStage: 'Request'
          },
          {
            urlPattern: '*creator.douyin.com*/api*',
            requestStage: 'Request'
          }
        ]
      });
    }

    debuggerTargets.set(tabId, true);
    publishState.debuggerAttached = true;
    console.log('[Background] 调试器已附加，平台:', publishState.platform);
    return true;
  } catch (error) {
    console.error('[Background] 附加调试器失败:', error.message);
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerTargets.has(tabId)) {
    return;
  }
  
  try {
    await chrome.debugger.detach({ tabId });
    debuggerTargets.delete(tabId);
  } catch (error) {
    console.log('[Background] 分离调试器:', error.message);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method === 'Fetch.requestPaused') {
    if (params.request.url.includes('post_create') && publishState.expectedTimestamp) {
      let modifiedBodyBase64 = null;
      
      if (params.request.postData) {
        try {
          const bodyObj = JSON.parse(params.request.postData);
          const scheduledTimestampSeconds = Math.floor(publishState.expectedTimestamp / 1000);
          
          bodyObj.effectiveTime = scheduledTimestampSeconds;
          modifiedBodyBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(bodyObj))));
          
          console.log('[Background] 定时发布时间已注入:', new Date(publishState.expectedTimestamp).toLocaleString('zh-CN'));
        } catch (e) {
          console.error('[Background] 修改请求体失败:', e.message);
        }
      }
      
      try {
        const continueParams = {
          requestId: params.requestId
        };
        
        if (modifiedBodyBase64) {
          continueParams.postData = modifiedBodyBase64;
        }
        
        await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', continueParams);
      } catch (error) {
        console.error('[Background] 继续请求失败:', error.message);
        try {
          await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', {
            requestId: params.requestId
          });
        } catch (e) {}
      }
      return;
    }
    
    try {
      await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', {
        requestId: params.requestId
      });
    } catch (error) {}
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerTargets.delete(source.tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'startPublishFlow':
      handleStartPublishFlow(message)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
      
    case 'generateContent':
      generateAIContent(message.videoName, message.settings)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ topics: [], description: '', error: error.message }));
      return true;
      
    case 'publishProgress':
      handlePublishProgress(message);
      sendResponse({ success: true });
      break;
      
    case 'getPublishState':
      sendResponse(publishState);
      break;
      
    case 'stopPublish':
      publishState.isPublishing = false;
      if (publishState.targetTabId) {
        detachDebugger(publishState.targetTabId);
      }
      publishState.targetTabId = null;
      sendResponse({ success: true });
      break;
      
    case 'ping':
      sendResponse({ ready: true, state: publishState });
      break;
      
    case 'getScheduledTime':
      const scheduledTime = calculateScheduledTime(message.videoIndex, message.firstVideoScheduled);
      sendResponse({ scheduledTime: scheduledTime });
      break;
      
    case 'setExpectedTimestamp':
      publishState.expectedTimestamp = message.timestamp;
      console.log('[Background] 设置定时发布时间戳:', message.timestamp);
      sendResponse({ success: true });
      break;

    case 'testAI':
      testAIConnection(message.provider, message.apiKey, message.model)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'douyinPublishDone':
      handleDouyinPublishDone(message).catch(() => {});
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

async function handleStartPublishFlow(message) {
  let initialScheduledTime = null;
  
  if (message.settings.scheduledPublish && message.settings.scheduleTime) {
    initialScheduledTime = message.settings.scheduleTime.replace('T', ' ');
    console.log('[Background] 用户指定定时发布时间:', initialScheduledTime);
  }
  
  publishState = {
    isPublishing: true,
    videos: message.videos,
    settings: message.settings,
    videoPath: message.videoPath,
    currentIndex: 0,
    targetTabId: null,
    platform: message.platform,
    commandSent: false,
    scheduledTime: initialScheduledTime,
    expectedTimestamp: null,
    debuggerAttached: false,
    publishRecords: [],
    waitingForNavigation: false
  };
  
  console.log('[Background] 开始发布流程，共', message.videos.length, '个视频');
  console.log('[Background] 定时发布:', message.settings.scheduledPublish ? '开启' : '关闭');
  
  await publishNextVideo();
}

async function publishNextVideo() {
  if (!publishState.isPublishing) {
    console.log('[Background] 发布已取消');
    return;
  }
  
  if (publishState.currentIndex >= publishState.videos.length) {
    console.log('[Background] 所有视频发布完成');
    await finishAllPublish();
    return;
  }
  
  const video = publishState.videos[publishState.currentIndex];
  const idx = publishState.currentIndex + 1;
  const total = publishState.videos.length;
  console.log(`[Background] 准备发布第 ${idx}/${total} 个视频: ${video.name}`);
  sendProgress(`准备: ${video.name}`, 'publishing', idx, total);

  const platformUrl = publishState.platform === 'douyin'
    ? 'https://creator.douyin.com/creator-micro/content/publish'
    : 'https://channels.weixin.qq.com/platform/post/create';
  
  publishState.commandSent = false;
  publishState.waitingForNavigation = false;
  publishState.debuggerAttached = false;
  
  const tab = await chrome.tabs.create({ url: platformUrl });
  publishState.targetTabId = tab.id;
  console.log('[Background] 已打开标签页:', tab.id);
  
  const needDebugger = publishState.platform === 'douyin' || (publishState.platform === 'weixin' &&
    (publishState.settings.scheduledPublish || publishState.videos.length > 1));

  if (needDebugger) {
    console.log('[Background] 需要调试器，立即附加... 平台:',
      publishState.platform, '原因:',
      publishState.platform === 'douyin' ? '抖音上传需要调试器' : (publishState.settings.scheduledPublish ? '定时发布' : '多视频发布'));
    await attachDebugger(tab.id);
  }
}

async function finishAllPublish() {
  console.log('[Background] 所有视频发布完成，保存记录并打开历史页面');
  sendProgress('全部完成', 'done', 1, 1, true);
  publishState.isPublishing = false;
  
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  
  if (publishState.publishRecords.length > 0) {
    for (const record of publishState.publishRecords) {
      await savePublishRecord(record);
    }
  }
  
  chrome.tabs.create({ url: 'http://localhost:3000/' });
  console.log('[Background] 已打开发布历史页面');
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!publishState.isPublishing) {
    return;
  }
  
  if (publishState.targetTabId !== tabId) {
    return;
  }
  
  const needDebugger = publishState.platform === 'douyin' || (publishState.platform === 'weixin' &&
    (publishState.settings.scheduledPublish || publishState.videos.length > 1));
  
  if (needDebugger && !publishState.debuggerAttached) {
    if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      console.log('[Background] 尝试附加调试器，页面状态:', changeInfo.status, '原因:', 
        publishState.settings.scheduledPublish ? '定时发布' : '多视频发布');
      await attachDebugger(tabId);
    }
  }
  
  if (changeInfo.status === 'complete') {
    console.log('[Background] 标签页加载完成:', tabId, tab.url);
    
    if (publishState.platform === 'weixin') {
      if (tab.url && tab.url.includes('/platform/post/list')) {
        console.log('[Background] 检测到页面跳转到列表页，发布成功');
        await handleVideoPublishDone();
        return;
      }
      
      if (tab.url && tab.url.includes('/platform/post/create') && !publishState.commandSent) {
        await sendPublishCommand(tabId);
      }
    } else {
      await sendPublishCommand(tabId);
    }
  }
});

async function handleDouyinPublishDone(message) {
  const video = publishState.videos[publishState.currentIndex];
  const idx = publishState.currentIndex + 1;
  const total = publishState.videos.length;
  console.log(`[Background] 抖音视频 ${message.videoName} 发布完成`);
  sendProgress(`完成: ${message.videoName}`, 'done', idx, total);

  const record = {
    videoName: message.videoName,
    videoPath: message.videoPath || publishState.videoPath || '',
    platform: 'douyin',
    publishTime: new Date().toISOString(),
    scheduled: message.scheduled || false,
    scheduledTime: publishState.scheduledTime
  };
  publishState.publishRecords.push(record);

  const oldTabId = publishState.targetTabId;
  if (oldTabId) {
    detachDebugger(oldTabId);
  }

  publishState.currentIndex++;
  publishState.debuggerAttached = false;
  publishState.commandSent = false;

  if (publishState.currentIndex < publishState.videos.length) {
    if (oldTabId) {
      chrome.tabs.remove(oldTabId).catch(() => {});
      console.log('[Background] 已关闭上一个发布标签页');
    }
    publishState.targetTabId = null;
    console.log('[Background] 等待3秒后发布下一个视频...');
    setTimeout(() => { publishNextVideo(); }, 3000);
  } else {
    publishState.targetTabId = oldTabId;
    await finishAllPublish();
  }
}

async function handleVideoPublishDone() {
  const video = publishState.videos[publishState.currentIndex];
  const idx = publishState.currentIndex + 1;
  const total = publishState.videos.length;
  console.log(`[Background] 视频 ${video.name} 发布完成`);
  sendProgress(`完成: ${video.name}`, 'done', idx, total);
  console.log('[Background] videoPath:', publishState.videoPath);
  
  const record = {
    videoName: video.name,
    videoPath: publishState.videoPath || '',
    platform: publishState.platform,
    publishTime: new Date().toISOString(),
    scheduled: publishState.settings.scheduledPublish || false,
    scheduledTime: publishState.scheduledTime
  };
  
  console.log('[Background] 发布记录:', JSON.stringify(record));
  publishState.publishRecords.push(record);
  
  const oldTabId = publishState.targetTabId;
  
  if (oldTabId) {
    detachDebugger(oldTabId);
  }
  
  publishState.currentIndex++;
  publishState.debuggerAttached = false;
  publishState.commandSent = false;
  
  if (publishState.currentIndex < publishState.videos.length) {
    if (oldTabId) {
      chrome.tabs.remove(oldTabId).catch(() => {});
      console.log('[Background] 已关闭上一个发布标签页');
    }
    publishState.targetTabId = null;
    console.log('[Background] 等待3秒后发布下一个视频...');
    setTimeout(() => { publishNextVideo(); }, 3000);
  } else {
    publishState.targetTabId = oldTabId;
    await finishAllPublish();
  }
}

async function sendPublishCommand(tabId) {
  if (publishState.commandSent) {
    return;
  }
  
  console.log('[Background] 发送发布命令到标签页:', tabId);
  
  let bestTarget = null;
  let maxElements = 0;
  
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!publishState.isPublishing) {
      console.log('[Background] 发布已取消');
      return;
    }
    
    try {
      const pingResponse = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      
      if (pingResponse && pingResponse.ready) {
        const elementCount = pingResponse.elementCount || 0;
        
        if (elementCount > maxElements) {
          maxElements = elementCount;
          bestTarget = pingResponse;
        }
        
        if (elementCount > 50) {
          break;
        }
      }
    } catch (error) {}
    
    await sleep(1000);
  }
  
  if (!bestTarget || maxElements < 10) {
    console.error('[Background] 无法找到有效的content script环境');
    publishState.isPublishing = false;
    return;
  }
  
  publishState.commandSent = true;
  
  const video = publishState.videos[publishState.currentIndex];
  
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'startPublish',
      videos: [video],
      settings: publishState.settings,
      videoPath: publishState.videoPath,
      videoIndex: publishState.currentIndex,
      totalVideos: publishState.videos.length
    });
    
    console.log('[Background] 发布命令已发送');
  } catch (error) {
    console.error('[Background] 发送发布命令失败:', error);
    publishState.isPublishing = false;
  }
}

function handlePublishProgress(message) {
  console.log('[Background] 收到发布进度:', message.status);
}

function sendProgress(step, detail, current, total, done) {
  chrome.runtime.sendMessage({
    action: 'progressUpdate',
    step, detail, current, total, done: !!done,
    videoIndex: publishState.currentIndex,
    status: detail === 'done' ? 'done' : (detail === 'error' ? 'error' : 'publishing')
  }).catch(() => {});
}

function getAIProviderConfig(provider, apiKey, model, prompt) {
  const configs = {
    mimo: {
      url: 'https://api.xiaomimimo.com/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: { model: model || 'mimo-v2.5', messages: [{ role: 'user', content: prompt }], temperature: 0.7 },
      extract: (data) => data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || ''
    },
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: { model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7 },
      extract: (data) => data.choices?.[0]?.message?.content || ''
    },
    gemini: {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`,
      headers: { 'Content-Type': 'application/json' },
      body: { contents: [{ parts: [{ text: prompt }] }] },
      extract: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    },
    doubao: {
      url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: { model: model || 'doubao-seed-2-0-mini-260215', messages: [{ role: 'user', content: prompt }], temperature: 0.7 },
      extract: (data) => data.choices?.[0]?.message?.content || ''
    },
    deepseek: {
      url: 'https://api.deepseek.com/v1/chat/completions',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: { model: model || 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 },
      extract: (data) => data.choices?.[0]?.message?.content || ''
    }
  };
  return configs[provider] || null;
}

async function callAIApi(provider, apiKey, model, prompt) {
  const config = getAIProviderConfig(provider, apiKey, model, prompt);
  if (!config) throw new Error(`未知的 AI Provider: ${provider}`);

  console.log('[Background] 调用AI:', provider, config.url);
  const response = await fetch(config.url, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify(config.body)
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await response.json();
  console.log('[Background] AI响应:', JSON.stringify(data).substring(0, 300));

  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  return config.extract(data);
}

async function testAIConnection(provider, apiKey, model) {
  try {
    const prompt = '回复"OK"两个字即可。';
    const reply = await callAIApi(provider, apiKey, model, prompt);
    if (reply) {
      return { success: true, reply: reply.trim() };
    }
    return { success: false, error: 'AI 返回为空' };
  } catch (e) {
    console.error('[Background] AI测试失败:', e);
    return { success: false, error: e.message };
  }
}

async function generateAIContent(videoName, settings) {
  console.log('[Background] 生成AI内容, provider:', settings.aiProvider);

  const videoDesc = settings.videoContent || videoName;
  const prompt = `你是短视频文案专家。根据以下视频内容生成发布内容。

视频内容：${videoDesc}

严格按以下JSON格式返回，不要返回其他内容：
{"description":"30字以内吸引人的文案","topics":["#话题1","#话题2","#话题3"]}

注意：topics 最多5个，每个以#开头。`;

  try {
    const textContent = await callAIApi(settings.aiProvider, settings.aiKey, settings.aiModel, prompt);

    if (textContent) {
      try {
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const topics = (parsed.topics || parsed.tags || []).slice(0, 5);
          return {
            topics: topics,
            description: parsed.description || parsed.desc || ''
          };
        }
      } catch (e) {
        console.error('[Background] JSON解析失败:', e);
      }
      return {
        topics: extractTopics(textContent).slice(0, 5),
        description: extractDescription(textContent)
      };
    }

    return { topics: [], description: '', error: 'AI返回为空' };
  } catch (error) {
    console.error('[Background] AI调用失败:', error);
    return { topics: [], description: '', error: error.message };
  }
}

function extractTopics(text) {
  const topics = [];
  const regex = /#[\u4e00-\u9fa5\w]+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!topics.includes(match[0])) {
      topics.push(match[0]);
    }
  }
  return topics.slice(0, 5);
}

function extractDescription(text) {
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.includes('#') && line.length > 10);
  
  return lines.slice(0, 3).join(' ').substring(0, 200);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateScheduledTime(videoIndex, firstVideoScheduled = false) {
  let baseTime;
  
  if (videoIndex === 0 && publishState.scheduledTime) {
    baseTime = new Date(publishState.scheduledTime);
  } else if (publishState.scheduledTime) {
    baseTime = new Date(publishState.scheduledTime);
    const randomMinutes = 40 + Math.floor(Math.random() * 49);
    baseTime.setMinutes(baseTime.getMinutes() + randomMinutes);
  } else {
    baseTime = new Date();
    
    if (firstVideoScheduled) {
      const initialDelay = 5 + Math.floor(Math.random() * 10);
      baseTime.setMinutes(baseTime.getMinutes() + initialDelay);
    }
    
    if (videoIndex > 0) {
      const randomMinutes = 40 + Math.floor(Math.random() * 49);
      baseTime.setMinutes(baseTime.getMinutes() + randomMinutes);
    }
  }
  
  const year = baseTime.getFullYear();
  const month = String(baseTime.getMonth() + 1).padStart(2, '0');
  const day = String(baseTime.getDate()).padStart(2, '0');
  const hours = String(baseTime.getHours()).padStart(2, '0');
  const minutes = String(baseTime.getMinutes()).padStart(2, '0');
  
  const timeStr = `${year}-${month}-${day} ${hours}:${minutes}`;
  
  publishState.scheduledTime = baseTime.toISOString();
  
  console.log(`[Background] 第${videoIndex + 1}个视频定时时间: ${timeStr}`);
  
  return timeStr;
}

async function savePublishRecord(record) {
  try {
    await fetch('http://localhost:3000/api/publish-record', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(record)
    });
    console.log('[Background] 发布记录已保存:', record.videoName);
  } catch (error) {
    console.error('[Background] 保存发布记录失败:', error.message);
  }
}

console.log('[Background] Service Worker 已启动');
