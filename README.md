# VS Code Codex + Claude Code 协作工具包

[下载 v0.2.1 ZIP](downloads/vscode-codex-claude-kit-v0.2.1.zip?raw=true) · [SHA-256](downloads/SHA256SUMS.txt) · [审核记录](AUDIT.md)

Windows 上的实验性本地补丁，包含两个可独立安装的功能：

1. **可见会话协作**：Codex 通过 MCP 给已打开的 Claude Code 会话发消息，并读取该会话的实际回复、工具操作和状态。Claude Code 可继续使用用户已配置的 DeepSeek 后端。桥接不另起隐藏模型进程，也不强制固定的规划、执行、验收流程。
2. **Codex 额度文字**：在输入框底栏显示 `5h 37% | 1week 62%`，表示剩余额度，每 60 秒读取一次。缺失或读取失败显示 `--`，鼠标悬停可分别查看 5 小时和周额度的重置日期、时间与剩余时长（按本地时区显示）。

## 兼容范围

| 项目 | 已审核的版本/环境 |
| --- | --- |
| 操作系统 | Windows，原生 VS Code |
| Node.js | 22 或更新版本，无第三方 npm 依赖 |
| Claude Code 扩展 | `anthropic.claude-code` 2.1.318 |
| Codex 扩展 | `openai.chatgpt` 26.1021.22027 |

这不是官方跨插件接口。它修改本机已安装扩展的代码，依赖这些构建的内部结构；其他版本未验证，更新可能覆盖补丁。安装器会检查补丁位置，无法匹配时停止。项目不提供、不打包第三方扩展安装包或完整代码；安装备份只在用户电脑本地生成。

## 安装

先安装并登录所需扩展。Claude Code 的 DeepSeek 接入需要用户自行配置，本包不会读取、迁移或分发 API Key。Codex 的额度读取需要已登录且有相应额度数据的账号；API Key 模式可能没有这两种额度。

将源码解压到一个固定位置，双击 `安装.cmd`。已有 Node.js 22+ 和上述扩展时，会安装两个补丁，并尝试注册 `ds_worker` MCP。已有同名但指向其他安装的 MCP 配置会保留并提示，不会直接覆盖。

安装后在 VS Code 执行 **开发人员: 重新加载窗口**。安装目录仍被扩展引用，请勿移动或删除。

也可以在本目录运行：

```powershell
node install.cjs
node install.cjs --check
node install.cjs --bridge-only
node install.cjs --quota-only
node install.cjs --no-mcp
```

自定义扩展安装目录时，可设置 `CLAUDE_EXTENSION_DIR` 和 `CODEX_EXTENSION_DIR`，分别指向对应扩展的目录，不是其父目录。不会自动下载扩展或更新 Node。

## 使用协作

打开项目和中间 Claude Code 面板；恢复旧对话后如未建立活动通道，先手动发一句话并等它回复。支持可见的编辑器面板和侧边栏会话。对方忙时拒绝插队；多个候选会话需要指定 `session_id`。

在 Codex 中可以说：

> 把刚才的方案发给中间的 DS，让它先提建议，暂时不要改代码。

> 按已经商量好的内容交给中间的 DS 实现，等它回复后帮我检查改动。

工具：`ds_visible_sessions`、`ds_send_message`、`ds_reply_status`、`ds_cancel_message`。派发后继续调用状态工具读取回复；本包不会主动唤醒一个已闲置的 Codex 对话。请让两边避免同时修改同一文件。原有工具权限和审批继续由对应扩展处理。

用户手动插话后，桥接停止把后续回复归给旧任务。取消仅请求中断，已写入的代码不会自动回滚。网络/管道故障导致发送结果不明时，先检查原会话和请求编号，不能盲目重发；可为同一逻辑发送提供稳定 UUID `request_id`。

## 额度显示

使用当前本地 Codex 客户端的 `account/rateLimits/read`，通过原 RPC 通道读取；不直接读取认证文件。窗口重新获得焦点也会刷新，5 秒内重复触发会合并。组件卸载会取消请求，网络故障不继续显示旧数字。

两个周期按实际窗口长度匹配，不能把主额度窗口一律当成 5 小时窗口。服务端未返回某个周期时保留 `--`。此补丁显示本地账户额度；远程主机账户、多个账户切换和多窗口并发刷新没有做完整实机覆盖。

## 数据与边界

桥接仅监听本地 Windows 命名管道，使用每次启动生成的随机凭据。`ds-visible-bridge/state/` 存放连接凭据，`messages/` 存放协作消息和回复；不要分享这些目录。它不是面向同一用户账户下恶意程序的安全隔离机制。发送者提供的协作文本仍应作为普通外部上下文处理。

`.gitignore` 已排除运行状态、会话、备份、安装清单和哈希文件。打包时也必须使用源码白名单，不能直接压缩运行过的整个目录。不要把账号、订阅地址、代理配置或 API Key 加入仓库。

## 卸载与验证

双击 `卸载.cmd` 或运行 `node install.cjs --restore`，随后重载 VS Code。只有当前文件和安装记录匹配时才恢复原备份；遇到后续修改会停止，避免覆盖其他补丁。卸载后可再次安装。消息历史保留在本地，不会自动删除。

```powershell
npm test
node codex-quota-footer/read-live.cjs
```

后一条命令只读额度，会临时启动 bundled Codex app-server，不启动模型任务；需要网络环境与 VS Code 一致。如果终端无法直连，需沿用你自己的代理环境变量，不要将代理凭据写进仓库。

发布前结果和未覆盖范围见 [AUDIT.md](AUDIT.md)。本包属于实验版；测试通过不代表不存在任何 Bug。
