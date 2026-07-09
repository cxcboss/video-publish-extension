let publishState = {
  isPublishing: false, videos: [], settings: {}, videoPath: '',
  currentIndex: 0, targetTabId: null, platform: null, commandSent: false,
  scheduledTime: null, expectedTimestamp: null, debuggerAttached: false,
  publishRecords: [], retryCounts: {}, timeoutTimer: null, nextVideoTimer: null,
  totalVideos: 0,
};

let _doneLock = false;
let _finishCalled = false;
const SKIP_KEY = '_vpe_skip_names';
const ABORT_KEY = '_vpe_abort';
let debuggerTargets = new Map();

// ========== 跳过管理 ==========

async function getSkipNames() {
  try {
    const data = await chrome.storage.local.get(SKIP_KEY);
    return new Set(data[SKIP_KEY] || []);
  } catch (_) { return new Set(); }
}

async function clearSkipNames() {
  try { await chrome.storage.local.set({ [SKIP_KEY]: [] }); } catch (_) {}
}

// ========== 中止标志 ==========

async function setAbortFlag() {
  try { await chrome.storage.local.set({ [ABORT_KEY]: Date.now() }); } catch (_) {}
}

async function clearAbortFlag() {
  try { await chrome.storage.local.set({ [ABORT_KEY]: 0 }); } catch (_) {}
}

// ========== 调试器 ==========

async function attachDebugger(tabId) {
  if (debuggerTargets.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    if (publishState.platform === 'weixin') {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [{ urlPattern: '*channels.weixin.qq.com*/post_create*', requestStage: 'Request' }]
      });
    } else if (publishState.platform === 'douyin') {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [
          { urlPattern: '*creator.douyin.com*/upload*', requestStage: 'Request' },
          { urlPattern: '*creator.douyin.com*/api*', requestStage: 'Request' }
        ]
      });
    }
    debuggerTargets.set(tabId, true);
    publishState.debuggerAttached = true;
    return true;
  } catch (_) { return false; }
}

async function detachDebugger(tabId) {
  if (!debuggerTargets.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); debuggerTargets.delete(tabId); } catch (_) {}
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method === 'Fetch.requestPaused') {
    if (params.request.url.includes('post_create') && publishState.expectedTimestamp) {
      let modifiedBodyBase64 = null;
      if (params.request.postData) {
        try {
          const bodyObj = JSON.parse(params.request.postData);
          bodyObj.effectiveTime = Math.floor(publishState.expectedTimestamp / 1000);
          modifiedBodyBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(bodyObj))));
        } catch (_) {}
      }
      try {
        const cp = { requestId: params.requestId };
        if (modifiedBodyBase64) cp.postData = modifiedBodyBase64;
        await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', cp);
      } catch (_) {
        try { await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId }); } catch (_) {}
      }
      return;
    }
    try { await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId }); } catch (_) {}
  }
});

chrome.debugger.onDetach.addListener((s) => { if (s.tabId) debuggerTargets.delete(s.tabId); });
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ========== 消息处理 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'startPublishFlow':
      handleStartPublishFlow(message)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'generateContent':
      generateAIContent(message.videoName, message.settings)
        .then(r => sendResponse(r)).catch(e => sendResponse({ topics: [], description: '', error: e.message }));
      return true;
    case 'getPublishState': sendResponse(publishState); break;
    case 'stopPublish': stopPublishCompletely(); sendResponse({ success: true }); break;
    case 'ping': sendResponse({ ready: true, state: publishState }); break;
    case 'getScheduledTime':
      sendResponse({ scheduledTime: calculateScheduledTime(message.videoIndex, message.firstVideoScheduled) });
      break;
    case 'setExpectedTimestamp':
      publishState.expectedTimestamp = message.timestamp;
      sendResponse({ success: true });
      break;
    case 'testAI':
      testAIConnection(message.provider, message.apiKey, message.model)
        .then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'douyinPublishDone':
      handleDouyinPublishDone(message).catch(() => {});
      sendResponse({ success: true });
      break;
  }
  return true;
});

// ========== 发布控制 ==========

function stopPublishCompletely() {
  publishState.isPublishing = false;
  _doneLock = false;
  _finishCalled = false;
  clearPublishTimeout();
  if (publishState.nextVideoTimer) { clearTimeout(publishState.nextVideoTimer); publishState.nextVideoTimer = null; }
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  publishState.debuggerAttached = false;
  publishState.commandSent = false;
  clearSkipNames();
  clearAbortFlag();
}

async function handleStartPublishFlow(message) {
  let t = null;
  if (message.settings.scheduledPublish && message.settings.scheduleTime) {
    t = message.settings.scheduleTime.replace('T', ' ');
  }
  publishState = {
    isPublishing: true, videos: message.videos, settings: message.settings,
    videoPath: message.videoPath, currentIndex: 0, targetTabId: null,
    platform: message.platform, commandSent: false, scheduledTime: t,
    expectedTimestamp: null, debuggerAttached: false, publishRecords: [],
    retryCounts: {}, timeoutTimer: null, nextVideoTimer: null,
    totalVideos: message.videos.length,
  };
  _doneLock = false;
  _finishCalled = false;
  await clearSkipNames();
  await clearAbortFlag();
  console.log('[BG] 开始发布，共', message.videos.length, '个');
  await publishNextVideo();
}

// ★ 核心：不修改数组，只跳过被标记的视频
async function publishNextVideo() {
  if (!publishState.isPublishing) return;

  const skipNames = await getSkipNames();

  // 跳过所有被标记的视频（不修改数组，不调整 currentIndex 以外的状态）
  while (publishState.currentIndex < publishState.videos.length &&
         skipNames.has(publishState.videos[publishState.currentIndex].name)) {
    const skipped = publishState.videos[publishState.currentIndex];
    console.log('[BG] 跳过:', skipped.name, 'index:', publishState.currentIndex);
    // 通知 popup 该视频被跳过
    sendProgress(`跳过: ${skipped.name}`, 'skipped', publishState.currentIndex, publishState.videos.length);
    publishState.currentIndex++;
  }

  if (publishState.currentIndex >= publishState.videos.length) {
    await finishAllPublish();
    return;
  }

  _doneLock = false;
  publishState.publishStartTime = Date.now();
  await clearAbortFlag();
  const video = publishState.videos[publishState.currentIndex];
  console.log('[BG] 发布:', publishState.currentIndex, video.name);
  sendProgress(`发布中: ${video.name}`, 'publishing', publishState.currentIndex, publishState.videos.length);

  clearPublishTimeout();

  const url = publishState.platform === 'douyin'
    ? 'https://creator.douyin.com/creator-micro/content/publish'
    : 'https://channels.weixin.qq.com/platform/post/create';

  publishState.commandSent = false;
  publishState.debuggerAttached = false;

  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }

  const tab = await chrome.tabs.create({ url });
  publishState.targetTabId = tab.id;

  const needDbg = publishState.platform === 'douyin' || (publishState.platform === 'weixin' &&
    (publishState.settings.scheduledPublish || publishState.videos.length > 1));
  if (needDbg) await attachDebugger(tab.id);
  startPublishTimeout();
}

// ========== 超时重试 ==========

function getTimeoutMs() { return (parseInt(publishState.settings?.timeoutSeconds) || 120) * 1000; }

function startPublishTimeout() {
  clearPublishTimeout();
  if (!publishState.settings.autoRetry) return;
  const timeoutMs = getTimeoutMs();
  console.log(`[BG] 启动超时定时器: ${timeoutMs}ms (${publishState.settings.timeoutSeconds}s), autoRetry=${publishState.settings.autoRetry}`);
  const currentIdx = publishState.currentIndex;
  publishState.timeoutTimer = setTimeout(async () => {
    if (!publishState.isPublishing || !publishState.targetTabId) return;
    if (publishState.currentIndex !== currentIdx) return; // 已切换到下一个视频，忽略

    // ★ 立即锁定，防止 done 处理器并发执行导致重复发布
    if (_doneLock) return;
    _doneLock = true;

    const idx = publishState.currentIndex;
    const retries = publishState.retryCounts[idx] || 0;
    const max = publishState.settings.maxRetries || 1;
    const cmdSent = publishState.commandSent;

    console.log(`[BG] 超时触发 (retries=${retries}, max=${max}, commandSent=${cmdSent})`);

    // 立即中止内容脚本 + 设置 storage 标志
    const tabId = publishState.targetTabId;
    try { await chrome.tabs.sendMessage(tabId, { action: 'abortPublish' }); } catch (_) {}
    await setAbortFlag();

    // 等待一小段时间让内容脚本处理 abort
    await sleep(300);

    // 关闭标签页并清理
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    detachDebugger(tabId);
    publishState.targetTabId = null;
    publishState.debuggerAttached = false;
    publishState.commandSent = false;

    if (retries < max) {
      publishState.retryCounts[idx] = retries + 1;
      sendProgress(`超时重试 (${retries + 1}/${max})`, 'publishing', idx, publishState.videos.length);
      await sleep(1000);
      _doneLock = false;
      if (publishState.isPublishing) await publishNextVideo();
    } else {
      sendProgress(`重试${max}次仍超时，跳过`, 'error', idx, publishState.videos.length);
      // 记录失败
      const failedVideo = publishState.videos[idx];
      if (failedVideo) {
        publishState.publishRecords.push({
          videoName: failedVideo.name, videoPath: publishState.videoPath || '',
          platform: publishState.platform, publishTime: new Date().toISOString(),
          status: 'failed', error: `超时重试${max}次后失败`,
          scheduled: false, scheduledTime: null
        });
      }
      publishState.currentIndex++;
      await sleep(2000);
      _doneLock = false;
      if (publishState.isPublishing) await publishNextVideo();
    }
  }, timeoutMs);
}

function clearPublishTimeout() { if (publishState.timeoutTimer) { clearTimeout(publishState.timeoutTimer); publishState.timeoutTimer = null; } }

// ========== 完成 ==========

async function finishAllPublish() {
  if (_finishCalled) return;
  _finishCalled = true;
  console.log('[BG] 全部完成');
  sendProgress('全部完成', 'done', 1, 1, true);
  publishState.isPublishing = false;
  clearSkipNames();
  clearAbortFlag();
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    await sleep(3000);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  for (const r of publishState.publishRecords) await savePublishRecord(r);
  chrome.tabs.create({ url: 'http://localhost:3000/' });
}

// ========== 标签页监听 ==========

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!publishState.isPublishing || publishState.targetTabId !== tabId) return;
  const needDbg = publishState.platform === 'douyin' || (publishState.platform === 'weixin' &&
    (publishState.settings.scheduledPublish || publishState.videos.length > 1));
  if (needDbg && !publishState.debuggerAttached && (changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    await attachDebugger(tabId);
  }
  if (changeInfo.status === 'complete') {
    if (publishState.platform === 'weixin') {
      if (tab.url && tab.url.includes('/platform/post/list')) { await handleVideoPublishDone(); return; }
      if (tab.url && tab.url.includes('/platform/post/create') && !publishState.commandSent) await sendPublishCommand(tabId);
    } else {
      await sendPublishCommand(tabId);
    }
  }
});

// ★ 防重入锁
async function handleDouyinPublishDone(message) {
  if (!publishState.isPublishing || _doneLock) return;
  _doneLock = true;
  clearPublishTimeout();
  const idx = publishState.currentIndex;
  sendProgress(`完成: ${message.videoName}`, 'done', idx + 1, publishState.videos.length);
  publishState.publishRecords.push({
    videoName: message.videoName, videoPath: message.videoPath || publishState.videoPath || '',
    platform: 'douyin', publishTime: new Date().toISOString(),
    status: 'success', scheduled: message.scheduled || false, scheduledTime: publishState.scheduledTime
  });
  if (publishState.targetTabId) detachDebugger(publishState.targetTabId);
  publishState.currentIndex++; publishState.debuggerAttached = false; publishState.commandSent = false;
  if (publishState.currentIndex < publishState.videos.length) {
    const old = publishState.targetTabId; publishState.targetTabId = null;
    if (old) setTimeout(() => chrome.tabs.remove(old).catch(() => {}), 3000);
    publishState.nextVideoTimer = setTimeout(() => publishNextVideo(), 8000);
  } else { await finishAllPublish(); }
}

async function handleVideoPublishDone() {
  if (!publishState.isPublishing || _doneLock) return;
  _doneLock = true;
  clearPublishTimeout();
  const video = publishState.videos[publishState.currentIndex];
  const idx = publishState.currentIndex;
  sendProgress(`完成: ${video.name}`, 'done', idx + 1, publishState.videos.length);
  publishState.publishRecords.push({
    videoName: video.name, videoPath: publishState.videoPath || '',
    platform: publishState.platform, publishTime: new Date().toISOString(),
    status: 'success', scheduled: publishState.settings.scheduledPublish || false, scheduledTime: publishState.scheduledTime
  });
  if (publishState.targetTabId) detachDebugger(publishState.targetTabId);
  publishState.currentIndex++; publishState.debuggerAttached = false; publishState.commandSent = false;
  if (publishState.currentIndex < publishState.videos.length) {
    const old = publishState.targetTabId; publishState.targetTabId = null;
    if (old) setTimeout(() => chrome.tabs.remove(old).catch(() => {}), 3000);
    publishState.nextVideoTimer = setTimeout(() => publishNextVideo(), 8000);
  } else { await finishAllPublish(); }
}

// ========== 发布命令 ==========

async function sendPublishCommand(tabId) {
  if (publishState.commandSent || !publishState.isPublishing) return;
  let best = null, max = 0;
  for (let i = 0; i < 15; i++) {
    if (!publishState.isPublishing) return;
    try {
      const r = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (r?.ready) { const c = r.elementCount || 0; if (c > max) { max = c; best = r; } if (c > 50) break; }
    } catch (_) {}
    await sleep(1000);
  }
  if (!best || max < 10 || !publishState.isPublishing) {
    console.log('[BG] 内容脚本未就绪，等待超时重试...');
    publishState.commandSent = false;
    return;
  }
  publishState.commandSent = true;
  const video = publishState.videos[publishState.currentIndex];
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'startPublish', videos: [video], settings: publishState.settings,
      videoPath: publishState.videoPath, videoIndex: publishState.currentIndex, totalVideos: publishState.totalVideos
    });
  } catch (e) {
    console.error('[BG] 发送发布命令失败:', e.message, '等待超时重试...');
    publishState.commandSent = false;
  }
}

// ========== 进度通知 ==========

function sendProgress(step, detail, current, total, done) {
  const platformName = publishState.platform === 'douyin' ? '抖音' : '视频号';
  chrome.runtime.sendMessage({
    action: 'progressUpdate', step, detail, current, total, done: !!done,
    videoIndex: publishState.currentIndex,
    platformName, totalVideos: publishState.totalVideos,
    publishStartTime: publishState.publishStartTime || Date.now(),
    retryCount: publishState.retryCounts[publishState.currentIndex] || 0,
    timeoutSeconds: parseInt(publishState.settings?.timeoutSeconds) || 120,
    status: detail === 'done' ? 'done' : (detail === 'error' ? 'error' : (detail === 'publishing' ? 'publishing' : (detail === 'skipped' ? 'skipped' : 'pending')))
  }).catch(() => {});
}

// ========== AI ==========

function getAIProviderConfig(provider, apiKey, model, prompt) {
  const c = {
    mimo: { url: 'https://api.xiaomimimo.com/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'mimo-v2.5', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || d.choices?.[0]?.message?.reasoning_content || '' },
    openai: { url: 'https://api.openai.com/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || '' },
    gemini: { url: `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`, headers: { 'Content-Type': 'application/json' }, body: { contents: [{ parts: [{ text: prompt }] }] }, extract: d => d.candidates?.[0]?.content?.parts?.[0]?.text || '' },
    doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'doubao-seed-2-0-mini-260215', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || '' },
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || '' }
  };
  return c[provider] || null;
}

async function callAIApi(provider, apiKey, model, prompt) {
  const config = getAIProviderConfig(provider, apiKey, model, prompt);
  if (!config) throw new Error(`Unknown provider: ${provider}`);
  const response = await fetch(config.url, { method: 'POST', headers: config.headers, body: JSON.stringify(config.body) });
  if (!response.ok) { const e = await response.text().catch(() => ''); throw new Error(`HTTP ${response.status}: ${e.substring(0, 200)}`); }
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return config.extract(data);
}

async function testAIConnection(provider, apiKey, model) {
  try { const r = await callAIApi(provider, apiKey, model, '回复"OK"两个字即可。'); return r ? { success: true, reply: r.trim() } : { success: false, error: 'AI 返回为空' }; } catch (e) { return { success: false, error: e.message }; }
}

async function generateAIContent(videoName, settings) {
  const prompt = `你是短视频文案专家。根据以下视频内容生成发布内容。\n\n视频内容：${settings.videoContent || videoName}\n\n严格按以下JSON格式返回：\n{"description":"30字以内吸引人的文案","topics":["#话题1","#话题2","#话题3"]}\n\n注意：topics 最多5个，每个以#开头。`;
  try {
    const text = await callAIApi(settings.aiProvider, settings.aiKey, settings.aiModel, prompt);
    if (text) { try { const m = text.match(/\{[\s\S]*\}/); if (m) { const p = JSON.parse(m[0]); return { topics: (p.topics || p.tags || []).slice(0, 5), description: p.description || p.desc || '' }; } } catch (_) {} return { topics: (text.match(/#[一-龥\w]+/g) || []).slice(0, 5), description: text.split('\n').map(l => l.trim()).filter(l => l && !l.includes('#') && l.length > 10).slice(0, 3).join(' ').substring(0, 200) }; }
    return { topics: [], description: '', error: 'AI返回为空' };
  } catch (error) { return { topics: [], description: '', error: error.message }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calculateScheduledTime(videoIndex, firstVideoScheduled = false) {
  let baseTime;
  if (videoIndex === 0 && publishState.scheduledTime) baseTime = new Date(publishState.scheduledTime);
  else if (publishState.scheduledTime) { baseTime = new Date(publishState.scheduledTime); baseTime.setMinutes(baseTime.getMinutes() + 40 + Math.floor(Math.random() * 49)); }
  else { baseTime = new Date(); if (firstVideoScheduled) baseTime.setMinutes(baseTime.getMinutes() + 5 + Math.floor(Math.random() * 10)); if (videoIndex > 0) baseTime.setMinutes(baseTime.getMinutes() + 40 + Math.floor(Math.random() * 49)); }
  const p = v => String(v).padStart(2, '0');
  const timeStr = `${baseTime.getFullYear()}-${p(baseTime.getMonth()+1)}-${p(baseTime.getDate())} ${p(baseTime.getHours())}:${p(baseTime.getMinutes())}`;
  publishState.scheduledTime = baseTime.toISOString();
  return timeStr;
}

async function savePublishRecord(record) {
  try { await fetch('http://localhost:3000/api/publish-record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) }); } catch (_) {}
}

console.log('[BG] Service Worker started');
