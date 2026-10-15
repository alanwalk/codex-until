# codex-until

监控 Codex 剩余额度，发现额度重置时结束本机所有 Codex 会话。

支持 Windows、macOS、Linux。需要 Node.js 18+，以及已登录 ChatGPT 账号的官方 Codex CLI 或桌面应用。

## 使用

```sh
npx @alanwalk/codex-until        # 打开交互面板
npx @alanwalk/codex-until -b     # 后台运行
npx @alanwalk/codex-until status # 查看状态
npx @alanwalk/codex-until stop   # 停止监控
npx @alanwalk/codex-until quota  # 查询一次额度
npx @alanwalk/codex-until logs   # 查看日志
```

`status` 输出一次当前状态面板，不显示操作菜单；未运行时只显示标题和“未启动”。

面板显示剩余额度、下次重置时间和查询倒计时。上下键选择操作，左右键切换刷新间隔：`10s / 30s / 1m / 5m`，默认 `1m`。

每次打开面板会主动刷新一次，返回前显示等待，不展示上次额度。已有查询会复用，限流退避期间仍按要求等待。`status` 只查看现有状态，不触发刷新。

- **转入后台**：关闭面板，继续监控。也可按 `b`。
- **停止并退出**：停止监控，保留 Codex 会话。也可按 `q` 或 `Ctrl+C`。

## 工作方式

通过官方 App Server 轻量查询额度，不发送模型请求。查询失败会自动退避；能取得 `Retry-After` 时遵守服务端等待时间。

同一账号、同一额度窗口的剩余百分比上升，或重置时间推迟且已用比例未增加，就视为重置。首次查询只建立基线，重启监控会重新建立基线。

**检测到重置后会强制结束本机全部 Codex 进程及其子进程，正在执行的任务会中断。** 服务器修正额度也可能触发。

## 路径

默认查找 Codex 桌面应用内的 CLI，找不到则使用 PATH 中的 `codex`。可用 `CODEX_QUOTA_CLI` 指定可执行文件完整路径。

日志位置：

- Windows：`%LOCALAPPDATA%/.cache/codex-until/`
- macOS / Linux：`~/.cache/codex-until/`

每次启动单独创建日志，按本地启动时间命名，例如 `codex-until-2026-10-15_16-50-30-123.log`。`logs` 查看当前监控日志；未运行时查看最近一次日志。
