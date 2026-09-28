# DeepSeek Harness 后台接入

页语保留现有界面、工作区、Windows 共享上传及成果格式。设置中的“AI 执行后端”可在 API / DeepSeek Harness 之间切换，默认 API。

## 范围

- DSH 接管 PDF 分块、文档/课程整理的纯文本模型调用。整份文档问答另有显式勾选项，默认关闭；开启后仅整文问答复用知识库的 DeepSeek 配置，图片问答仍用原配置。页语仍负责分批、证据来源校验、截断恢复和原子保存。
- 页面翻译、OCR、带图片的页面问答不走 DSH。不改写聊天或知识库的已保存凭据。
- 首版仅接受 `https://api.deepseek.com`（可带 `/v1`）、`deepseek-flash` 或 `deepseek-v4-pro`。Windows 共享浏览器通过正在运行的桌面宿主执行，不需要在 Windows 安装 DSH。
- 不向公网提供 DSH RPC，不在客户端网页放置主机命令接口。无桌面桥接或 DSH 失败时明确报错，不静默回退 API。

## 安装与构建

宿主需要 Node.js 22+、npm，执行：

```sh
cd demo
node scripts/install-dsh.mjs
pnpm desktop:build
```

安装脚本将官方 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-sdk-client` **均锁为 `0.1.7-rc.2`**，安装至用户目录 `.local/opt/yeyu-dsh-runtime-0.1.7-rc.2`，禁用 npm lifecycle scripts，并保存安装时的 Node 可执行文件供桌面快捷方式使用。不要将旧版 SDK 和新版 CLI 混装；这会导致 scope carrier 检查不兼容。运行时会验证两个包的版本。新版 SDK 必须使用 `profile/patches/processCwd` 启动选项；旧式 `command/args/cwd` 会被忽略，错误进入有工具的默认 profile，测试明确防止此回归。

桌面构建同时产出 `app.asar` 中的后台 worker 和独立 `resources/client` 前端；更新部署时必须同时更新，不能只复制 asar。

## 数据及安全边界

- 每次调用单独生成临时 DSH_HOME、工作目录和会话，只传入本次文本；不向 DSH 提供真实课程路径。
- SDK minimal profile 默认带 shell。页语显式禁用 Bash、PowerShell、PTY、subprocess 工具、MCP 资源及附加会话日志/API 扩展；保留官方 invariant 检查，sandbox policy 设为 read-only。
- 这是关闭工具能力与目录隔离，不是操作系统级恶意代码沙箱；官方运行时依然是本机受信程序。
- API key 经 worker stdin 和模型进程私有环境传递，不出现在启动参数、应用日志或前端进度中。模型文本仍会发送至用户配置的 DeepSeek 官方服务。
- 仅信任桌面主窗口的主 frame IPC；请求字段白名单，最多四个并行调用，每次调用上限 180 秒。取消、导航、窗口关闭和退出时终止任务并清理临时文件。此调用超时不是整份 PDF 的三分钟 SLA。
- 结果须收到匹配的 prompt 回执和明确完成事件。截断标记不会当成完整 JSON 保存。API 和 DSH 使用不同知识缓存空间，切换后不会将 API 缓存冒充 DSH 产物。

## 性能说明

DSH 是执行框架，不会提升模型本身的 token 生成速度，也不能绕过输出上限。页语现有的分块、有限重试和预算控制依然必要。复杂 PDF、OCR、多文档课程合并及深度思考可能超过三分钟，必须以实测报告为准。

2026-09-29 在当前宿主使用已安装的无工具 DSH 后端，测试已有 `xid-12544620_1.pdf`（59 页、3,683,807 字节、33,127 个提取字符、0 OCR 页），使用独立内存存储和空应用 AI 缓存：**140,612 ms** 完成。摘要、导图、单文档课程合并均成功，输出 16 个概念、103 个 sections。耗时包括本地读取、提取、模型整理和内存存储，不含 Windows 上传、实际磁盘保存或与其他文档合并。原有真实课程和成果未被此基准覆盖。完整本机报告：`/tmp/yeyu-dsh-pdf-verified.json`。

验证：609 项应用测试、18 项桌面启动/IPC 验证、1 项安装后 DSH profile/SDK 握手验证，以及 TypeScript、lint 和打包均通过。运行时验证命令：`node --test --experimental-strip-types tests/dsh-runtime.smoke.ts`（先执行安装脚本）。

参考：[官方项目](https://github.com/deepseek-ai/deepseek-harness)、[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。该项目仍为开发预览版。
