const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function runtimePaths(platform = process.platform, env = process.env, home = os.homedir()) {
  const windows = platform === 'win32';
  const key = crypto.createHash('sha256').update(home).digest('hex').slice(0, 16);
  const desktopCli = windows
    ? path.join(env.LOCALAPPDATA || '', 'Programs/OpenAI/Codex/bin/codex.exe')
    : '/Applications/Codex.app/Contents/Resources/codex';
  const logDirectory = windows ? path.join(env.LOCALAPPDATA || home, 'codex-quota-guard')
    : path.join(home, '.codex-until');
  let cli = env.CODEX_QUOTA_CLI;
  if (!cli) {
    if (fs.existsSync(desktopCli)) cli = desktopCli;
    else if (windows) cli = 'codex.exe';
    else cli = 'codex';
  }
  return {
    windows,
    address: windows ? `\\\\.\\pipe\\codex-quota-guard-${key}` : path.join(os.tmpdir(), `codex-until-${key}.sock`),
    logPath: path.join(logDirectory, 'monitor.log'),
    cli,
  };
}

function codexProcessIds(processList, ownPid = process.pid) {
  const processes = processList.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]), name: path.posix.basename(match[3]) }];
  });
  const targets = new Set(processes.filter(item => /^(codex|codex-(aarch64|x86_64)-.+)$/i.test(item.name)).map(item => item.pid));
  let added = true;
  while (added) {
    added = false;
    for (const item of processes) {
      if (targets.has(item.parent) && !targets.has(item.pid)) { targets.add(item.pid); added = true; }
    }
  }
  return [...targets].reverse().filter(pid => pid !== ownPid && pid > 1);
}

module.exports = { runtimePaths, codexProcessIds };
