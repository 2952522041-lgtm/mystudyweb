# 页语 — 本地课程知识库、PDF 随页翻译与 AI 答疑阅读器

把多份 PDF 组织为本地课程知识库，生成带页码来源的总结与脑图；阅读时左侧显示原文，右侧可在随页翻译、AI 视觉答疑、PDF 总结和 PDF 脑图之间切换。

- **桌面版**（Electron）：完整课程知识库，固定使用系统「文档/页语工作区」，见下方「桌面版」章节
- **网页 Demo**：继续部署在 GitHub Pages，作为临时 PDF 阅读器与演示（受浏览器目录授权限制）

## 日常使用

```bash
./start.sh
```

然后打开 http://localhost:8787 （按 Ctrl+C 停止）。

1. 首次进入「课程知识库」，创建课程并选择一个本地文件夹；也可连接已有课程目录
2. 导入文字型、扫描或手写 PDF，并独立选择生成 PDF 总结/脑图、是否并入课程总成果
3. 在课程总结或脑图中点击来源，直接打开对应 PDF 和页码
4. 阅读器右侧可在「页面翻译」「AI 答疑」「PDF 总结」「PDF 脑图」之间切换
5. 也可以从顶部直接进入「PDF 阅读器」，临时打开不属于课程的 PDF

默认是**演示模式**（不联网，显示占位译文）。要看真实译文：打开「阅读服务设置」中的「页面翻译」，选择智谱或 DeepSeek 推荐配置，再填写对应平台的 API Key。也可以选择 OpenAI 兼容接口后手动填写服务地址和模型名。

AI 答疑需要单独配置 OpenAI 兼容接口、API Key 和支持图片输入的模型，并在保存前确认模型具备视觉能力。发送问题时，应用会把当前页提取文字和清晰页面图像一起发送给该服务，因此可以解读本页图片、图表、表格和公式，也可以用通用知识补充。使用智谱开放平台官方地址时，明确说“网上查”“联网搜索”等会先调用同一平台的网络搜索 API，再结合带 URL 的搜索结果回答；这可能产生供应商搜索费用。其他尚未适配搜索能力的兼容接口会明确提示，而不会假装已经联网。扫描或手写页面会复用这套视觉配置进行 OCR，识别文字按文档、页码、服务和模型缓存在本机，页面图像不持久化。每一页拥有独立会话，翻页后自动切换，回到原页时恢复历史。

翻译设置提供 `glm-4.7-flashx` 和 `deepseek-v4-flash` 预设，并关闭翻译请求的深度思考。实际费用、延迟和质量取决于供应商、模型与文档；预设不代表性能承诺。

- 服务设置、OCR、译文和答疑缓存保存在本机；课程成果与笔记写入课程目录。执行 AI 任务时，所需文字、问题和可选页面图像会发送到配置的服务；局域网共享由主电脑执行和保存
- 两个推荐配置分别保存自己的 API Key，切换模型不会串用密钥
- 桌面版会跨关闭和重启保留接口地址、模型、API Key 与翻译缓存，无需每次重新设置
- 同一文件再次打开时恢复页码、页内位置、缩放、右栏模式和分栏宽度；来源链接指定的页码优先，已翻译页面复用缓存
- 答疑草稿按文档、范围和页码独立保留，切换页面和重启后可继续编辑；草稿与已发送对话分开存储。中文输入法选词期间按 Enter 不发送
- 流式回答仅在接近底部时自动跟随，上滚后保留当前位置，可点「回到最新回答」继续跟随
- 当前页翻译完成后自动预取下一页，顺序阅读时减少等待
- 密集双栏论文按栏恢复阅读顺序；长页面自动分块翻译，遇到输出上限会拆小重试，不缓存残缺译文
- 数学符号在译文中原样保留：Office/PowerPoint 公式导出的数学专用字母（如 𝜑）会在提取后规范化为普通字符（φ），公式、希腊字母和运算符不会被丢弃或改写
- 翻译失败会显示具体原因，可点「重新翻译」重试

## 后台任务与 DSH

PDF 保存后即可阅读，AI 整理的状态在全局「后台任务」中查看。任务支持暂停、继续、取消和失败重试，也可批量暂停排队任务、继续暂停任务或重试失败任务。暂停和取消保留 PDF 与已完成成果，继续时复用有效缓存；失败、暂停和取消的任务不会自动重新执行。

桌面版由主进程监督独立的隐藏执行窗口，阅读界面重载不影响后台整理。后台执行窗口异常时有限次重建；退出应用会中断执行，下次启动从已保存的阶段恢复。网页版仍需要保持页面打开，重开后需恢复目录授权。这不是退出应用后继续运行的系统服务。

「阅读服务设置」可选 API 或 DeepSeek Harness（DSH）。DSH 设置展示各功能的后端与模型兼容性，保存前校验地址、模型、图片能力、密钥和本机运行时。运行时自检只检查本机组件；「测试当前栏目 DSH 连接」才会发送一次短请求。DSH 队列为交互任务保留一个并发槽，整理和预取使用较低优先级；具体模型、超时与诊断边界见 [DSH 后台接入](docs/DSH-INTEGRATION.md)。

## 本地课程知识库

- 网页版课程绑定用户授权的本地文件夹；桌面版课程使用系统文档目录下的页语工作区，课程文件是业务数据来源
- 单 PDF 总结、单 PDF 脑图、课程总总结和总脑图全部由 AI 生成，使用「阅读服务设置 → 知识库 AI」中独立保存的接口地址、API Key 与模型，与页面翻译、AI 答疑互不串用；知识库生成是纯文字任务，不要求视觉模型（扫描页 OCR 仍使用「AI 答疑」的视觉模型）。升级前若只配置过 AI 答疑，知识库 AI 会自动沿用那份配置
- 生成流程：PDF.js 提取文字（扫描页复用同一视觉模型 OCR）→ 按页面边界分块（约 8000–12000 字符，页码标签 `<page number="N">`）→ AI 分块分析 → AI 全文综合 → AI 课程综合；AI 未配置或失败时会明确报错，不会回退到本地规则结果
- AI 系统提示词把 PDF 内容视为不可信数据：忽略文档内指令、结论必须带来源页码、禁止编造页码与引用；来源页码超出 PDF 范围、`finish_reason=length` 截断或 JSON 解析两次失败的结果一律不保存
- 课程知识库由 AI 跨文档综合：概念去重、真实关系（包含/依赖/导致/对比/组成/应用/冲突）、文档间冲突与待解决问题；`ownership=user` 的用户节点不会被 AI 覆盖或删除
- 界面脑图与 SVG 使用同一份结构化数据与布局，按 AI relations 层次展开并显示关系标签；节点过多时折叠展示，完整结构始终保存在 JSON 中
- 创建课程会生成 `course.json`、`课程总结.md`、`课程脑图.json`、`课程脑图.svg`、`我的课程笔记.md`、`PDFs/`、`Documents/`、`Knowledge/` 和 `History/`
- 参与 AI 整理的 PDF 会生成结构化内部摘要；仅保存 PDF 时不调用 AI，即使暂不生成单 PDF 可见成果，也可以稍后整理并纳入课程
- PDF 按 SHA-256 内容指纹去重；同名但内容不同的文件会使用稳定后缀保存
- AI 结果按「指纹 + provider + model + 提示词版本 + schema 版本」缓存；模型、提示词或 PDF 内容变化后不会复用旧结果，重新生成会绕过缓存强制重跑 AI
- 课程列表提供继续阅读、名称搜索、最近阅读/最近导入排序，并区分已保存 PDF、独立总结/脑图和课程纳入状态
- 总结要点与脑图节点可「追问」或「保存笔记」：追问打开来源 PDF 并预填问题，需手动发送；摘记把正文、来源页码和时间追加到 `我的课程笔记.md`
- 课程「笔记」可编辑、预览和保存。保存时检查原文件内容版本；发现其他窗口或外部编辑会保留草稿并要求手动合并，AI 生成不会覆盖用户笔记。API Key 不写入课程目录
- 课程更新采用 revision 冲突检查，提交新版本前保留旧成果到 `History/`。「历史」提供只读预览和知识点、来源、关系等差异比较；快照不含完整 PDF、逐篇摘要和笔记，不提供整门课程恢复。旧版本本地规则成果仍能打开，重新生成后升级为 AI 版本
- 网页版课程目录功能要求支持 File System Access API 的桌面 Chrome / Edge，不支持时会明确提示

## 开发

代码在 `demo/`，技术栈 React 19 + vinext（Vite）+ PDF.js + Tailwind 4。

```bash
cd demo
pnpm dev        # 开发服务器 http://localhost:3000
pnpm test       # 单元测试（node --test）
pnpm lint       # oxlint
pnpm build      # 生产构建
```

核心模块：

- `demo/lib/pdf-text.ts` — PDF 文字提取与段落重建（双栏检测、连字符合并）
- `demo/lib/translation.ts` — 翻译供应商适配器、错误分类、重试与缓存键规则
- `demo/lib/ai-errors.ts` + `demo/lib/openai-client.ts` — AI 答疑与知识库共用的 OpenAI 兼容 SSE 客户端、错误分类
- `demo/lib/chat.ts` + `demo/lib/web-search.ts` — 多模态 AI 答疑、通用知识与按需联网搜索适配器
- `demo/lib/knowledge/ai-knowledge-provider.ts` — 知识库 AI Provider（分块分析、全文综合、课程综合、校验与缓存）
- `demo/lib/knowledge/pdf-chunks.ts` — 按页面边界的分块纯函数（页码标签、长页拆分）
- `demo/lib/knowledge/mindmap-layout.ts` — 界面脑图与 SVG 共用的关系型层次布局
- `demo/lib/page-vision.ts` — 当前页离屏渲染、视觉图像尺寸控制和文字上下文提取
- `demo/lib/ocr.ts` — 扫描/手写页面视觉 OCR、结果规范化和 IndexedDB 缓存
- `demo/lib/chat-cache.ts` — 独立 AI 设置与逐页对话的 IndexedDB 存储
- `demo/lib/reader-cache.ts` — IndexedDB 缓存、阅读进度、设置存储
- `demo/lib/current-page.ts` — 当前页判定（最大可见面积规则）
- `demo/lib/course-storage/` — 本地目录、课程清单、版本历史、去重与最近课程句柄
- `demo/lib/knowledge/` — 内部摘要、课程合并、Markdown/JSON/SVG 成果渲染
- `demo/components/course-library.tsx` — 正式课程工作台与课程/阅读器衔接
- `demo/lib/background-imports.ts` + `demo/electron/background-service.ts` — 持久化整理阶段、任务控制与独立桌面执行窗口
- `demo/electron/dsh-capabilities.ts` + `dsh-runtime.ts` + `dsh-dispatcher.ts` — DSH 能力校验、本机健康检查及有界优先队列

产品与架构文档见 `PRODUCT_DESIGN.md` 和 `docs/TECHNICAL_SOLUTION.md`。

## 桌面版（Electron）

桌面版是课程知识库的完整载体：启动即使用系统「文档」目录下的 `页语工作区`（自动创建 `Courses/Cache/Settings`），不需要每次授权目录；课程列表从磁盘扫描，关闭重启后自动恢复。

### Ubuntu 安装

```bash
cd demo
pnpm install
pnpm desktop:make          # 生成 out/make/deb/x64/yeyu_0.1.0_amd64.deb
sudo apt install ./out/make/deb/x64/yeyu_0.1.0_amd64.deb
```

安装后：

- GNOME 应用菜单出现「页语」（类别：Education），命令行入口为 `yeyu`
- 数据目录：`~/Documents/页语工作区/`；卸载：`sudo apt remove yeyu`
- 包名/可执行名/图标名为 `yeyu`，图标安装到 hicolor 各尺寸

仅构建不安装：`pnpm desktop:build` 产出打包目录 `out/Yeyu-linux-x64/`，ZIP 产物保留在 `out/make/zip/linux/x64/`。打包目录不等于正确安装：Ubuntu 的用户命名空间限制可能导致普通用户复制的 `chrome-sandbox` 无法从桌面启动。优先安装 DEB；不要添加 `--no-sandbox`。发布前须验证沙箱权限，并在桌面会话中冷启动，不能只验证开发终端。详见 [Linux 桌面启动与沙箱验证](docs/LINUX-DESKTOP-SANDBOX.md)。

### Windows 安装包

`.github/workflows/build-windows-desktop.yml`（手动触发或推送 `v*` tag）在 windows-latest 上测试并执行 `electron-forge make`，上传 Squirrel 安装程序（Setup.exe、.nupkg、RELEASES）为 Actions artifact。构建未签名，首次运行会触发 SmartScreen 提示。

### 安全边界

- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；preload 及其依赖被 esbuild 打包成单个自包含 CommonJS 文件（sandbox preload 不能加载拆分的本地模块）
- 主窗口只允许唯一的应用 origin（本地回环上的只读静态产物服务器）；离开该 origin 的导航一律拒绝，外部 http/https 链接改用系统浏览器打开；`setWindowOpenHandler` 默认 deny；未知协议拒绝
- renderer 只能通过 `window.yeyuDesktop` 的白名单方法访问课程文件；IPC 同时校验主 frame、应用 origin 和主窗口/后台窗口角色。所有相对路径都做穿越/符号链接检查，写入采用「临时文件 → rename」，课程写入保留版本校验与串行锁
- API Key 不写入工作区，也不出现在日志和安装包中
- 局域网共享默认关闭；开启时分别授权 PDF 导入、AI（翻译/答疑/成果重生成）和高权限课程管理。所有读写均需密码会话认证，写操作还需 CSRF；PDF 有文件头校验及 128 MiB 上限，AI/API Key 与对话存储留在主电脑，长任务支持从查看端取消。课程创建、术语表编辑和删除只有主电脑明确开放管理权限后才可用，且不暴露工作区任意路径或通用文件写入接口
- 局域网共享使用普通 HTTP，不提供加密传输；多网卡会列出多个非回环访问地址。完整的开启、Windows 访问与校园网连通性说明见 [`docs/LAN-SHARING.md`](docs/LAN-SHARING.md)

### 桌面开发与测试

```bash
cd demo
pnpm desktop:web        # 构建 vinext 静态产物（dist/client）
pnpm desktop:compile    # tsc 编译主进程 + esbuild 打包 preload（scripts/build-electron.mjs）
pnpm desktop:build      # web + compile + electron-forge package
pnpm desktop:make       # web + compile + electron-forge make（Linux 产出 deb + zip）
pnpm desktop:test       # electron 单元测试 + 真实启动冒烟测试（需要 DISPLAY）
```

`desktop:test` 会真实启动编译产物与 Linux 打包产物各两次，断言 `window.yeyuDesktop` 存在、`getWorkspaceInfo()` 完成真实 IPC 往返、创建课程并写入 `course.json` 后关闭重启仍能扫出该课程。环境缺少 DISPLAY 时冒烟会跳过并说明原因（也可配置 Xvfb）。

仅供开发/测试的环境变量（不会写入任何产物）：`YEYU_WORKSPACE_ROOT` 覆盖工作区根目录；`YEYU_DEV_URL` 只在未打包时生效，且只接受 `localhost`/`127.0.0.1`/IPv6 回环；`YEYU_SMOKE=1` 由自动化冒烟测试使用。

## MCP 自动化（桌面版）

页语桌面端启动时会建立一个仅监听 `127.0.0.1` 的控制端点，并把随机令牌写入工作区的 `Settings/mcp-control.json`（Unix 权限为 `0600`）。MCP Server 通过这个短生命周期令牌控制当前页语窗口；网页 Demo 不开放此能力。

先构建 MCP Server，并保持页语桌面端正在运行：

```bash
cd demo
pnpm mcp:build
```

在支持 stdio MCP 的客户端中，把服务器命令配置为 `node`，参数设为本仓库生成文件的绝对路径：

```json
{
  "mcpServers": {
    "yeyu": {
      "command": "node",
      "args": ["/absolute/path/to/learning_app/demo/electron/dist/yeyu-mcp.js"]
    }
  }
}
```

默认从系统“文档”目录下的 `页语工作区/Settings/mcp-control.json` 连接；Linux 会读取 `XDG_CONFIG_HOME`（未设置时为 `~/.config`）下 `user-dirs.dirs` 的 `XDG_DOCUMENTS_DIR`，未配置时回退到 `~/Documents`，Windows/macOS 默认使用 `~/Documents`。自定义工作区时给 MCP 进程设置 `YEYU_WORKSPACE_ROOT`；也可用 `YEYU_MCP_CONTROL_FILE` 直接指定控制文件（优先级：`YEYU_MCP_CONTROL_FILE` > `YEYU_WORKSPACE_ROOT` > 系统文档目录）。

`yeyu_import_pdf` 会先保存 PDF 并将后台整理任务加入队列，然后立即返回 `courseId`、`courseName`、`fileName`、`documentId`、`message` 和可选的 `processing`。这表示 PDF 已保存/任务已接受，不表示 AI 摘要、脑图或课程合并已经完成；调用超时或断开时不要重复提交。用 `yeyu_get_state` 查看对应 `course.documents` 的 `status`、`hasSummary`、`hasMindmap`、`includedInCourse` 和可选 `processing`（`queued`/`running`/`paused`/`failed`/`cancelled`）；没有 `processing` 表示当前没有后台任务，具体成果仍以各标记为准。

当前工具包括读取应用状态、显示课程库、打开课程、打开课程 PDF、跳页、切换阅读面板，以及 `yeyu_import_pdf`。导入工具只接受本机绝对路径下的普通 PDF（拒绝符号链接、非 PDF 和超过 128 MiB 的文件），然后复用页语现有导入事务写入课程。知识库 AI 和扫描件 OCR 可能产生服务费用；`generateSummary`、`generateMindmap` 和 `mergeIntoCourse` 仍控制对应的后台成果，默认开启。MCP 不提供任意文件读写、删除课程或读取 API Key 的能力。

也可以使用仓库内的 stdio CLI（先执行上面的 `pnpm mcp:build`，并保持页语桌面端运行）：

```bash
node scripts/yeyu-tool.mjs state
node scripts/yeyu-tool.mjs import <课程名称> /absolute/path/to/lecture.pdf
node scripts/yeyu-tool.mjs import --wait <课程名称> /absolute/path/to/lecture.pdf
```

CLI 默认只提交导入并明确报告当前状态，不把入队误报为整理完成；`--wait` 会使用返回的 `documentId` 只读轮询 `yeyu_get_state`，直到 `processing` 消失，并在输出中附带独立的 `completion.status`。若任务暂停或取消，立即停止等待，输出 `completion.status: paused/cancelled` 并以非零状态退出，提示到「后台任务」中继续或重试；PDF 与已完成成果保留，CLI 不自动恢复或重新导入。若后台整理失败，CLI 同样以非零状态退出并报告“PDF已保存，后台整理失败”；轮询异常或 30 分钟超时也不会重新导入。轮询过程中不会输出或重新使用控制文件中的令牌。

## Blackboard 定时同步

固定同步程序位于 `demo/scripts/blackboard/`，由现有定时任务调用。课程范围、preview 排除、内容哈希去重、PPT/PPTX 转换、MCP 导入与磁盘成果核验由代码执行，不依赖模型每轮重新设计流程。登录过期时明确停止并通知，不导出浏览器凭据。

具体执行步骤与异常处理见 [Blackboard 自动化操作规程](docs/BLACKBOARD-AUTOMATION.md)。当前使用 Codex 浏览器登录，仍需 Codex 运行；尚不属于独立于 Codex 的常驻系统服务。

## 部署为公开网站

两种方式任选：

**GitHub Pages（静态、免费）**：仓库已包含 `.github/workflows/deploy-pages.yml`，推送到 `master` 后会先执行测试、lint、类型检查和静态构建，再通过 GitHub Actions 自动部署。首次使用时，在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。站点地址为 `https://<用户名>.github.io/<仓库名>/`。本地也可在 `demo/` 目录执行 `pnpm pages` 检查 `dist/client/` 产物；脚本会根据 `GITHUB_REPOSITORY` 自动改写项目子路径，本地默认使用当前仓库名 `mystudyweb`。

**Cloudflare Workers**：在 `demo/` 目录执行 `npx wrangler deploy` 即可发布（需要登录 Cloudflare 账号）。注意：国内访问 `*.workers.dev` 不稳定。

注意：公开部署时翻译、AI 答疑与视觉 OCR 请求仍由浏览器直接发往各自配置的服务；如需托管密钥的代理后端，见技术方案第 6.4 和 15.8 节。
