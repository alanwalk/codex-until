# @alanwalk/codex-until

Windows Codex 额度监控命令行工具。零 npm 依赖，Node.js 18 或以上。

需要已安装并通过 ChatGPT 账号登录的官方 Codex CLI / 桌面应用。工具复用本地登录状态，不打印 token。默认使用桌面应用 CLI，找不到时使用 PATH 中的 `codex.exe`；可通过 `CODEX_QUOTA_CLI` 指定完整可执行文件路径。

发布到 npm 后，无需预先执行 `npm install`，直接运行：

```powershell
npx @alanwalk/codex-until
npx --yes @alanwalk/codex-until status
npx --yes @alanwalk/codex-until stop
npx --yes @alanwalk/codex-until quota
npx --yes @alanwalk/codex-until logs
```

不带参数会立即开启监控：在交互终端中显示最新日志，输入 `b` 并回车转入后台，输入 `q` 并回车停止监控并退出，`Ctrl+C` 同样停止监控。转入后台只是退出控制台，监控进程及本次比较基线保持不变。输入流关闭时也会退出控制台并保留后台监控。

`start` 与无参数执行相同，在交互终端默认显示日志和 b/q 选项；使用 `-b / --background` 直接进入后台：

```powershell
npx @alanwalk/codex-until                      # 显示日志及 b/q 选项
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

## 本地验证

```powershell
npm run prepublishOnly
npm pack
```

当前包名是 `@alanwalk/codex-until`，未确认 npm 名称可用性。包内使用 files 白名单，不包含本机日志、测试或登录凭据。无需构建、无需 npm install。npx 首次运行仍需联网下载并缓存包。

## GitHub Actions 自动发布 npm

沿用 [alanwalk/svn-merge-tool](https://github.com/alanwalk/svn-merge-tool/blob/main/.github/workflows/npm-publish.yml) 的发布方式：发布 GitHub Release 后，检查通过才发布 npm。配置文件为 `.github/workflows/npm-publish.yml`，Node.js 24，使用 npm Trusted Publishing（OIDC），无需配置 `NPM_TOKEN`。

### 首次配置

1. 将项目上传到你自己的 GitHub 仓库，包含 `.github/workflows/npm-publish.yml`。
2. 确认 npm 账号有 `@alanwalk` scope 的发布权限。若该包尚不存在，先在本机完成首次发布：

   ```powershell
   npm login
   npm publish --access public
   ```

3. 打开 npm 网站中 `@alanwalk/codex-until` 的 Settings → Trusted Publisher，选择 GitHub Actions，填写实际 GitHub 用户/组织、仓库名，以及工作流文件名 `npm-publish.yml`。当前 workflow 未使用 GitHub Environment，此项留空；如果页面提供 Allowed actions，允许直接执行 `npm publish`。
4. 按 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/) 保存配置。上传源码本身不会触发发布；只有发布 GitHub Release 才触发。

### 后续发版

1. 修改代码，运行 `npm run prepublishOnly`。
2. 修改版本，例如运行 `npm version patch --no-git-tag-version`，然后提交并推送代码。
3. 在 GitHub 创建并发布 Release，tag 必须为 `v` 加 `package.json` 中的版本，例如 `v0.1.1`。tag 应指向准备发布的提交。
4. Actions 先在 Windows 上检查 tag、语法、帮助入口、判断测试及包内容，再在 Ubuntu 上使用 OIDC 执行 `npm publish`。全程无需安装 npm 依赖。

版本号必须是 npm 尚未发布的版本；相同版本不能重复发布。`package.json` 已设置 public access。Release 的 prerelease 标志不会自动切换 npm dist-tag，当前流程统一使用 `latest`，请只发布准备正式使用的版本。
