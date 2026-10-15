# @alanwalk/codex-until

Windows Codex 额度监控命令行工具。零 npm 依赖，Node.js 18 或以上。

菜单第一项为“刷新间隔”，左右键切换 `10s / 30s / 1m / 5m`，默认 `1m`；后两项为“转入后台”和“停止监控并退出”。

使用官方轻量轮询参数 `excludeResetCreditDetails: true`，跳过不需要的重置次数详情查询。查询失败自动退避：若 App Server 错误数据或文本中包含有效的 `Retry-After`，至少等待服务端要求的时间；否则依次等待 1、2、4、8、16、30 分钟，之后保持最多每 30 分钟重试。等待不会短于所选刷新间隔，成功后恢复所选间隔。退避期间修改刷新间隔不能提前结束服务端等待。

App Server 当前并不保证透传 HTTP 响应头，因此不能保证总能获取 `Retry-After`；无法获得时使用上述退避。面板显示退避倒计时，保留上次成功数据和额度比较基线。

终端面板展示剩余额度、下次额度重置时间（按本地时区显示），并逐秒更新距下次查询的预计倒计时。后台默认每 60 秒查询额度，可在菜单中上下选中“刷新间隔”，再用左右键切换 `10s / 30s / 1m / 5m`。修改即时应用到同一后台进程，转入后台后保持所选间隔；重新启动恢复默认 `1m`。后台按所选间隔查询额度，查询期间显示“正在查询”。查询失败时保留上次成功数据并提示错误；详细记录通过 logs 命令查看。

需要已安装并通过 ChatGPT 账号登录的官方 Codex CLI / 桌面应用。工具复用本地登录状态，不打印 token。默认使用桌面应用 CLI，找不到时使用 PATH 中的 `codex.exe`；可通过 `CODEX_QUOTA_CLI` 指定完整可执行文件路径。

无需预先执行 `npm install`，直接运行：

```powershell
npx @alanwalk/codex-until
npx --yes @alanwalk/codex-until status
npx --yes @alanwalk/codex-until stop
npx --yes @alanwalk/codex-until quota
npx --yes @alanwalk/codex-until logs
```

不带参数会立即开启监控：在交互终端中显示彩色状态面板、剩余额度进度条、查询倒计时和下次重置时间。使用方向键选择操作并回车确认，也可直接按 `b` 转入后台、按 `q` 停止监控并退出，`Ctrl+C` 同样停止监控。转入后台只是退出控制台，监控进程及本次比较基线保持不变。输入流关闭时也会退出控制台并保留后台监控。

`start` 与无参数执行相同，在交互终端默认显示状态面板和操作菜单；使用 `-b / --background` 直接进入后台：

```powershell
npx @alanwalk/codex-until                      # 显示状态面板和菜单
npx @alanwalk/codex-until start                # 同上
npx @alanwalk/codex-until -b                   # 直接后台运行
npx @alanwalk/codex-until start --background   # 同上，可简写 -b
```

通过自动化工具等非交互环境无参数执行时，默认后台启动，不等待输入。重复启动不会产生多个监控，前台模式可连接已有监控。`stop` 只停止监控，不停止 Codex。`status` 输出 JSON；表示后台监控进程可响应，不代表最近的额度请求一定成功，请结合 `logs` 查看查询结果。`--help` 显示帮助；添加 `--yes`（例如 `npx --yes @alanwalk/codex-until`）可跳过 npx 首次下载确认。

## 重置判断

首次成功查询只建立内存基线。后续对比上次成功查询，在账号、窗口名称和窗口时长相同的前提下，任一窗口满足以下条件即触发：

- 已用百分比下降，即剩余额度上升，哪怕只上升 1%。
- 重置时间推迟，且已用百分比没有增加。

查询失败记录日志并重试，不清空上一次成功结果。停止再启动重新建立基线，不比较监控停机期间的变化。服务端额度修正也可能满足上述规则。轮询存在约一分钟延迟，另加网络请求耗时。

**触发后执行 `taskkill /F /T /IM codex.exe`，强制结束本机所有 Codex 进程及其子进程，包括其他账号的本地会话，正在执行的任务会被中断。远程主机不受影响。** 成功后监控退出；停止失败会记录错误，后续继续尝试。没有自动消费额度重置次数的功能。

日志保存在 `%LOCALAPPDATA%\codex-quota-guard\monitor.log`，不写入 npx 缓存中的包目录。日志不包含凭据。后台监控没有开机自启功能。
