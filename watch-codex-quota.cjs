const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const logPath = path.join(process.env.LOCALAPPDATA || os.homedir(), 'codex-quota-guard', 'monitor.log');
function log(message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const line = `${new Date().toISOString()} ${message}`;
  fs.appendFileSync(logPath, line + '\n');
  console.log(line);
}

function readQuota() {
  return new Promise((resolve, reject) => {
    const desktopCli = path.join(process.env.LOCALAPPDATA || '', 'Programs/OpenAI/Codex/bin/codex.exe');
    const cli = process.env.CODEX_QUOTA_CLI || (fs.existsSync(desktopCli) ? desktopCli : 'codex.exe');
    const child = spawn(cli, ['app-server', '--stdio'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const cleanup = () => child.kill();
    process.once('exit', cleanup);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      process.removeListener('exit', cleanup);
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error('Quota query timed out')), 30000);
    child.stderr.resume();
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Quota query process exited')));
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) return finish(new Error(message.error.message));
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else {
        finish(null, message.result);
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'quota_watch', version: '1.0.0' },
    } });
  });
}

function getSnapshot(result) {
  const limits = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  if (!result.accountId || !limits || limits.limitId !== 'codex') {
    throw new Error('Missing Codex account or quota');
  }
  const windows = {};
  for (const name of ['primary', 'secondary']) {
    const window = limits[name];
    if (!window) continue;
    if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 ||
        window.usedPercent > 100 || !Number.isFinite(window.resetsAt) ||
        !Number.isFinite(window.windowDurationMins)) {
      throw new Error('Invalid quota window');
    }
    windows[name] = window;
  }
  if (!Object.keys(windows).length) throw new Error('No quota windows returned');
  return { accountId: result.accountId, windows };
}

function resetReason(previous, current) {
  if (!previous || previous.accountId !== current.accountId) return null;
  for (const [name, window] of Object.entries(current.windows)) {
    const before = previous.windows[name];
    if (!before || before.windowDurationMins !== window.windowDurationMins) continue;
    if (window.usedPercent < before.usedPercent) {
      return `${name}: used ${before.usedPercent}% -> ${window.usedPercent}%`;
    }
    if (window.resetsAt > before.resetsAt && window.usedPercent <= before.usedPercent) {
      return `${name}: reset time advanced`;
    }
  }
  return null;
}

function stopCodex() {
  // /T also stops tasks spawned by each Codex process.
  const result = spawnSync('taskkill.exe', ['/F', '/T', '/IM', 'codex.exe'], {
    windowsHide: true, encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to stop Codex: ${result.error?.message ?? result.stderr.trim()}`);
  }
  log('All local codex.exe processes and their child processes stopped.');
}

async function main(queryOnly = process.argv.includes('--once')) {
  let previous = null;
  log('Started. Polling every 60 seconds. Ctrl+C stops this monitor.');
  for (;;) {
    const started = Date.now();
    try {
      const current = getSnapshot(await readQuota());
      log(Object.entries(current.windows).map(([name, window]) =>
        `${name}: remaining ${100 - window.usedPercent}%, reset ${new Date(window.resetsAt * 1000).toISOString()}`
      ).join('; '));
      if (queryOnly) return;
      const reason = resetReason(previous, current);
      if (reason) {
        log(`RESET DETECTED: ${reason}. Stopping all local Codex sessions.`);
        stopCodex();
        return;
      }
      previous = current;
    } catch (error) {
      log(`ERROR: ${error.message}`);
      if (queryOnly) { process.exitCode = 1; return; }
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 60000 - (Date.now() - started))));
  }
}

module.exports = { getSnapshot, resetReason, main, logPath };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
