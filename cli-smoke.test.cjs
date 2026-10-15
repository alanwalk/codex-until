const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(action) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'bin/cli.cjs'), ...action], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, CODEX_QUOTA_CLI: path.join(__dirname, 'no-real-codex-for-smoke-test') },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

assert.equal(run(['status']).running, false, 'Smoke test requires no existing monitor');
try {
  const started = run(['start', '-b']);
  assert.equal(started.running, true);
  assert.equal(started.intervalMs, 60000);
  assert.equal(run(['start', '-b']).pid, started.pid);
  assert.equal(run(['status']).pid, started.pid);
} finally {
  run(['stop']);
}
assert.equal(run(['status']).running, false);
console.log('Background start, duplicate start, status and stop passed.');
