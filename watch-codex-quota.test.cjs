const assert = require('node:assert/strict');
const { getSnapshot, resetReason } = require('./watch-codex-quota.cjs');
const snapshot = (usedPercent, resetsAt = 100, accountId = 'account-a', duration = 10080) =>
  getSnapshot({ accountId, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: {
    usedPercent, resetsAt, windowDurationMins: duration,
  } } } });
assert.equal(resetReason(null, snapshot(50)), null);
assert.equal(resetReason(snapshot(50), snapshot(51)), null);
assert.equal(resetReason(snapshot(50), snapshot(50)), null);
assert.ok(resetReason(snapshot(50), snapshot(0, 200)));
assert.ok(resetReason(snapshot(50), snapshot(0)));
assert.ok(resetReason(snapshot(0), snapshot(0, 200)));
assert.equal(resetReason(snapshot(50), snapshot(0, 200, 'account-b')), null);
assert.equal(resetReason(snapshot(50), snapshot(0, 200, 'account-a', 300)), null);
assert.throws(() => snapshot(NaN));
assert.throws(() => getSnapshot({}));
console.log('10 quota reset checks passed. No processes were stopped.');
const { parseOptions } = require('./bin/cli.cjs');
assert.deepEqual(parseOptions([], true), { action: 'start', foreground: true });
assert.deepEqual(parseOptions([], false), { action: 'start', foreground: false });
assert.equal(parseOptions(['start'], true).foreground, true);
assert.equal(parseOptions(['start'], false).foreground, false);
assert.equal(parseOptions(['-b'], true).foreground, false);
assert.equal(parseOptions(['start', '-b'], true).foreground, false);
assert.equal(parseOptions(['start', '--background'], true).foreground, false);
assert.throws(() => parseOptions(['start', '-f', '-b'], true));
assert.throws(() => parseOptions(['start', '--foreground'], true));
assert.equal(parseOptions(['--help'], true).action, 'help');
assert.throws(() => parseOptions(['stop', '-f'], true));
assert.throws(() => parseOptions(['start', '--invalid'], true));
console.log('CLI mode option checks passed.');
assert.equal(parseOptions(['--daemon'], false).action, '--daemon');
const { renderPanel } = require('./bin/terminal.cjs');
const panel = renderPanel({ running: true, pid: 123, color: false, columns: 40, lines: [
  '2026-10-15T07:00:00.000Z primary: remaining 94%, reset 2026-10-22T06:12:42.000Z',
  'ERROR: request timed out',
] });
assert.ok(panel.includes('94%'));
assert.ok(panel.includes('❯ 刷新间隔'));
assert.ok(!panel.includes('ERROR: request timed out'));
assert.ok(!panel.includes('\x1b'));
assert.ok(!panel.includes('上次刷新'));
assert.ok(!panel.includes('最新记录'));
assert.ok(!panel.includes('Ctrl+C'));
assert.ok(panel.includes('下次重置'));
assert.ok(panel.includes('刷新失败，以上为上次成功数据'));
const refreshed = renderPanel({ running: true, color: false, lines: [
  '2026-10-15T07:01:00.000Z primary: remaining 93%, reset 2026-10-22T06:12:42.000Z',
] });
assert.ok(refreshed.includes('93%'));
assert.ok(!refreshed.includes('94%'));
const countdownOptions = { running: true, color: false, lines: ['2026-10-15T07:01:00.000Z primary: remaining 93%, reset 2026-10-22T06:12:42.000Z'] };
assert.ok(renderPanel({ ...countdownOptions, now: Date.parse('2026-10-15T07:01:15Z') }).includes('45 秒后查询'));
assert.ok(renderPanel({ ...countdownOptions, now: Date.parse('2026-10-15T07:01:16Z') }).includes('44 秒后查询'));
assert.ok(renderPanel({ ...countdownOptions, now: Date.parse('2026-10-15T07:02:01Z') }).includes('正在查询'));
assert.ok(!refreshed.includes('刷新失败'));
const waiting = renderPanel({ running: true, lines: [], selected: 2, color: false });
assert.ok(waiting.includes('等待首次'));
assert.ok(waiting.includes('❯ 停止监控'));
console.log('Terminal panel checks passed.');

const { polling, setIntervalMs } = require('./watch-codex-quota.cjs');
for (const interval of [10000, 30000, 60000, 300000]) {
  setIntervalMs(interval);
  assert.equal(polling.intervalMs, interval);
  const configured = renderPanel({ running: true, lines: [], selected: 1, color: false, intervalMs: interval, nextQueryAt: 45000, now: 0 });
  assert.ok(configured.includes('45 秒后查询'));
  assert.ok(configured.includes('刷新间隔'));
}
assert.throws(() => setIntervalMs(5000));
setIntervalMs(60000);
console.log('Polling interval and countdown checks passed.');

const { quotaParams, quotaError, retryAfterMs, recordFailure, recordSuccess, queryDeadline } = require('./watch-codex-quota.cjs');
assert.deepEqual(quotaParams, { excludeResetCreditDetails: true });
const testNow = Date.parse('2026-10-15T08:00:00Z');
assert.equal(retryAfterMs(quotaError({message:'429',data:{headers:{'Retry-After':'120'}}}), testNow),120000);
assert.equal(retryAfterMs(quotaError({message:'503',data:{headers:{'retry-after':'Thu, 15 Oct 2026 09:00:00 GMT'}}}),testNow),3600000);
assert.equal(retryAfterMs(new Error('HTTP 429 Retry-After: 90'),testNow),90000);
assert.equal(retryAfterMs(new Error('HTTP 429'),testNow),null);
assert.equal(retryAfterMs(new Error('Retry-After: nonsense'),testNow),null);
recordSuccess();
for(const delay of [60000,120000,240000,480000,960000,1800000,1800000]) {
  assert.equal(recordFailure(new Error('429'),testNow),delay);
}
recordSuccess();
assert.equal(recordFailure(quotaError({message:'429',data:{retryAfter:7200}}),testNow),7200000);
setIntervalMs(10000);
assert.equal(queryDeadline(testNow + 10000),testNow + 7200000);
recordSuccess();
assert.equal(polling.failureCount,0);
assert.equal(queryDeadline(testNow + 10000),testNow + 10000);
setIntervalMs(60000);
assert.ok(renderPanel({running:true,lines:[],color:false,now:testNow,cooldownUntil:testNow+120000}).includes('退避等待 · 120 秒后重试'));
console.log('Lightweight polling, Retry-After, backoff and cooldown protection checks passed.');

const { waitForNextQuery } = require('./watch-codex-quota.cjs');
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realNow = Date.now;
let scheduledDelay;
try {
  Date.now = () => testNow;
  global.setTimeout = (callback, delay) => { scheduledDelay = delay; return 1; };
  global.clearTimeout = () => {};
  recordFailure(quotaError({message:'429',data:{headers:{'retry-after':'7200'}}}),testNow);
  waitForNextQuery(testNow);
  setIntervalMs(10000);
  assert.equal(scheduledDelay,7200000);
  assert.equal(polling.nextQueryAt,testNow + 7200000);
  recordSuccess();
  recordFailure(quotaError({message:'503',data:{headers:{'retry-after':'3000000'}}}),testNow);
  setIntervalMs(10000);
  assert.equal(scheduledDelay,2147483647);
  assert.equal(polling.nextQueryAt,testNow + 3000000000);
} finally {
  recordSuccess();
  setIntervalMs(60000);
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  Date.now = realNow;
}
console.log('Live scheduler rescheduling and long Retry-After timer overflow checks passed.');
