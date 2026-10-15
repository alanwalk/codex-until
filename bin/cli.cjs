#!/usr/bin/env node
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { runtimePaths, latestLog } = require('../platform.cjs');
const { consoleMode, renderPanel, monitorLines } = require('./terminal.cjs');
const { spawn } = require('node:child_process');
const watch = require('../watch-codex-quota.cjs');
const { address: pipe, windows } = runtimePaths();

function request(action) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Monitor response timed out')));
    socket.on('connect', () => socket.write(action + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => {
      try { resolve(JSON.parse(response)); } catch { reject(new Error('Invalid monitor response')); }
    });
    socket.on('error', reject);
  });
}

async function status() {
  try { return await request('status'); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { running: false, logPath: watch.logPath };
    throw error;
  }
}

async function daemon() {
  let ownsSocket = false;
  let staleSocketRetried = false;
  const server = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('data', data => {
      const action = data.toString().trim();
      let requiredSequence;
      if (action === 'refresh') requiredSequence = watch.requestRefresh();
      if (action.startsWith('interval:')) {
        try { watch.setIntervalMs(Number(action.slice('interval:'.length))); }
        catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); return; }
      }
      const result = { running: action !== 'stop', pid: process.pid, logPath: watch.logPath,
        ...watch.polling, requiredSequence };
      socket.end(JSON.stringify(result) + '\n', () => {
        if (action === 'stop') process.exit(0);
      });
    });
  });
  server.on('error', async error => {
    if (!windows && error.code === 'EADDRINUSE' && !staleSocketRetried) {
      try {
        const existing = await status();
        if (existing.running) { process.exit(0); return; }
        fs.unlinkSync(pipe);
        staleSocketRetried = true;
        server.listen(pipe);
        return;
      } catch (failure) { console.error(failure.message); process.exit(1); return; }
    }
    if (error.code !== 'EADDRINUSE') console.error(error.message);
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  });
  process.once('exit', () => {
    if (ownsSocket && !windows) { try { fs.unlinkSync(pipe); } catch {} }
  });
  process.once('SIGTERM', () => process.exit(0));
  server.on('listening', () => {
    ownsSocket = true;
    if (!windows) fs.chmodSync(pipe, 0o600);
    watch.main().then(() => process.exit(process.exitCode || 0)).catch(error => {
      console.error(error.message);
      process.exit(1);
    });
  });
  server.listen(pipe);
}

function parseOptions(args, interactive) {
  if (args.length === 1 && args[0] === '--daemon') return { action: '--daemon', foreground: false };
  const hasCommand = args.length > 0 && !args[0].startsWith('-');
  const action = hasCommand ? args[0] : 'start';
  if (['--help', '-h'].includes(args[0])) return { action: 'help', foreground: false };
  const flags = hasCommand ? args.slice(1) : args;
  if (flags.some(flag => !['--background', '-b'].includes(flag))) {
    throw new Error('Unknown option. Use --help.');
  }
  const background = flags.some(flag => ['--background', '-b'].includes(flag));
  if (flags.length && action !== 'start') throw new Error('Mode options are only supported by start.');
  return { action, foreground: action === 'start' && interactive && !background };
}

async function main() {
  const { action, foreground } = parseOptions(process.argv.slice(2), Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (['help', '--help', '-h'].includes(action)) {
    console.log(`Codex Until (Windows / macOS / Linux, Node >=18)
Usage: codex-until [start|stop|status|quota|logs]
No command defaults to start. Without -b, show b/q controls in a terminal.
Non-interactive invocations run in the background.
  start   Start polling every 60 seconds; repeated calls are safe.
          --background / -b: start directly in the background.
  stop    Stop monitoring only. Codex sessions remain running.
  status  Show the current status panel once, without a menu.
  quota   Query quota once without enabling monitoring.
  logs    Print the last 50 log lines.
Reset detection stops ALL local Codex processes and their children.
Restarting the monitor establishes a fresh baseline. No baseline is persisted.`);
    return;
  }
  if (action === '--daemon') return daemon();
  if (action === 'quota') return watch.main(true);
  if (action === 'logs') {
    const current = await status();
    const logPath = current.running ? current.logPath : latestLog(runtimePaths().logDirectory);
    if (!logPath || !fs.existsSync(logPath)) return console.log('No logs yet.');
    return console.log(fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-50).join('\n'));
  }
  if (!['start', 'stop', 'status'].includes(action)) throw new Error(`Unknown command: ${action}. Use --help.`);
  const before = await status();
  if (action === 'status') {
    const lines = before.running ? monitorLines(before, watch.logPath) : [];
    console.log(renderPanel({ ...before, lines, showMenu: false,
      columns: process.stdout.columns || 80, color: Boolean(process.stdout.isTTY && !process.env.NO_COLOR) }));
    return;
  }
  if (action === 'stop') {
    const result = before.running ? await request('stop') : before;
    console.log(JSON.stringify({ ...result, changed: before.running }));
    return;
  }
  if (before.running) {
    if (foreground) await consoleMode({ status, request, logPath: watch.logPath });
    else {
      const refreshed = await request('refresh');
      console.log(JSON.stringify({ ...refreshed, quota: null, changed: false }));
    }
    return;
  }
  fs.mkdirSync(path.dirname(watch.logPath), { recursive: true });
  const output = fs.openSync(watch.logPath, 'a');
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', output],
    env: { ...process.env, CODEX_UNTIL_LOG_PATH: watch.logPath },
  });
  fs.closeSync(output);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await status();
    if (result.running) {
      if (foreground) await consoleMode({ status, request, logPath: watch.logPath });
      else console.log(JSON.stringify({ ...result, changed: true }));
      return;
    }
  }
  throw new Error(`Monitor failed to start. See ${watch.logPath}`);
}

module.exports = { parseOptions };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
