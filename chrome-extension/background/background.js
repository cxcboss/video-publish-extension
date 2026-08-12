importScripts('shared/pure.js');

// ========== 常量与持久化键 ==========

const TIMEOUT_ALARM = 'vpe-publish-timeout';
const NEXT_ALARM = 'vpe-publish-next';
const PERSIST_KEY = '_vpe_publish_state';
const LAST_QUEUE_KEY = '_vpe_last_queue';
const SKIP_KEY = '_vpe_skip_names';
const ABORT_KEY = '_vpe_abort';

let publishState = {
  isPublishing: false, videos: [], settings: {}, videoPath: '',
  currentIndex: 0, targetTabId: null, platform: null, commandSent: false,
  scheduledTime: null, expectedTimestamp: null, debuggerAttached: false,
  publishRecords: [], retryCounts: {}, timeoutTimer: null, nextVideoTimer: null,
  totalVideos: 0,
  // 重试重构：阶段机状态
  stage: 'idle',          // loading | uploading | filling | clicked | verifying | done | failed
  clickedPublish: false,  // 已点击发布按钮（安全边界：此阶段后绝不自动重试）
  verifyWaited: false,    // 验证阶段是否已延长过等待
  // 持久化恢复用
  timeoutDeadline: null,  // 超时定时器的绝对时间（chrome.alarms）
  nextVideoDeadline: null,
  publishStartTime: null,
};

// 阶段安全边界：clicked（含）之后已实际提交发布请求，禁止自动重试
const STAGE_CLICKED_OR_AFTER = ['clicked', 'verifying', 'done', 'failed'];

let _doneLock = false;
let _finishCalled = false;
let debuggerTargets = new Map();

// ========== 状态持久化（MV3 Service Worker 防休眠丢失） ==========

async function persistState() {
  try {
    await chrome.storage.session.set({
      [PERSIST_KEY]: {
        isPublishing: publishState.isPublishing,
        videos: publishState.videos,
        videoPath: publishState.videoPath,
        currentIndex: publishState.currentIndex,
        targetTabId: publishState.targetTabId,
        platform: publishState.platform,
        commandSent: publishState.commandSent,
        scheduledTime: publishState.scheduledTime,
        originalScheduledTime: publishState._originalScheduledTime || null,
        expectedTimestamp: publishState.expectedTimestamp,
        debuggerAttached: publishState.debuggerAttached,
        publishRecords: publishState.publishRecords,
        retryCounts: publishState.retryCounts,
        totalVideos: publishState.totalVideos,
        stage: publishState.stage,
        clickedPublish: publishState.clickedPublish,
        verifyWaited: publishState.verifyWaited,
        settings: publishState.settings,
        publishStartTime: publishState.publishStartTime || null,
        timeoutDeadline: publishState.timeoutDeadline || null,
        nextVideoDeadline: publishState.nextVideoDeadline || null,
      }
    });
  } catch (_) {}
}

async function clearPersistedState() {
  try { await chrome.storage.session.remove(PERSIST_KEY); } catch (_) {}
}

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

// ========== 断点恢复：上次队列记录（popup 提供"恢复上次队列"入口） ==========

async function saveLastQueue(videoPath, videos) {
  try {
    await chrome.storage.local.set({
      [LAST_QUEUE_KEY]: {
        videoPath,
        videos: videos.map(v => ({ name: v.name })),
        statuses: {},
        startedAt: Date.now(),
        finished: false
      }
    });
  } catch (_) {}
}

async function updateLastQueueStatus(videoName, status) {
  try {
    const data = await chrome.storage.local.get(LAST_QUEUE_KEY);
    const q = data[LAST_QUEUE_KEY];
    if (!q) return;
    q.statuses[videoName] = status;
    await chrome.storage.local.set({ [LAST_QUEUE_KEY]: q });
  } catch (_) {}
}

async function markLastQueueFinished() {
  try {
    const data = await chrome.storage.local.get(LAST_QUEUE_KEY);
    const q = data[LAST_QUEUE_KEY];
    if (!q) return;
    q.finished = true;
    await chrome.storage.local.set({ [LAST_QUEUE_KEY]: q });
  } catch (_) {}
}

// ========== 本地服务地址（端口可配置，默认 3000） ==========

async function serverBaseUrl() {
  try {
    const d = await chrome.storage.local.get('serverPort');
    const port = parseInt(d.serverPort, 10) || 3000;
    return `http://localhost:${port}`;
  } catch (_) { return 'http://localhost:3000'; }
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
  } catch (e) {
    // SW 重启后标签页可能仍处于已 attach 状态，此时视为已附加
    if (String(e?.message || '').includes('already attached')) {
      debuggerTargets.set(tabId, true);
      publishState.debuggerAttached = true;
      return true;
    }
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerTargets.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); debuggerTargets.delete(tabId); } catch (_) {}
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method === 'Fetch.requestPaused') {
    // #16: 仅视频号平台启用请求改写，防止抖音请求被注入残留的时间戳
    if (params.request.url.includes('post_create') && publishState.platform === 'weixin' && publishState.expectedTimestamp) {
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

// ========== 定时器（chrome.alarms：SW 被回收后仍可唤醒） ==========

function startPublishTimeout(overrideMs) {
  clearPublishTimeout();
  const timeoutMs = overrideMs || getTimeoutMs();
  publishState.timeoutDeadline = Date.now() + timeoutMs;
  try { chrome.alarms.create(TIMEOUT_ALARM, { when: publishState.timeoutDeadline }); } catch (_) {}
  console.log(`[BG] 启动阶段定时器: ${timeoutMs}ms (stage=${publishState.stage}, autoRetry=${publishState.settings.autoRetry})`);
  persistState();
}

function clearPublishTimeout() {
  try { chrome.alarms.clear(TIMEOUT_ALARM); } catch (_) {}
  publishState.timeoutDeadline = null;
  if (publishState.timeoutTimer) { clearTimeout(publishState.timeoutTimer); publishState.timeoutTimer = null; }
}

function scheduleNextVideo(ms) {
  try { chrome.alarms.clear(NEXT_ALARM); } catch (_) {}
  publishState.nextVideoDeadline = Date.now() + ms;
  try { chrome.alarms.create(NEXT_ALARM, { when: publishState.nextVideoDeadline }); } catch (_) {}
  persistState();
}

function clearNextVideoSchedule() {
  try { chrome.alarms.clear(NEXT_ALARM); } catch (_) {}
  publishState.nextVideoDeadline = null;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TIMEOUT_ALARM) {
    publishState.timeoutDeadline = null;
    handlePublishTimeout().catch(e => console.error('[BG] 超时处理异常:', e));
  } else if (alarm.name === NEXT_ALARM) {
    publishState.nextVideoDeadline = null;
    if (publishState.isPublishing) publishNextVideo().catch(e => console.error('[BG] 下一视频推进异常:', e));
  }
});

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
      handlePublishCompleted(message).catch(() => {});
      sendResponse({ success: true });
      break;
    case 'weixinPublishDone':
      handlePublishCompleted(message).catch(() => {});
      sendResponse({ success: true });
      break;
    case 'publishStage':
      handleStageUpdate(message);
      sendResponse({ success: true });
      break;
    case 'getStage':
      sendResponse({ stage: publishState.stage, currentIndex: publishState.currentIndex });
      break;
  }
  return true;
});

// ========== 阶段机（重试重构核心） ==========

// 内容脚本上报阶段：推进阶段 = 流程存活，重置超时定时器
async function handleStageUpdate(message) {
  if (!publishState.isPublishing) return;
  if (message.videoIndex !== undefined && message.videoIndex !== publishState.currentIndex) return;
  const stage = message.stage;
  if (!stage) return;
  publishState.stage = stage;
  console.log('[BG] 阶段:', stage, '视频', publishState.currentIndex);

  if (stage === 'uploading' && message.videoSize) {
    // 上传阶段超时按视频大小自适应：每 10MB 额外 5s，上限 30 分钟
    const extra = Math.min(Math.ceil(message.videoSize / (10 * 1024 * 1024)) * 5000, 30 * 60 * 1000);
    if (extra > 0) startPublishTimeout(getTimeoutMs() + extra);
    else startPublishTimeout();
    return;
  }

  if (stage === 'clicked') {
    // 已点击发布按钮：进入安全区。绝不自动重试，转为验证等待兜底
    publishState.clickedPublish = true;
    publishState.verifyWaited = false;
    startPublishTimeout();
    return;
  }

  // 其他阶段：流程存活，重置超时定时器
  if (stage !== 'done' && stage !== 'failed') startPublishTimeout();
  else persistState();
}

// ========== 发布控制 ==========

function stopPublishCompletely() {
  publishState.isPublishing = false;
  _doneLock = false;
  _finishCalled = false;
  clearPublishTimeout();
  clearNextVideoSchedule();
  if (publishState.nextVideoTimer) { clearTimeout(publishState.nextVideoTimer); publishState.nextVideoTimer = null; }
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  publishState.debuggerAttached = false;
  publishState.commandSent = false;
  publishState.stage = 'idle';
  publishState.clickedPublish = false;
  publishState.verifyWaited = false;
  clearSkipNames();
  clearAbortFlag();
  clearPersistedState();
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
    _originalScheduledTime: t,  // 保存原始定时时间，不被覆盖
    expectedTimestamp: null, debuggerAttached: false, publishRecords: [],
    retryCounts: {}, timeoutTimer: null, nextVideoTimer: null,
    totalVideos: message.videos.length,
    // 重试重构：阶段机初始状态
    stage: 'idle', clickedPublish: false, verifyWaited: false,
    timeoutDeadline: null, nextVideoDeadline: null, publishStartTime: Date.now(),
  };
  _doneLock = false;
  _finishCalled = false;
  await clearSkipNames();
  await clearAbortFlag();
  await saveLastQueue(message.videoPath, message.videos);
  await persistState();
  console.log('[BG] 开始发布，共', message.videos.length, '个');
  try {
    await publishNextVideo();
  } catch (e) {
    // #20: 流程启动/推进异常时清理状态，避免 isPublishing 永久卡死
    console.error('[BG] 发布流程异常终止:', e);
    publishState.isPublishing = false;
    _doneLock = false;
    _finishCalled = false;
    clearPublishTimeout();
    clearNextVideoSchedule();
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
    clearPersistedState();
    sendProgress('发布流程异常终止: ' + e.message, 'error', publishState.currentIndex, publishState.videos.length, true);
  }
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
    updateLastQueueStatus(skipped.name, 'skipped');
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

// ========== 超时重试（重试重构：按阶段分流） ==========

function getTimeoutMs() { return (parseInt(publishState.settings?.timeoutSeconds) || 120) * 1000; }

async function handlePublishTimeout() {
  if (!publishState.isPublishing || !publishState.targetTabId) return;

  // ★ 立即锁定，防止 done 处理器并发执行导致重复发布
  if (_doneLock) return;
  _doneLock = true;

  const idx = publishState.currentIndex;
  const retries = publishState.retryCounts[idx] || 0;
  const max = publishState.settings.maxRetries || 1;
  const stage = publishState.stage;

  // ── 分支 A：已点击发布（clicked/verifying）→ 绝不自动重试，延长验证等待 ──
  if (STAGE_CLICKED_OR_AFTER.includes(stage)) {
    if (!publishState.verifyWaited) {
      publishState.verifyWaited = true;
      _doneLock = false;
      console.log('[BG] 已点击发布，延长验证等待（不重试，防止重复发布）');
      sendProgress('等待发布确认（视频可能已提交）...', 'publishing', idx, publishState.videos.length);
      startPublishTimeout();
      return;
    }
    // 验证等待已延长一次仍无结果 → 记录"结果未知"，继续下一个视频
    console.log('[BG] 发布结果未知（已点击发布但未检测到结果）');
    const unknownVideo = publishState.videos[idx];
    if (unknownVideo) {
      publishState.publishRecords.push({
        videoName: unknownVideo.name, videoPath: publishState.videoPath || '',
        platform: publishState.platform, publishTime: new Date().toISOString(),
        status: 'unknown', error: '已点击发布但未检测到发布结果，请人工确认',
        scheduled: publishState.settings.scheduledPublish || false, scheduledTime: publishState.scheduledTime
      });
      updateLastQueueStatus(unknownVideo.name, 'unknown');
    }
    publishState.currentIndex++;
    publishState.stage = 'idle';
    publishState.clickedPublish = false;
    publishState.verifyWaited = false;
    await persistState();
    await sleep(2000);
    _doneLock = false;
    if (publishState.isPublishing) await publishNextVideo();
    return;
  }

  // ── 分支 B：安全阶段（idle/loading/uploading/filling）→ abort + 重试 ──
  console.log(`[BG] 阶段停滞超时 (stage=${stage}, retries=${retries}, max=${max})`);

  // ★ 竞态防护：abort 前 ping 内容脚本，确认它还没点击发布
  // （clicked 阶段消息可能尚在途中，此时 abort 会导致重复发布）
  const tabId = publishState.targetTabId;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (r?.clicked) {
      console.log('[BG] 内容脚本已点击发布（消息竞态），放弃 abort，转入验证等待');
      publishState.stage = 'clicked';
      publishState.clickedPublish = true;
      _doneLock = false;
      startPublishTimeout();
      return;
    }
  } catch (_) {}

  // 立即中止内容脚本 + 设置 storage 标志
  try { await chrome.tabs.sendMessage(tabId, { action: 'abortPublish' }); } catch (_) {}
  await setAbortFlag();

  // 等待一小段时间让内容脚本处理 abort
  await sleep(300);

  // 关闭标签页并清理
  if (tabId) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
  detachDebugger(tabId);
  // 确认标签页真正关闭，防止残留内容脚本继续执行旧流程
  for (let i = 0; i < 10; i++) {
    try { await chrome.tabs.get(tabId); } catch (_) { break; }
    await sleep(200);
  }
  publishState.targetTabId = null;
  publishState.debuggerAttached = false;
  publishState.commandSent = false;
  publishState.stage = 'idle';

  if (publishState.settings.autoRetry && retries < max) {
    publishState.retryCounts[idx] = retries + 1;
    sendProgress(`超时重试 (${retries + 1}/${max})`, 'publishing', idx, publishState.videos.length);
    await persistState();
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
        status: 'failed', error: `阶段停滞(${stage})超时，重试${max}次后失败`,
        scheduled: false, scheduledTime: null
      });
      updateLastQueueStatus(failedVideo.name, 'failed');
    }
    publishState.currentIndex++;
    await persistState();
    await sleep(2000);
    _doneLock = false;
    if (publishState.isPublishing) await publishNextVideo();
  }
}

// ========== 完成 ==========

async function finishAllPublish() {
  if (_finishCalled) return;
  _finishCalled = true;
  console.log('[BG] 全部完成');
  sendProgress('全部完成', 'done', 1, 1, true);
  publishState.isPublishing = false;
  clearSkipNames();
  clearAbortFlag();
  clearPublishTimeout();
  clearNextVideoSchedule();
  await markLastQueueFinished();
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    await sleep(3000);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  for (const r of publishState.publishRecords) await savePublishRecord(r);
  clearPersistedState();
  const base = await serverBaseUrl();
  chrome.tabs.create({ url: `${base}/` });
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

// ★ 统一完成判定器（抖音/视频号/阶段上报共用）
// 校验完成信号属于当前视频（防止残留/延迟消息误判完成）
async function handlePublishCompleted(message) {
  if (!publishState.isPublishing || _doneLock) return;
  if (message.videoIndex !== undefined && message.videoIndex !== publishState.currentIndex) {
    console.log('[BG] 忽略过期发布完成信号:', message.videoIndex, '当前:', publishState.currentIndex);
    return;
  }
  _doneLock = true;
  clearPublishTimeout();
  const idx = publishState.currentIndex;
  const status = message.status || (message.success === false ? 'failed' : 'success');
  const videoName = message.videoName || publishState.videos[idx]?.name || '未知视频';

  // ★ 失败自动重试：未点击发布（安全阶段，clicked=false）的明确失败 → 自动重试
  // （已点击发布后的失败/未知 → 不重试，防止重复发布，直接记录）
  if (status === 'failed' && !message.clicked) {
    const retries = publishState.retryCounts[idx] || 0;
    const max = publishState.settings.maxRetries || 1;
    if (publishState.settings.autoRetry && retries < max) {
      publishState.retryCounts[idx] = retries + 1;
      console.log(`[BG] 发布失败，自动重试 (${retries + 1}/${max}): ${message.error || '未知原因'}`);
      sendProgress(`发布失败，自动重试 (${retries + 1}/${max})`, 'publishing', idx + 1, publishState.videos.length);
      // 失败时内容脚本已退出，残留标签页由 publishNextVideo 清理并重开
      await persistState();
      await sleep(1500);
      _doneLock = false;
      if (publishState.isPublishing) await publishNextVideo();
      return;
    }
  }

  const detail = status === 'success' ? 'done' : 'error';
  const statusText = status === 'success' ? '完成' : (status === 'unknown' ? '结果未知' : '失败');
  sendProgress(`${statusText}: ${videoName}`, detail, idx + 1, publishState.videos.length);
  publishState.publishRecords.push({
    videoName, videoPath: message.videoPath || publishState.videoPath || '',
    platform: publishState.platform, publishTime: new Date().toISOString(),
    status, error: status === 'success' ? '' : (message.error || '发布失败'),
    scheduled: message.scheduled || false, scheduledTime: publishState.scheduledTime
  });
  updateLastQueueStatus(videoName, status);
  publishState.stage = 'idle';
  publishState.clickedPublish = false;
  publishState.verifyWaited = false;
  if (publishState.targetTabId) detachDebugger(publishState.targetTabId);
  publishState.currentIndex++; publishState.debuggerAttached = false; publishState.commandSent = false;
  if (publishState.currentIndex < publishState.videos.length) {
    const old = publishState.targetTabId; publishState.targetTabId = null;
    if (old) setTimeout(() => chrome.tabs.remove(old).catch(() => {}), 3000);
    scheduleNextVideo(8000);
    await persistState();
  } else { await finishAllPublish(); }
}

async function handleVideoPublishDone() {
  const video = publishState.videos[publishState.currentIndex];
  await handlePublishCompleted({
    videoName: video?.name,
    // 统一判定器支持 videoIndex 校验，防止残留标签页延迟跳转误判当前视频完成
    videoIndex: publishState.currentIndex,
    status: 'success',
    scheduled: publishState.settings.scheduledPublish || false
  });
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
  const videoIndexForCommand = publishState.currentIndex;
  const video = publishState.videos[videoIndexForCommand];
  try {
    const r = await chrome.tabs.sendMessage(tabId, {
      action: 'startPublish', videos: [video], settings: publishState.settings,
      videoPath: publishState.videoPath, videoIndex: publishState.currentIndex, totalVideos: publishState.totalVideos
    });
    // 内容脚本明确报错（如找不到上传入口）→ 立即处理失败（含自动重试），不用等超时
    if (r && r.success === false && publishState.isPublishing && publishState.currentIndex === videoIndexForCommand) {
      console.error('[BG] 内容脚本发布失败:', r.error);
      await handlePublishCompleted({
        videoName: video.name, videoPath: publishState.videoPath || '',
        videoIndex: publishState.currentIndex, status: 'failed', error: r.error || '内容脚本执行失败',
        clicked: r.clicked || false
      });
    }
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

// 定时时间计算委托给共享纯函数（可单测）
function calculateScheduledTime(videoIndex, firstVideoScheduled = false) {
  const baseStr = publishState._originalScheduledTime || publishState.scheduledTime;
  return VPEPure.calculateScheduledTime(videoIndex, firstVideoScheduled, baseStr || null);
}

async function savePublishRecord(record) {
  try {
    const base = await serverBaseUrl();
    await fetch(`${base}/api/publish-record`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
  } catch (_) {}
}

// ========== SW 唤醒恢复 ==========
// MV3 的 Service Worker 在无事件 30 秒后可能被回收，内存态全部丢失。
// 每次唤醒（重启）时从 chrome.storage.session 恢复发布状态并重建定时器。

(async function restorePublishState() {
  try {
    const data = await chrome.storage.session.get(PERSIST_KEY);
    const s = data[PERSIST_KEY];
    if (!s || !s.isPublishing) return;

    publishState = {
      ...publishState,
      ...s,
      timeoutTimer: null,
      nextVideoTimer: null,
      _originalScheduledTime: s.originalScheduledTime || null,
      timeoutDeadline: s.timeoutDeadline || null,
      nextVideoDeadline: s.nextVideoDeadline || null,
    };
    _doneLock = false;
    _finishCalled = false;

    // 校验目标标签页是否仍存在
    if (s.targetTabId) {
      try {
        await chrome.tabs.get(s.targetTabId);
      } catch (_) {
        publishState.targetTabId = null;
        publishState.commandSent = false;
        publishState.debuggerAttached = false;
      }
    }

    // 重建定时器：有标签页在跑 → 重建超时定时器；无标签页且队列未完 → 重建推进定时器
    if (publishState.targetTabId) {
      if (publishState.timeoutDeadline) {
        const remain = publishState.timeoutDeadline - Date.now();
        if (remain > 2000) {
          try { chrome.alarms.create(TIMEOUT_ALARM, { when: publishState.timeoutDeadline }); } catch (_) {}
        } else {
          handlePublishTimeout().catch(() => {});
        }
      } else {
        startPublishTimeout();
      }
    } else if (publishState.currentIndex < publishState.videos.length) {
      scheduleNextVideo(2000);
    }

    console.log('[BG] 已从会话恢复发布状态 (index=', publishState.currentIndex, ', stage=', publishState.stage, ')');
  } catch (e) {
    console.error('[BG] 恢复发布状态失败:', e);
  }
})();

console.log('[BG] Service Worker started');
