/**
 * VPEPure — 共享纯函数模块
 *
 * 供 content scripts（全局变量）、background service worker（importScripts）、
 * Node.js 测试（require）三端共用。所有函数必须是无 DOM 依赖的纯函数。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VPEPure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIME_BY_EXT = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv'
  };

  function hasChinese(text) {
    return /[\u4e00-\u9fa5]/.test(text);
  }

  /**
   * 从文件名解析抖音星图任务：匹配 "小游戏-xxx" 格式，去尾"推广"
   * 返回 { activityName, searchTerm } 或 null
   */
  function parseTaskFromName(fileName) {
    const match = String(fileName || '').match(/^小游戏-(.+)/);
    if (!match) return null;
    const activityName = match[1].replace(/\.[^.]+$/, '');
    const searchTerm = activityName.replace(/推广$/, '').trim();
    if (!searchTerm) return null;
    return { activityName, searchTerm };
  }

  /**
   * 从文件名解析视频号活动与原创标记
   * 返回 { activityName, isOriginal }
   */
  function parseWeixinVideoName(videoName) {
    const result = { activityName: null, isOriginal: false };
    const name = String(videoName || '');
    const activityMatch = name.match(/小游戏-(.+?)(?:\.[^.]+$|$)/);
    if (activityMatch) {
      result.activityName = activityMatch[1].trim().replace(/[_-]+$/, '');
    }
    if (name.includes('原创')) result.isOriginal = true;
    return result;
  }

  /**
   * 视频号判断是否使用 AI 生成内容
   * 规则：
   * 1. 未勾选 AI 生成文案：跳过
   * 2. 文件名"-"前面不是中文或包含数字：跳过
   * 3. 整个文件名不含中文或包含数字：跳过
   */
  function shouldUseAI(videoName, autoGenerate) {
    if (!autoGenerate) return false;
    const nameWithoutExt = String(videoName || '').replace(/\.[^/.]+$/, '');
    if (nameWithoutExt.includes('-')) {
      const partBeforeDash = nameWithoutExt.split('-')[0];
      if (!hasChinese(partBeforeDash) || /\d/.test(partBeforeDash)) return false;
    } else {
      if (!hasChinese(nameWithoutExt) || /\d/.test(nameWithoutExt)) return false;
    }
    return true;
  }

  /**
   * 计算定时发布时间（格式 YYYY-MM-DD HH:MM）
   * - 有基准时间（用户设定）：第一个视频用基准时间，后续每个视频累加 40~88 分钟随机间隔
   * - 无基准时间：第一个视频在当前时间 +5~15 分钟
   */
  function calculateScheduledTime(videoIndex, firstVideoScheduled = false, originalScheduledTime = null) {
    let baseTime;
    const baseStr = originalScheduledTime || null;
    if (baseStr) {
      baseTime = new Date(baseStr);
    } else {
      baseTime = new Date();
      if (videoIndex === 0 && firstVideoScheduled) {
        baseTime.setMinutes(baseTime.getMinutes() + 5 + Math.floor(Math.random() * 10));
      }
    }
    for (let i = 0; i < videoIndex; i++) {
      baseTime.setMinutes(baseTime.getMinutes() + 40 + Math.floor(Math.random() * 49));
    }
    const p = v => String(v).padStart(2, '0');
    return `${baseTime.getFullYear()}-${p(baseTime.getMonth() + 1)}-${p(baseTime.getDate())} ${p(baseTime.getHours())}:${p(baseTime.getMinutes())}`;
  }

  /**
   * 按视频大小计算上传等待秒数（每 30MB 额外 +5s，上限 max）
   */
  function waitSecondsForFileSize(size, base = 8, max = 180) {
    const mb = (Number(size) || 0) / (1024 * 1024);
    return Math.min(Math.max(base + Math.ceil(mb / 30) * 5, base), max);
  }

  /**
   * 按文件名扩展名返回 MIME 类型
   */
  function mimeForName(name) {
    const ext = (String(name || '').split('.').pop() || 'mp4').toLowerCase();
    return MIME_BY_EXT['.' + ext] || 'video/mp4';
  }

  return {
    MIME_BY_EXT,
    hasChinese,
    parseTaskFromName,
    parseWeixinVideoName,
    shouldUseAI,
    calculateScheduledTime,
    waitSecondsForFileSize,
    mimeForName
  };
});
