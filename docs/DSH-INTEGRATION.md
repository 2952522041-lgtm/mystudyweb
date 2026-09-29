# DeepSeek Harness 后台接入

页语保留现有界面、工作区、Windows 共享上传及成果格式。设置中的“AI 执行后端”可在 API / DeepSeek Harness 之间切换，默认 API。

## 范围

- DSH 默认接管 PDF 分块、文档/课程整理。设置“所有 AI 任务统一走 DSH”后，整文问答、页面/图片问答、OCR 和翻译全部经后台执行。旧设置不会被自动扩大范围。页语仍负责分批、证据来源校验、截断恢复和原子保存。
- 执行后端和模型独立：知识整理及整文问答使用知识库配置的 DeepSeek；页面问答/OCR 保留聊天配置的 GLM，翻译保留翻译配置的 GLM。不改写已保存凭据。
- 支持 `https://api.deepseek.com`（可带 `/v1`）的 `deepseek-flash` / `deepseek-v4-pro`，以及 `https://open.bigmodel.cn/api/paas/v4` 的 `glm-4.6v` / `glm-4.5-air`。图片只接受内嵌 PNG/JPEG，禁用任意远程图片 URL。
- 显式联网搜索也进入同一后台队列，由固定智谱搜索工具执行；它不是放开 DSH Agent 自由浏览或任意工具权限。Windows 共享浏览器通过桌面宿主执行，无需安装 DSH。
- 不向公网提供 DSH RPC，不在客户端网页放置主机命令接口。无桌面桥接或 DSH 失败时明确报错，不静默回退 API。

## 安装与构建

宿主需要 Node.js 22+、npm，执行：

```sh
cd demo
node scripts/install-dsh.mjs
pnpm desktop:build
```

安装脚本将官方 `@deepseek-ai/dsh`、`dsh-sdk-client`、`dsh-llm-pi-ai` 和 `dsh-attachment-local` **均锁为 `0.1.7-rc.2`**，安装至用户目录 `.local/opt/yeyu-dsh-runtime-0.1.7-rc.2`，禁用 npm lifecycle scripts，并保存安装时的 Node 可执行文件供桌面快捷方式使用。不要将旧版 SDK 和新版 CLI 混装；这会导致 scope carrier 检查不兼容。运行时会验证包版本。新版 SDK 必须使用 `profile/patches/processCwd` 启动选项；旧式 `command/args/cwd` 会被忽略，错误进入有工具的默认 profile，测试明确防止此回归。

桌面构建同时产出 `app.asar` 中的后台 worker 和独立 `resources/client` 前端；更新部署时必须同时更新，不能只复制 asar。

## 数据及安全边界

- 每次调用单独生成临时 DSH_HOME、工作目录和会话，只传入本次文字和可选图片；不向 DSH 提供真实课程路径。附件存储仅供 SDK 内部图片处理，不开放文件工具。
- SDK minimal profile 默认带 shell。页语显式禁用 Bash、PowerShell、PTY、subprocess 工具、MCP 资源及附加会话日志/API 扩展；保留官方 invariant 检查，sandbox policy 设为 read-only。
- 这是关闭工具能力与目录隔离，不是操作系统级恶意代码沙箱；官方运行时依然是本机受信程序。
- API key 经 worker stdin 和模型进程私有环境传递，不出现在启动参数、应用日志或前端进度中。资料仍会发送至用户配置的 DeepSeek 或智谱官方服务。
- 仅信任桌面主窗口的主 frame IPC；请求字段白名单，最多四个并行调用、32 个在途任务、总请求数据 64 MB，排队至多 60 秒，每次执行上限 180 秒。取消、导航、窗口关闭和退出时终止任务并清理临时文件。这些超时不是整份 PDF 的三分钟 SLA。
- 结果须收到匹配的 prompt 回执和明确完成事件。截断标记不会当成完整 JSON 保存。API 和 DSH 使用不同知识缓存空间，切换后不会将 API 缓存冒充 DSH 产物。

## 性能说明

同课程答疑共享稳定排序、有长度上限的课程摘要、资料索引和术语前缀；页面/文档会话继续独立，不把全部历史塞入一个无限增长的对话。Windows 宿主问答和桌面采用同一课程上下文构造器。相同前缀有利于服务商的自动缓存，但“同一个项目/对话”本身不保证命中，也不保证最低费用。

本地已有 PDF 成果、翻译和 OCR 缓存继续复用；队列中完全相同的并发请求只执行一次，按模型、账户、输入及参数隔离，失败/截断结果不复用。完成后的显式重新生成会发起新调用，不被队列复用层拦住。

DSH 是执行框架，不会提升模型本身的 token 生成速度，也不能绕过输出上限。页语现有的分块、有限重试和预算控制依然必要。复杂 PDF、OCR、多文档课程合并及深度思考可能超过三分钟，必须以实测报告为准。

2026-09-29 在当前宿主使用已安装的无工具 DSH 后端，测试已有 `xid-12544620_1.pdf`（59 页、3,683,807 字节、33,127 个提取字符、0 OCR 页），使用独立内存存储和空应用 AI 缓存：**140,612 ms** 完成。摘要、导图、单文档课程合并均成功，输出 16 个概念、103 个 sections。耗时包括本地读取、提取、模型整理和内存存储，不含 Windows 上传、实际磁盘保存或与其他文档合并。原有真实课程和成果未被此基准覆盖。完整本机报告：`/tmp/yeyu-dsh-pdf-verified.json`。

回归验证包括应用测试、桌面启动/IPC、DeepSeek/GLM 安装后无工具 profile/SDK 握手、TypeScript、lint 和打包。运行时验证命令：`node --test --experimental-strip-types tests/dsh-runtime.smoke.ts`（先执行安装脚本）。

全 AI 版本已验证 638 项应用测试、18 项桌面启动/IPC 和 2 项安装后 DSH profile/SDK 握手测试；TypeScript、lint（已有警告，无错误）和打包通过。在已安装版本中，合成短文本翻译（GLM-4.5-Air）828 ms、图片 OCR（GLM-4.6V）1,773 ms、带页码引用的整文问答（DeepSeek Flash）1,048 ms、固定联网搜索返回 5 条结果 753 ms。此处是小样本真实链路验证，不代表任意文档的处理时长。

同一 59 页 PDF 在全 AI 部署版本再次空应用缓存测试：**181,125 ms**，目标 180,000 ms，`targetMet:false`。全部成果完成（28 个概念、132 个 sections），但不能报告“三分钟达标”。本地提取约 230 ms，分块完成于 39.1 秒，分批归并完成于 111.0 秒；最终模型输出在 137.9 秒时被校验拒绝，修复重试耗时约 43.3 秒，181.1 秒时完成。额外耗时包含模型输出质量导致的重试，并非可直接归咎于 DSH 启动开销。报告 `/tmp/yeyu-all-ai-pdf.json`；同样不含 Windows 上传、真实磁盘保存与多文档课程合并。

当前部署目录为 `.local/opt/yeyu-20260929-all-ai-dsh`，同时更新桌面快捷方式及 `.local/bin/yeyu`；后者供 Blackboard 自动任务启动宿主使用。旧版目录保留用于回滚，课程目录不迁移、不覆盖。

共享阅读器的页面翻译现在与桌面一致：打开翻译面板或翻页后先读取已发布译文，缺失时自动请求宿主，默认不绕过缓存。页面/语言稳定 350 ms 后才发起请求，隐藏的响应式面板和无 AI 权限的会话不自动生成；离开页面取消旧请求，迟到结果不覆盖当前页。失败或主动取消后不循环重试，保留手动重试；只有“重新翻译”已有译文才明确绕过缓存。已在共享网站的 `xid-12544620_1.pdf` 第 40 页验证无需点击生成即可显示 GLM 译文。

参考：[官方项目](https://github.com/deepseek-ai/deepseek-harness)、[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。该项目仍为开发预览版。
