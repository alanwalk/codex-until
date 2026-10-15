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
