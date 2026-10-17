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
const waiting = renderPanel({ running: true, lines: [], selected: 3, color: false });
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

const { setMinRemaining, stopReason } = require('./watch-codex-quota.cjs');
for (const invalid of [-1, 101, NaN, Infinity, '10']) assert.throws(() => setMinRemaining(invalid));
setMinRemaining(10);
assert.equal(stopReason(null, snapshot(89)), null);
assert.ok(stopReason(null, snapshot(90)));
assert.ok(stopReason(null, snapshot(95)));
assert.equal(stopReason(snapshot(90), snapshot(0, 200)), null);
const secondaryLow = snapshot(20);
secondaryLow.windows.secondary = { usedPercent: 95, resetsAt: 100, windowDurationMins: 300 };
assert.ok(stopReason(null, secondaryLow).startsWith('secondary:'));
setMinRemaining(0);
assert.ok(stopReason(null, snapshot(100)));
assert.equal(stopReason(null, snapshot(99)), null);
setMinRemaining(100);
assert.ok(stopReason(null, snapshot(0)));
setMinRemaining(null);
assert.equal(stopReason(null, snapshot(90)), null);
assert.ok(stopReason(snapshot(90), snapshot(0, 200)));
assert.equal(parseOptions(['--min-remaining', '10', '-b'], true).minRemaining, 10);
assert.equal(parseOptions(['start', '--min-remaining', '10%'], true).minRemaining, 10);
assert.equal(parseOptions(['--daemon', '--min-remaining', '0'], false).minRemaining, 0);
for (const value of ['-1', '101', 'NaN', '', '10abc']) {
  assert.throws(() => parseOptions(['--min-remaining', value], true));
}
assert.throws(() => parseOptions(['status', '--min-remaining', '10'], true));
const thresholdPanel = renderPanel({ running: true, lines: [], color: false, selected: 1, minRemaining: 10 });
assert.ok(thresholdPanel.includes('❯ 最小剩余'));
assert.ok(thresholdPanel.includes('≤ 10%'));
assert.ok(renderPanel({ running: true, lines: [], color: false }).includes('重置时结束'));
console.log('Minimum remaining threshold, CLI validation and panel checks passed.');

async function checkThresholdConfirmation() {
  const { EventEmitter } = require('node:events');
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = new EventEmitter();
  let panelOutput = '';
  output.write = text => { panelOutput = text; };
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, { stdin: input, stdout: output, env: { NO_COLOR: '1' } });
  const terminalModule = { exports: {} };
  let refreshPanel;
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('./bin/terminal.cjs'), 'utf8'), {
    module: terminalModule,
    require: name => name === 'node:readline' ? { emitKeypressEvents() {} } : require(name),
    process: fakeProcess, console: { log() {} }, setInterval: callback => { refreshPanel = callback; return 1; }, clearInterval() {},
  });
  const requests = [];
  let state = { running: true, minRemaining: 20, quota: null };
  const session = terminalModule.exports.consoleMode({
    restart: async value => {
      requests.push(`restart:${value}`);
      state = { running: true, minRemaining: value, quota: null, logPath: '/new-monitor.log' };
      return state;
    },
    status: async () => state,
    request: async action => {
      requests.push(action);
      if (action.startsWith('min-remaining:')) {
        const value = action.slice('min-remaining:'.length);
        state = { ...state, minRemaining: value === 'reset' ? null : Number(value) };
      }
      return { ...state, requiredSequence: 1 };
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'right' });
  input.emit('keypress', '', { name: 'right' });
  input.emit('keypress', '', { name: 'left' });
  assert.deepEqual(requests, ['refresh']);
  assert.ok(panelOutput.includes('21%（未保存）'));
  assert.ok(panelOutput.includes('≤ 20%'));
  input.emit('keypress', '', { name: 'return' });
  await settle();
  assert.deepEqual(requests, ['refresh', 'min-remaining:21']);
  assert.ok(!panelOutput.includes('未保存'));
  input.emit('keypress', 'r', {});
  assert.equal(requests.length, 2);
  input.emit('keypress', '', { name: 'return' });
  await settle();
  assert.equal(requests.at(-1), 'min-remaining:reset');
  input.emit('keypress', '1', {});
  input.emit('keypress', '0', {});
  assert.equal(requests.length, 3);
  input.emit('keypress', '', { name: 'return' });
  await settle();
  assert.equal(requests.at(-1), 'min-remaining:10');
  state = { ...state, running: false, completed: true, stoppedAt: Date.parse('2026-10-17T07:30:45Z'), stopReason: 'primary: remaining 10% <= 10%' };
  let sessionFinished = false;
  session.then(() => { sessionFinished = true; });
  await refreshPanel();
  await settle();
  assert.equal(sessionFinished, false);
  assert.ok(panelOutput.includes('已达到额度要求'));
  assert.ok(panelOutput.includes('已停止本机全部 Codex'));
  assert.ok(panelOutput.includes('终止时间'));
  assert.ok(panelOutput.includes(new Date(state.stoppedAt).toLocaleString('zh-CN', { hour12: false })));
  assert.ok(!panelOutput.includes('正在查询'));
  const countBeforeRestart = requests.length;
  input.emit('keypress', '5', {});
  assert.equal(requests.length, countBeforeRestart);
  input.emit('keypress', '', { name: 'return' });
  await settle();
  assert.equal(requests.at(-1), 'restart:5');
  assert.ok(panelOutput.includes('正在监控'));
  assert.ok(!panelOutput.includes('终止时间'));
  await refreshPanel();
  assert.ok(panelOutput.includes('正在监控'));
  assert.equal(sessionFinished, false);
  input.emit('keypress', 'b', {});
  await session;
  console.log('Terminal arrow, reset and numeric drafts only submit on Enter passed.');
}
checkThresholdConfirmation().catch(error => { console.error(error); process.exitCode = 1; });

const { readMinRemaining, saveMinRemaining } = require('./bin/cli.cjs');
const settingsDirectory = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'until-settings-'));
const settingsPath = require('node:path').join(settingsDirectory, 'settings.json');
try {
  assert.equal(readMinRemaining(settingsPath), null);
  for (const requirement of [10, 0, 100, 12.5, null]) {
    saveMinRemaining(settingsPath, requirement);
    assert.equal(readMinRemaining(settingsPath), requirement);
  }
  saveMinRemaining(settingsPath, 20);
  assert.throws(() => saveMinRemaining(settingsPath, -1));
  assert.equal(readMinRemaining(settingsPath), 20);
  require('node:fs').writeFileSync(settingsPath, '{broken');
  assert.throws(() => readMinRemaining(settingsPath), /Cannot read saved/);
} finally {
  require('node:fs').rmSync(settingsDirectory, { recursive: true, force: true });
}
console.log('Saved quota requirement round trips, reset mode and invalid settings checks passed.');
