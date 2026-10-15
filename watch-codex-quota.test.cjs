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
assert.ok(waiting.includes('等待本次'));
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

const { runtimePaths, codexProcessIds } = require('./platform.cjs');
assert.equal(runtimePaths('win32', {}, '/example').windows,true);
assert.ok(runtimePaths('darwin', {CODEX_QUOTA_CLI:'/custom/codex'}, '/example').address.endsWith('.sock'));
assert.equal(runtimePaths('darwin', {CODEX_QUOTA_CLI:'/custom/codex'}, '/example').cli,'/custom/codex');
assert.equal(runtimePaths('linux', {}, '/example').logDirectory, require('node:path').join('/example','.cache','codex-until'));
assert.equal(runtimePaths('darwin', {}, '/example').logDirectory, require('node:path').join('/example','.cache','codex-until'));
assert.equal(runtimePaths('win32', {LOCALAPPDATA:'/local-app-data'}, '/example').logDirectory, require('node:path').join('/local-app-data','.cache','codex-until'));
const processFixture = '10 1 /Applications/Codex.app/Contents/MacOS/Codex\n11 10 /path/Codex Helper\n12 11 /bin/sh\n20 1 /usr/local/bin/codex\n21 20 /bin/node\n30 1 /usr/bin/node';
assert.deepEqual(new Set(codexProcessIds(processFixture,999)),new Set([10,11,12,20,21]));
assert.ok(!codexProcessIds(processFixture,21).includes(21));
console.log('Cross-platform paths and Codex process-tree selection passed.');
const stoppedPanel = renderPanel({ running: false, lines: [], color: false, showMenu: false });
assert.ok(stoppedPanel.includes('未启动'));
assert.ok(!stoppedPanel.includes('剩余额度'));
assert.ok(!stoppedPanel.includes('查询'));
assert.ok(!stoppedPanel.includes('PID'));
const statusPanel = renderPanel({ ...countdownOptions, color: false, showMenu: false, pid: 123 });
assert.ok(statusPanel.includes('PID 123'));
assert.ok(statusPanel.includes('93%'));
assert.ok(statusPanel.includes('下次重置'));
assert.ok(!statusPanel.includes('刷新间隔'));
assert.ok(!statusPanel.includes('转入后台'));
console.log('One-shot status panel checks passed.');

const { monitorLines } = require('./bin/terminal.cjs');
const directState = { running: true, quota: { primary: { usedPercent: 15, resetsAt: 1792649562 } }, lastSuccessfulAt: Date.parse('2026-10-15T08:45:00Z') };
assert.deepEqual(monitorLines(directState, '/missing/frontend/log'), []);
const directPanel = renderPanel({...directState, lines: [], color: false});
assert.ok(directPanel.includes('85%'));
assert.ok(!directPanel.includes('等待本次'));
const noSnapshot = renderPanel({...directState, quota: null, lines: countdownOptions.lines, color: false});
assert.ok(noSnapshot.includes('等待本次'));
assert.ok(!noSnapshot.includes('93%'));
console.log('Direct daemon quota rendering without frontend log access passed.');

const {requestRefresh} = require('./watch-codex-quota.cjs');
polling.querySequence=4; polling.successfulSequence=4; polling.querying=false;
const required=requestRefresh(testNow);
assert.equal(required,5);
assert.equal(requestRefresh(testNow),5);
polling.querying=true; polling.querySequence=5;
assert.equal(requestRefresh(testNow),5);
polling.querying=false;
const pendingPanel=renderPanel({...directState,lines:[],color:false,minimumSequence:5,successfulSequence:4});
assert.ok(!pendingPanel.includes('85%'));
assert.ok(pendingPanel.includes('等待本次'));
const freshPanel=renderPanel({...directState,lines:[],color:false,minimumSequence:5,successfulSequence:5});
assert.ok(freshPanel.includes('85%'));
console.log('Startup fresh-query gating and in-flight query reuse passed.');

const {logFileName, latestLog}=require('./platform.cjs');
assert.equal(logFileName(new Date(2026,9,15,16,50,30,123)),'codex-until-2026-10-15_16-50-30-123.log');
const logTestDirectory=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'codex-until-logs-'));
try {
  assert.equal(latestLog(logTestDirectory),null);
  for(const name of ['codex-until-2026-10-15_16-50-30-123.log','codex-until-2026-10-15_17-00-00-001.log','other.log'])require('node:fs').writeFileSync(require('node:path').join(logTestDirectory,name),'');
  assert.equal(require('node:path').basename(latestLog(logTestDirectory)),'codex-until-2026-10-15_17-00-00-001.log');
}finally{require('node:fs').rmSync(logTestDirectory,{recursive:true,force:true});}
console.log('Startup timestamp log naming and latest log selection passed.');
