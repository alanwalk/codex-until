const fs = require('node:fs');
const readline = require('node:readline');

const intervals = [10000, 30000, 60000, 300000];
const intervalLabels = ['10s', '30s', '1m', '5m'];

function monitorLines(state, fallbackPath) {
  // Older daemons only expose a log path; new daemons return quota directly.
  if (state.quota !== undefined) return [];
  const logPath = state.logPath || fallbackPath;
  return logPath && fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-150) : [];
}

function renderPanel({ running, completed = false, stopReason, stoppedAt, pid, lines, selected = 0, columns = 80, color = true,
  minRemaining = null, thresholdInput = '', now = Date.now(), intervalMs = 60000, nextQueryAt, querying, cooldownUntil, showMenu = true,
  quota: snapshot, lastSuccessfulAt, lastError, minimumSequence = 0, successfulSequence = 0 }) {
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  const records = lines.map(clean);
  const quota = [...records].reverse().find(line => /remaining [\d.]+%/.test(line));
  let match = quota?.match(/^(\S+).*?remaining ([\d.]+)%, reset (\S+)/);
  if (snapshot !== undefined) {
    const fresh = successfulSequence >= minimumSequence;
    const window = fresh ? snapshot?.primary ?? snapshot?.secondary : null;
    match = window ? [null, new Date(lastSuccessfulAt).toISOString(), String(100 - window.usedPercent),
      new Date(window.resetsAt * 1000).toISOString()] : null;
  }
  const width = Math.max(8, Math.min(28, columns - 20));
  const latestRecord = records.at(-1) || '';
  const lastAttempt = Date.parse(latestRecord.split(' ')[0]);
  const deadline = nextQueryAt ?? lastAttempt + intervalMs;
  const secondsUntilQuery = Math.max(0, Math.ceil((deadline - now) / 1000));
  let queryStatus = '正在查询…';
  if (!querying && Number.isFinite(deadline) && secondsUntilQuery > 0) {
    queryStatus = `${secondsUntilQuery} 秒后查询`;
  }
  if (cooldownUntil > now) queryStatus = `退避等待 · ${Math.ceil((cooldownUntil - now) / 1000)} 秒后重试`;
  let monitorLabel = '○ 未启动';
  if (completed) monitorLabel = '● 监控已完成';
  else if (running) monitorLabel = '● 正在监控';
  const output = [
    '', paint('36', '  ╭───────────────────────╮'),
    paint('36', '  │') + paint('1;36', '  CODEX UNTIL          ') + paint('36', '│'),
    paint('36', '  ╰───────────────────────╯'), '',
    `  ${paint(running ? '32' : '33', monitorLabel)}${running ? '  ' + paint('90', `PID ${pid ?? '—'}`) : ''}`,
  ];
  if (completed) {
    output.push('', paint('1;32', '  已达到额度要求，已停止本机全部 Codex 进程及其子进程。'));
    if (Number.isFinite(stoppedAt)) {
      const stoppedTime = new Date(stoppedAt).toLocaleString('zh-CN', { hour12: false });
      output.push(`  终止时间  ${stoppedTime}`);
    }
    if (stopReason) output.push(`  ${clean(stopReason)}`);
    if (!showMenu) return output.join('\n');
    if (lastError) output.push(paint('33', `  ${clean(lastError)}`));
    output.push('', '  修改最小剩余后按回车，保存并重新启动；q 退出。');
  }
  if (!running && !completed) return output.join('\n') + '\n';
  if (!completed) {
    output.push(`  ${paint('36', queryStatus)}`);
    if (match) {
      const remaining = Math.max(0, Math.min(100, Number(match[2])));
      const filled = Math.round(width * remaining / 100);
      output.push('', `  剩余额度  ${paint('1;36', `${remaining}%`)}`,
        `  ${paint('36', '━'.repeat(filled))}${paint('90', '─'.repeat(width - filled))}`,
        `  下次重置  ${new Date(match[3]).toLocaleString('zh-CN', { hour12: false })}`);
    } else output.push('', '  剩余额度  —', '  下次重置  —',
      paint('90', '  正在等待本次额度查询…'));
    if (lastError || records.at(-1)?.includes('ERROR')) {
      output.push(paint('33', match ? '  刷新失败，以上为上次成功数据。' : '  本次查询失败，等待重试。'));
    }
    const stopDescription = minRemaining === null ? '额度重置后' : `任一窗口剩余 ≤ ${minRemaining}% 时`;
    output.push('', paint('90', `  ${stopDescription}，结束本机全部 Codex 会话。`), '');
  }
  if (!showMenu) return output.join('\n');
  const choices = intervalLabels.map((label, index) => intervals[index] === intervalMs ? `[${label}]` : label).join('  ');
  let thresholdLabel = minRemaining === null ? '重置时结束' : `${minRemaining}%`;
  if (thresholdInput) {
    const draftLabel = thresholdInput === 'reset' ? '重置时结束' : `${thresholdInput}%`;
    thresholdLabel = `${draftLabel}（未保存）`;
  }
  for (const [index, label] of [`刷新间隔  ‹ ${choices} ›`, `最小剩余  ‹ ${thresholdLabel} ›（回车保存 / r 恢复重置）`, '转入后台，继续监控', '停止监控并退出'].entries()) {
    if (completed && index !== 1) continue;
    output.push(index === selected ? paint('1;36', `  ❯ ${label}`) : paint('90', `    ${label}`));
  }
  output.push('');
  return output.join('\n');
}

async function consoleMode({ status, request, restart, logPath }) {
  let initial = await status();
  if (!initial.completed) initial = await request('refresh');
  if (!initial.completed && !Number.isFinite(initial.requiredSequence)) {
    throw new Error('当前后台版本不支持启动时刷新，请先 stop，再重新启动。');
  }
  let minimumSequence = initial.requiredSequence ?? 0;
  const input = process.stdin;
  const output = process.stdout;
  let selected = initial.completed ? 1 : 0;
  let busy = false;
  let closing = false;
  let changingInterval = false;
  let thresholdInput = '';
  let changingThreshold = false;
  let current = initial;
  let lines = [];
  let lastPanel = '';
  const wasRaw = input.isRaw;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write('\x1b[?1049h\x1b[?25l');
  return new Promise(resolve => {
    const draw = () => {
      if (closing) return;
      const panel = renderPanel({ ...current, lines, selected, thresholdInput,
        minimumSequence, columns: output.columns || 80, color: !process.env.NO_COLOR });
      if (panel === lastPanel) return;
      lastPanel = panel;
      output.write('\x1b[H\x1b[2J' + panel);
    };
    const finish = async (stop, message) => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      output.removeListener('resize', draw);
      process.removeListener('SIGINT', onInterrupt);
      let resultMessage = message;
      try {
        if (stop) {
          if ((await status()).running) await request('stop');
          resultMessage = '监控已停止，Codex 会话继续运行。';
        }
      } catch (error) { resultMessage = `停止失败：${error.message}`; process.exitCode = 1; }
      finally {
        input.setRawMode(Boolean(wasRaw));
        input.pause();
        output.write('\x1b[?25h\x1b[?1049l');
      }
      console.log(resultMessage || '已转入后台，监控继续运行。');
      resolve();
    };
    const changeInterval = async direction => {
      if (changingInterval || closing) return;
      changingInterval = true;
      try {
        const currentIndex = intervals.indexOf(current.intervalMs ?? 60000);
        const nextIndex = (currentIndex + direction + intervals.length) % intervals.length;
        const result = await request(`interval:${intervals[nextIndex]}`);
        if (result.error) throw new Error(result.error);
        if (!Number.isFinite(result.intervalMs)) throw new Error('当前后台版本不支持切换间隔，请停止后重新启动监控。');
        current = result;
        draw();
      } catch (error) { lines = [...lines, `ERROR: ${error.message}`]; draw(); }
      finally { changingInterval = false; }
    };
    const changeThreshold = async value => {
      if (changingThreshold || closing) return;
      changingThreshold = true;
      try {
        let result;
        if (current.completed) {
          result = await restart(value);
          minimumSequence = 0;
          lines = [];
          logPath = result.logPath;
        } else {
          result = await request(`min-remaining:${value === null ? 'reset' : value}`);
        }
        if (result.error) throw new Error(result.error);
        if (result.minRemaining !== value) throw new Error('当前后台版本不支持百分比设置，请停止后重新启动监控。');
        current = result;
        thresholdInput = '';
        draw();
      } catch (error) { current.lastError = error.message; lines = [...lines, `ERROR: ${error.message}`]; draw(); }
      finally { changingThreshold = false; }
    };
    const onKey = (text, key = {}) => {
      if (changingThreshold) return;
      if (current.completed) {
        selected = 1;
        if (text === 'q' || text === 'b' || key.ctrl && key.name === 'c') {
          void finish(false, '监控已完成。');
          return;
        }
        if (key.name === 'up' || key.name === 'down') return;
      }
      if (key.name === 'up') { selected = (selected + 3) % 4; draw(); }
      else if (key.name === 'down') { selected = (selected + 1) % 4; draw(); }
      else if (selected === 0 && key.name === 'left') void changeInterval(-1);
      else if (selected === 0 && key.name === 'right') void changeInterval(1);
      else if (selected === 1 && /^[0-9.]$/.test(text || '')) {
        if (thresholdInput === 'reset') thresholdInput = '';
        thresholdInput += text;
        draw();
      }
      else if (selected === 1 && key.name === 'backspace') { thresholdInput = thresholdInput.slice(0, -1); draw(); }
      else if (selected === 1 && key.name === 'return' && (thresholdInput || current.completed)) {
        let value = current.minRemaining;
        if (thresholdInput === 'reset') value = null;
        else if (thresholdInput) value = Number(thresholdInput);
        void changeThreshold(value);
      }
      else if (selected === 1 && text === 'r') { thresholdInput = 'reset'; draw(); }
      else if (selected === 1 && ['left', 'right'].includes(key.name)) {
        let value = current.minRemaining ?? null;
        if (thresholdInput === 'reset') value = null;
        else if (thresholdInput) value = Number(thresholdInput);
        if (key.name === 'left') {
          thresholdInput = value === null || value <= 0 ? 'reset' : String(Math.max(0, value - 1));
        } else {
          thresholdInput = String(Math.min(100, (value ?? -1) + 1));
        }
        draw();
      }
      else if (key.name === 'return' && selected >= 2) void finish(selected === 3);
      else if (text === 'b') void finish(false);
      else if (text === 'q' || (key.ctrl && key.name === 'c')) void finish(true);
    };
    const onEnd = () => { void finish(false); };
    const onInterrupt = () => {
      if (current.completed) void finish(false, '已达到额度要求，已停止本机全部 Codex 进程。');
      else void finish(true);
    };
    const refresh = async () => {
      if (busy || closing || changingThreshold || current.completed) return;
      busy = true;
      try {
        const updated = await status();
        if (changingThreshold || closing) return;
        current = updated;
        lines = monitorLines(current, logPath);
        if (closing) return;
        draw();
        if (current.completed) { selected = 1; draw(); }
        else if (!current.running) await finish(false, '后台监控已退出，请用 logs 查看原因。');
      } catch (error) { lines = [...lines, `ERROR: ${error.message}`]; draw(); }
      finally { busy = false; }
    };
    const timer = setInterval(refresh, 1000);
    input.on('keypress', onKey);
    input.on('end', onEnd);
    output.on('resize', draw);
    process.on('SIGINT', onInterrupt);
    draw();
    void refresh();
  });
}

module.exports = { consoleMode, renderPanel, monitorLines };
