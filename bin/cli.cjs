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
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
      const lastLog = latestLog(runtimePaths().logDirectory);
      if (lastLog && fs.existsSync(lastLog + '.result.json')) {
        return JSON.parse(fs.readFileSync(lastLog + '.result.json', 'utf8'));
      }
      return { running: false, logPath: watch.logPath };
    }
    throw error;
  }
}

function readMinRemaining(settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    watch.validateMinRemaining(settings.minRemaining);
    return settings.minRemaining;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read saved quota requirement: ${error.message}`);
  }
}

function saveMinRemaining(settingsPath, value) {
  watch.validateMinRemaining(value);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = settingsPath + '.tmp';
  fs.writeFileSync(temporaryPath, JSON.stringify({ minRemaining: value }) + '\n');
  fs.renameSync(temporaryPath, settingsPath);
}

async function daemon(minRemaining) {
  const settingsPath = path.join(runtimePaths().logDirectory, 'settings.json');
  if (minRemaining === undefined) minRemaining = readMinRemaining(settingsPath);
  else saveMinRemaining(settingsPath, minRemaining);
  watch.setMinRemaining(minRemaining);
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
      if (action.startsWith('min-remaining:')) {
        const value = action.slice('min-remaining:'.length);
        try {
          const requirement = value === 'reset' ? null : Number(value);
          saveMinRemaining(settingsPath, requirement);
          watch.setMinRemaining(requirement);
        }
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
  const hasCommand = args.length > 0 && !args[0].startsWith('-');
  let action = 'start';
  if (args[0] === '--daemon') action = '--daemon';
  else if (hasCommand) action = args[0];
  if (['--help', '-h'].includes(args[0])) return { action: 'help', foreground: false };
  const flags = hasCommand || action === '--daemon' ? args.slice(1) : args;
  let background = false;
  let minRemaining;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (['--background', '-b'].includes(flag)) background = true;
    else if (flag === '--min-remaining') {
      const value = flags[++index];
      if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(value)) {
        throw new Error('Minimum remaining percentage must be between 0 and 100');
      }
      minRemaining = Number(value.replace('%', ''));
      if (minRemaining > 100) throw new Error('Minimum remaining percentage must be between 0 and 100');
    } else throw new Error('Unknown option. Use --help.');
  }
  if (flags.length && !['start', '--daemon'].includes(action)) throw new Error('Options are only supported by start.');
  const options = { action, foreground: action === 'start' && interactive && !background };
  if (minRemaining !== undefined) options.minRemaining = minRemaining;
  return options;
}

async function startMonitor(minRemaining) {
  const monitorLogPath = runtimePaths().logPath;
  fs.mkdirSync(path.dirname(monitorLogPath), { recursive: true });
  const output = fs.openSync(monitorLogPath, 'a');
  const daemonArgs = [__filename, '--daemon'];
  if (minRemaining !== undefined) daemonArgs.push('--min-remaining', String(minRemaining));
  const child = spawn(process.execPath, daemonArgs, {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', output],
    env: { ...process.env, CODEX_UNTIL_LOG_PATH: monitorLogPath },
  });
  fs.closeSync(output);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await status();
    if (result.running || result.completed && result.logPath === monitorLogPath) return result;
  }
  throw new Error(`Monitor failed to start. See ${monitorLogPath}`);
}

async function restartMonitor(minRemaining) {
  const settingsPath = path.join(runtimePaths().logDirectory, 'settings.json');
  saveMinRemaining(settingsPath, minRemaining);
  const existing = await status();
  if (existing.running) {
    const result = await request(`min-remaining:${minRemaining === null ? 'reset' : minRemaining}`);
    if (result.error) throw new Error(result.error);
    return result;
  }
  return startMonitor();
}

async function main() {
  const { action, foreground, minRemaining } = parseOptions(process.argv.slice(2), Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (['help', '--help', '-h'].includes(action)) {
    console.log(`Codex Until (Windows / macOS / Linux, Node >=18)
Usage: codex-until [start|stop|status|quota|logs]
No command defaults to start. Without -b, show b/q controls in a terminal.
Non-interactive invocations run in the background.
  start   Start polling every 60 seconds; repeated calls are safe.
          --background / -b: start directly in the background.
          --min-remaining <0-100>: stop when any quota window reaches this remaining percentage.
  stop    Stop monitoring only. Codex sessions remain running.
  status  Show the current status panel once, without a menu.
  quota   Query quota once without enabling monitoring.
  logs    Print the last 50 log lines.
Meeting the stop condition stops ALL local Codex processes and their children.
Restarting the monitor establishes a fresh baseline. No baseline is persisted.`);
    return;
  }
  if (action === '--daemon') return daemon(minRemaining);
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
    if (minRemaining !== undefined) {
      const configured = await request(`min-remaining:${minRemaining}`);
      if (configured.error) throw new Error(configured.error);
      if (configured.minRemaining !== minRemaining) throw new Error('当前后台版本不支持百分比设置，请先 stop，再重新启动。');
    }
    if (foreground) await consoleMode({ status, request, restart: restartMonitor, logPath: watch.logPath });
    else {
      const refreshed = await request('refresh');
      console.log(JSON.stringify({ ...refreshed, quota: null, changed: false }));
    }
    return;
  }
  const result = await startMonitor(minRemaining);
  if (foreground) await consoleMode({ status, request, restart: restartMonitor, logPath: result.logPath });
  else console.log(JSON.stringify({ ...result, changed: true }));
}

module.exports = { parseOptions, readMinRemaining, saveMinRemaining };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
