const test = require('node:test');
const assert = require('node:assert');
const P = require('../chrome-extension/shared/pure.js');

test('parseTaskFromName: 小游戏-任务名.mp4', () => {
  assert.deepStrictEqual(P.parseTaskFromName('小游戏-任务名.mp4'), { activityName: '任务名', searchTerm: '任务名' });
});

test('parseTaskFromName: 去掉"推广"后缀', () => {
  assert.deepStrictEqual(P.parseTaskFromName('小游戏-任务名推广.mp4'), { activityName: '任务名推广', searchTerm: '任务名' });
});

test('parseTaskFromName: 普通文件名返回 null', () => {
  assert.strictEqual(P.parseTaskFromName('123-xxx.mp4'), null);
  assert.strictEqual(P.parseTaskFromName('abc.mp4'), null);
  assert.strictEqual(P.parseTaskFromName('小游戏-.mp4'), null);
});

test('parseWeixinVideoName: 活动名与原创标记', () => {
  assert.deepStrictEqual(P.parseWeixinVideoName('小游戏-任务名.mp4'), { activityName: '任务名', isOriginal: false });
  assert.deepStrictEqual(P.parseWeixinVideoName('小游戏-abc_-.mp4'), { activityName: 'abc', isOriginal: false });
  assert.deepStrictEqual(P.parseWeixinVideoName('原创-随便.mp4'), { activityName: null, isOriginal: true });
  assert.deepStrictEqual(P.parseWeixinVideoName('普通视频.mp4'), { activityName: null, isOriginal: false });
});

test('shouldUseAI: 规则判断', () => {
  assert.strictEqual(P.shouldUseAI('游戏-好玩.mp4', true), true);      // 中文前缀 → AI
  assert.strictEqual(P.shouldUseAI('123-xxx.mp4', true), false);      // 数字前缀 → 跳过
  assert.strictEqual(P.shouldUseAI('abc-xxx.mp4', true), false);      // 非中文前缀 → 跳过
  assert.strictEqual(P.shouldUseAI('好玩视频.mp4', true), true);      // 纯中文无横杠 → AI
  assert.strictEqual(P.shouldUseAI('好玩2.mp4', true), false);        // 含数字 → 跳过
  assert.strictEqual(P.shouldUseAI('abc.mp4', true), false);          // 无中文 → 跳过
  assert.strictEqual(P.shouldUseAI('游戏-好玩.mp4', false), false);   // 未开 AI → 跳过
});

test('calculateScheduledTime: 有基准时间时首个视频使用基准时间', () => {
  const t = P.calculateScheduledTime(0, true, '2026-08-13 10:30');
  assert.strictEqual(t, '2026-08-13 10:30');
});

test('calculateScheduledTime: 后续视频在基准时间上累加 40~88 分钟', () => {
  const base = new Date('2026-08-13T10:30:00');
  const t1 = P.calculateScheduledTime(1, true, '2026-08-13 10:30');
  const d = new Date(t1.replace(' ', 'T'));
  const diffMin = (d - base) / 60000;
  assert.ok(diffMin >= 40 && diffMin <= 88, `间隔应在 40~88 分钟，实际 ${diffMin}`);
  assert.match(t1, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('calculateScheduledTime: 无基准时间时首个视频在 5~15 分钟后', () => {
  const now = Date.now();
  const t = P.calculateScheduledTime(0, true, null);
  const diffMin = (new Date(t.replace(' ', 'T')) - now) / 60000;
  assert.ok(diffMin >= 5 && diffMin <= 15, `应在 5~15 分钟，实际 ${diffMin}`);
});

test('waitSecondsForFileSize: 按大小自适应并受上限约束', () => {
  assert.strictEqual(P.waitSecondsForFileSize(0), 8);
  assert.strictEqual(P.waitSecondsForFileSize(30 * 1024 * 1024), 13);   // 30MB → +5s
  assert.strictEqual(P.waitSecondsForFileSize(100 * 1024 * 1024), 28); // 100MB → +20s
  assert.strictEqual(P.waitSecondsForFileSize(10 * 1024 * 1024 * 1024), 180); // 上限 180s
  assert.strictEqual(P.waitSecondsForFileSize(1 * 1024 * 1024, 12), 17); // 自定义基准
});

test('mimeForName: 按扩展名映射', () => {
  assert.strictEqual(P.mimeForName('a.mp4'), 'video/mp4');
  assert.strictEqual(P.mimeForName('a.MOV'), 'video/quicktime');
  assert.strictEqual(P.mimeForName('a.webm'), 'video/webm');
  assert.strictEqual(P.mimeForName('noext'), 'video/mp4');
});
