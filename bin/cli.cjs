#!/usr/bin/env node
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const watch = require('../watch-codex-quota.cjs');
const userKey = crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16);
const pipe = `\\\\.\\pipe\\codex-quota-guard-${userKey}`;

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
  const server = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('data', data => {
      const action = data.toString().trim();
      const result = { running: action !== 'stop', pid: process.pid, logPath: watch.logPath };
      socket.end(JSON.stringify(result) + '\n', () => {
        if (action === 'stop') process.exit(0);
      });
    });
  });
  server.on('error', error => {
    if (error.code !== 'EADDRINUSE') console.error(error.message);
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  });
  server.listen(pipe, () => {
    watch.main().then(() => process.exit(process.exitCode || 0)).catch(error => {
      console.error(error.message);
      process.exit(1);
    });
  });
}

function parseOptions(args, interactive) {
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

async function consoleMode() {
  console.log('监控中：输入 b 回车转入后台；输入 q 回车停止监控并退出。Ctrl+C 同样停止监控。');
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  let lastLog = '';
  let busy = false;
  let closing = false;
  return new Promise(resolve => {
    const finish = async stop => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      try {
        if (stop) {
          const current = await status();
          if (current.running) await request('stop');
          console.log('监控已停止。Codex 会话保持运行。');
        } else console.log('已退出控制台，监控继续在后台运行。');
      } catch (error) { console.error(error.message); process.exitCode = 1; }
      input.close();
      process.removeListener('SIGINT', interrupt);
      resolve();
    };
    const interrupt = () => { void finish(true); };
    const refresh = async () => {
      if (busy || closing) return;
      busy = true;
      try {
        if (fs.existsSync(watch.logPath)) {
          const latest = fs.readFileSync(watch.logPath, 'utf8').trimEnd().split('\n').slice(-1)[0];
          if (latest !== lastLog) { console.log(latest); lastLog = latest; }
        }
        if (!(await status()).running) {
          console.log('后台监控已退出。');
          closing = true;
          clearInterval(timer);
          input.close();
          process.removeListener('SIGINT', interrupt);
          resolve();
        }
      } catch (error) { console.error(error.message); }
      finally { busy = false; }
    };
    const timer = setInterval(refresh, 1000);
    input.on('line', line => {
      const choice = line.trim().toLowerCase();
      if (choice === 'b') void finish(false);
      else if (choice === 'q') void finish(true);
      else console.log('输入 b 转入后台，或 q 停止并退出。');
    });
    input.on('SIGINT', interrupt);
    process.on('SIGINT', interrupt);
    input.on('close', () => { if (!closing) void finish(false); });
    void refresh();
  });
}

async function main() {
  const { action, foreground } = parseOptions(process.argv.slice(2), Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (['help', '--help', '-h'].includes(action)) {
    console.log(`Codex Until (Windows, Node >=18)
Usage: codex-until [start|stop|status|quota|logs]
No command defaults to start. Without -b, show b/q controls in a terminal.
Non-interactive invocations run in the background.
  start   Start polling every 60 seconds; repeated calls are safe.
          --background / -b: start directly in the background.
  stop    Stop monitoring only. Codex sessions remain running.
  status  Print monitor status as JSON.
  quota   Query quota once without enabling monitoring.
  logs    Print the last 50 log lines.
Reset detection stops ALL local codex.exe processes and their children.
Restarting the monitor establishes a fresh baseline. No baseline is persisted.`);
    return;
  }
  if (process.platform !== 'win32') throw new Error('This version supports Windows only.');
  if (action === '--daemon') return daemon();
  if (action === 'quota') return watch.main(true);
  if (action === 'logs') {
    if (!fs.existsSync(watch.logPath)) return console.log('No logs yet.');
    return console.log(fs.readFileSync(watch.logPath, 'utf8').trimEnd().split('\n').slice(-50).join('\n'));
  }
  if (!['start', 'stop', 'status'].includes(action)) throw new Error(`Unknown command: ${action}. Use --help.`);
  const before = await status();
  if (action === 'status') return console.log(JSON.stringify(before));
  if (action === 'stop') {
    const result = before.running ? await request('stop') : before;
    console.log(JSON.stringify({ ...result, changed: before.running }));
    return;
  }
  if (before.running) {
    console.log(JSON.stringify({ ...before, changed: false }));
    if (foreground) await consoleMode();
    return;
  }
  fs.mkdirSync(path.dirname(watch.logPath), { recursive: true });
  const output = fs.openSync(watch.logPath, 'a');
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', output],
  });
  fs.closeSync(output);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await status();
    if (result.running) {
      console.log(JSON.stringify({ ...result, changed: true }));
      if (foreground) await consoleMode();
      return;
    }
  }
  throw new Error(`Monitor failed to start. See ${watch.logPath}`);
}

module.exports = { parseOptions };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
