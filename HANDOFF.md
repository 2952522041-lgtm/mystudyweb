# 项目交接文档

> 写给下一位接手的人。读完这份 + `README.md` + `PRODUCT_DESIGN.md` + `docs/TECHNICAL_SOLUTION.md` 就能上手。
> 最后更新：2026-08-31

## 一、项目是什么

「页语」——本地课程知识库、PDF 随页翻译与 AI 答疑阅读器。用户可把多份 PDF 组织到本地课程目录，生成带来源的总结与脑图；阅读时左侧读原文，右侧可切换随页译文、视觉答疑、PDF 总结和 PDF 脑图。产品范围、验收标准见 `PRODUCT_DESIGN.md`；架构设计见 `docs/TECHNICAL_SOLUTION.md`。

## 二、当前状态（Web MVP 已可用，下一步迁移 Windows 桌面端）

> **接手者先看这里：** 用户已经确认下一阶段不再优先修补网页目录选择器，而是把应用打包成 Windows 桌面程序。桌面程序启动时自动创建固定工作区，课程、PDF、总结、脑图和历史版本都直接写入该工作区。当前仓库尚未加入 Electron/Tauri 代码，工作树干净，不存在需要续写的半成品桌面实现。

已实现并经过真实浏览器端到端验证的能力：

| 能力                  | 状态 | 说明                                                                                   |
| --------------------- | ---- | -------------------------------------------------------------------------------------- |
| PDF 导入与解析        | ✅   | PDF.js，浏览器本地解析，不上传                                                         |
| 页面渲染              | ✅   | 连续滚动 + 页面虚拟化（远处页释放 canvas）+ 缩略图懒加载 + 缩放 + 跳页                 |
| 文字提取与段落重建    | ✅   | 行合并、双栏检测、连字符合并、段落推断（`lib/pdf-text.ts`）                            |
| 当前页判定            | ✅   | 最大可见面积规则 + 显示页码/翻译页码分离，页面稳定 300ms 后才翻译                      |
| 随页翻译              | ✅   | **流式输出**，段落边生成边显示；当前页完成后预取下一页                                 |
| 翻译供应商            | ✅   | OpenAI 兼容接口（用户自备 Key），内置演示供应商（不联网）                              |
| 缓存                  | ✅   | IndexedDB，逐页缓存；键含 provider/model/提示词版本，换配置不串缓存                    |
| 阅读进度恢复          | ✅   | 按文件 SHA-256 指纹；重新导入同一文件自动跳回上次页码                                  |
| 错误处理              | ✅   | 错误分类（网络/鉴权/限流/额度/服务端），透传服务端原始错误信息，瞬时错误自动重试 ≤2 次 |
| 扫描/手写 PDF         | ✅   | 抽样检测文字层；缺失时复用 AI 答疑视觉模型做逐页 OCR，结果仅缓存在本机                 |
| 重新翻译              | ✅   | 绕过缓存强制重翻并覆盖                                                                 |
| 翻译 / AI 双模式      | ✅   | 右侧顶部切换，左侧阅读位置保持不变                                                     |
| 当前页视觉答疑        | ✅   | 同时发送规范化文字和离屏渲染 PNG，支持图片、图表、表格和公式理解                       |
| 独立 AI 配置          | ✅   | 答疑 API 地址、Key、模型与翻译完全隔离，要求视觉模型                                   |
| 每页独立会话          | ✅   | IndexedDB 本地保存；翻页切换、返回恢复，流式回答归属原页面                             |
| AI 回答展示           | ✅   | Markdown + GFM + KaTeX，支持表格、代码和 LaTeX 公式                                    |
| 本地课程目录          | ✅   | File System Access API；创建/重连/重新授权，目录是唯一可信数据源                       |
| PDF 导入与去重        | ✅   | SHA-256 内容指纹；复制到 `PDFs/`，同名异内容加稳定后缀                                 |
| 内部摘要与单 PDF 成果 | ✅   | 全页文字提取，生成带页码来源的结构化摘要、Markdown 总结和 JSON/SVG 脑图                |
| 课程增量合并          | ✅   | 概念去重、来源追加、用户节点保护、revision 冲突检查                                    |
| 历史与恢复            | ✅   | 新版本提交前保存 `History/`，知识源使用版本化 JSON，用户笔记不覆盖                     |
| 课程/阅读器衔接       | ✅   | 课程总结和脑图来源可打开对应 PDF 页；阅读器新增 PDF 总结/脑图页签                      |

已实测的真实使用案例：港中深 MAT 3007 期中试卷（旧配置 `glm-4-flash`，整页十几秒，流式 2 秒内出首段）。当前推荐改用关闭深度思考的 `glm-4.7-flashx`。

## 三、技术栈与代码地图

React 19 + vinext（Vite 的 Next 兼容层，beta）+ PDF.js + Tailwind 4 + Base UI（shadcn 风格）+ Cloudflare Workers（部署目标）。

```
demo/
├─ app/page.tsx            # 阅读器主页面、稳定页码与右侧模式协调
├─ app/globals.css         # 主题与布局类
├─ components/ai-chat-panel.tsx       # 每页对话、流式状态、Markdown/公式展示
├─ components/reader-settings-dialog.tsx # 翻译与 AI 独立设置
├─ components/course-library.tsx          # 本地课程工作台
├─ components/course-import-dialog.tsx    # PDF 导入与独立生成选项
├─ components/knowledge-mindmap.tsx       # 课程/PDF 可追溯脑图
├─ components/document-summary-panel.tsx  # 阅读器中的单 PDF 总结
├─ lib/pdfjs.ts            # pdf.js 懒加载（worker 由 predev/prebuild 复制到 public/）
├─ lib/pdf-text.ts         # 文本提取规范化流水线 + sha256（纯函数，Node 可测）
├─ lib/translation.ts      # 供应商适配器、SSE 流式解析、错误分类、重试、缓存键、提示词
├─ lib/chat.ts             # 多模态答疑适配器、SSE、错误分类和安全提示词
├─ lib/chat-cache.ts       # 独立 AI 设置与逐页会话存储
├─ lib/page-vision.ts      # 固定质量离屏渲染与页面视觉输入
├─ lib/ocr.ts              # 视觉 OCR 适配、规范化和逐页缓存
├─ lib/reader-cache.ts     # KV 存储（IndexedDB/内存）、译文缓存、进度、设置
├─ lib/current-page.ts     # 当前页判定（纯函数）
├─ lib/reader-model.ts     # 缩放步进、页宽计算等纯函数
├─ lib/course-storage/     # 课程 schema、目录存储、内存实现、最近目录句柄
├─ lib/knowledge/          # 内部摘要、增量合并、Markdown/JSON/SVG 渲染
├─ tests/                  # node --test 单元测试 + 源码结构冒烟测试
├─ public/sample.pdf       # 测试语料：文字型 PDF
├─ public/scanned.pdf      # 测试语料：无文字层（扫描型）PDF
└─ scripts/copy-pdf-worker.mjs
```

设计要点（改动前先理解这几条）：

1. **缓存键 = 指纹+页码+原文哈希+目标语言+provider+model+提示词版本**。任何影响译文输出的因素变化都不会误用旧缓存。改提示词必须递增 `PROMPT_VERSION`。
2. **显示页码与翻译页码分离**。滚动即时更新显示页码；页面稳定 300ms 后才触发翻译；切换页面会 abort 未完成的请求。
3. **失败状态不写入缓存**，临时故障不会在下次打开时仍显示失败。
4. **提示词要求空行分段的纯文本**（流式友好），兼容旧 JSON 输出解析（`parseParagraphList`）。
5. **重新翻译走 `bypassCache`**，绕过会话内与持久缓存并覆盖结果。
6. **答疑请求使用不可变页面快照**。问题发出后绑定文档指纹和页码，用户翻页不会把回答写到新页面。
7. **页面图像按需生成且不持久化**。用户提问或无文字层页面需要 OCR 时才离屏渲染 PNG；IndexedDB 只保存完成的对话消息和 OCR 文字。
8. **PDF 内容是不可信数据**。答疑系统提示词要求忽略页面内试图改变规则的指令，只依据绑定页面作答。
9. **课程结构化 JSON 是合并依据**。Markdown 与 SVG 都是可重新生成的派生成果；活动知识版本由 `course.json` 指向 `Knowledge/knowledge-vN.json`。
10. **课程写入使用乐观 revision**。外部修改后会拒绝覆盖并要求重新加载；每次变更前先保存 History 快照，`course.json` 最后写入。

## 四、如何运行 / 测试 / 构建

```bash
./start.sh              # 一键本地使用（构建 + wrangler dev，自动挑空闲端口）
cd demo
pnpm dev                # 开发服务器 :3000（HMR）
pnpm test               # 单元测试与源码结构冒烟测试
pnpm lint               # oxlint（0 错误为交付标准）
npx tsc --noEmit        # 类型检查
pnpm build              # 生产构建
python3 -m unittest discover tests   # 根目录文档完整性测试
```

部署公开站点：推送 `master` 后由 GitHub Actions 自动部署 Pages（首次需在仓库 Settings → Pages 选择 GitHub Actions）；也可执行 `cd demo && npx wrangler deploy` 部署 Cloudflare Workers。

## 五、已知限制与建议路线

按优先级（对应技术方案的分阶段规划）：

1. **浏览器目录访问是当前主要阻塞项**。File System Access API 必须由用户触发系统目录选择器，不能稳定做到“启动即使用固定工作区”；Codex 内置浏览器的系统选择器也不适合自动化。不要继续用浏览器内部存储模拟一个看似真实的系统目录。
2. **桌面端尚未启动**。下一步按本文第七至第十节迁移 Electron；早期技术方案写过 Tauri 2，但结合当前 React/TypeScript/vinext 代码和交付 `.exe` 的目标，Electron 的迁移成本更低。
3. **浏览器 E2E 测试缺失**。现有 GitHub Actions 已执行 test + lint + tsc + Pages build，不要重复创建相同 CI。桌面迁移后应新增 Electron 主进程文件系统测试和一条 Windows 启动冒烟测试。
4. **无托管密钥的薄后端代理**。当前翻译和答疑 Key 存本地浏览器、浏览器直连供应商（已在设置界面告知）。公开运营前需按技术方案 6.4 和 15.8 建代理。
5. **源语言固定为 auto**，未做语言检测展示。
6. **双栏论文语料未覆盖**。`lib/pdf-text.ts` 的双栏检测有单元测试，但缺真实双栏论文验证；`public/` 里应补充双栏测试 PDF。
7. **vinext 是 beta**（1.0.0-beta.5），升级时注意 RSC 相关破坏性变更。
8. **真实视觉供应商需要人工冒烟**。自动测试使用模拟多模态响应；上线前需用目标供应商检查图片字段兼容、CORS、请求体限制和公式理解质量。
9. **课程摘要当前为本地结构化提取**。已实现完整目录、去重、来源、合并和版本流程；更高质量的语义归纳与“对话洞察自动提炼”仍需接入独立 `KnowledgeProvider`，当前导入选项只记录后续是否纳入对话洞察。

## 六、踩过的坑（重要）

- **pdf.js worker 不要用 `?url` 导入**：会破坏 SSR（`window is not defined`）。当前方案是 predev/prebuild/prepages 脚本把 worker 复制进 `public/`，`workerSrc` 按页面地址解析；Pages 构建必须先复制 worker。
- **翻译 effect 不要依赖自己的状态输出**：曾导致无限"翻译→abort"循环。会话内状态放 `translationStatesRef`，effect 只依赖页码/语言/文档。
- **react-compiler（oxlint）很严格**：effect 内同步 setState、渲染期写 ref、闭包引用判定都会报错，提交前必须 `pnpm lint` 清零。
- 翻译应关闭深度思考。当前推荐 `glm-4.7-flashx`（稳定低延迟）或 `deepseek-v4-flash`；设置界面有一键配置并默认发送 `thinking: disabled`。
- 两个推荐配置分别保存自己的 API Key；旧版单 Key 设置加载时只迁移到当前匹配的配置，不会复制到其他配置。
- **智谱返回的具体错误在 `error.message`**，应用已透传显示；排查用户问题先看译文面板的错误行。
- 本地多实例调试时注意端口占用：`start.sh` 会自动跳过被占端口。

## 七、最新诊断与用户最终决定（桌面迁移的背景）

### 7.1 已完成的真实诊断

用户反馈“课程知识库用不了”，并指定 `/home/yusicheng/Documents/1` 作为测试目录。诊断结果：

- `/home/yusicheng/Documents/1` 存在、当前为空，目录权限为当前用户可读写；不是文件夹损坏或权限位错误。
- 线上页面 `https://2952522041-lgtm.github.io/mystudyweb/?deploy=0927988` 可以正常进入课程知识库并打开“创建本地课程”对话框。
- 点击“选择文件夹并创建”后会进入浏览器/系统的目录授权流程。这个流程依赖 `window.showDirectoryPicker()` 和用户手动操作原生文件选择窗口，无法由普通网页静默指定固定目录。
- 课程存储实现本身已经有完整的创建、读取、导入、版本与恢复逻辑；当前主要问题是 Web 容器的目录授权边界，而不是 `BrowserDirectoryStorage` 不会写文件。
- 本轮诊断没有修改源代码。最新提交仍是 `0927988 feat: add visual OCR for scanned PDFs`。

### 7.2 用户确认的方向

用户希望应用变成 Windows 可运行程序：

1. 启动时自动创建一个固定工作区；
2. 每门课程在工作区内独立分区；
3. PDF、内部摘要、课程总结、课程脑图、历史版本都写入对应课程目录；
4. 不再要求用户每次通过浏览器选择和重新授权文件夹；
5. 最终交付 Windows `.exe` 或安装程序。

结论：**保留在线网页作为 Demo/临时 PDF 阅读器，完整课程知识库以桌面版为主。**

## 八、推荐桌面架构（Electron）

### 8.1 为什么优先 Electron

- 当前 UI、业务逻辑和测试全部是 TypeScript/React，Electron 主进程也是 Node.js/TypeScript，迁移时不需要把文件操作再写一遍 Rust 命令。
- 现有 `CourseStorage` 已经是明确的存储边界，可以增加桌面实现而不重写摘要、脑图、OCR、翻译和答疑。
- Electron 可以在主进程使用 `node:fs/promises`，通过受限 IPC 暴露课程文件能力，绕开浏览器 `showDirectoryPicker()`。
- 初版体积会大于 Tauri，但当前优先级是尽快得到可靠的 Windows 程序，而不是安装包最小化。

不要在 renderer 中打开 `nodeIntegration`，也不要把完整 `fs` 或任意路径读写能力挂到 `window`。保持 `contextIsolation: true`，由 preload 暴露白名单 API。

### 8.2 固定工作区

生产默认路径不要硬编码用户名或盘符，应由 Electron 主进程计算：

```text
path.join(app.getPath('documents'), '页语工作区')
```

Windows 上预期目录：

```text
C:\Users\<用户名>\Documents\页语工作区\
├─ Courses\
│  ├─ <课程目录>\
│  │  ├─ course.json
│  │  ├─ 课程总结.md
│  │  ├─ 课程脑图.json
│  │  ├─ 课程脑图.svg
│  │  ├─ 我的课程笔记.md
│  │  ├─ PDFs\
│  │  ├─ Documents\
│  │  ├─ Knowledge\
│  │  └─ History\
├─ Cache\
└─ Settings\
```

为了在 Linux 开发机复现用户指定目录，可以支持仅供开发/测试使用的环境变量：

```text
YEYU_WORKSPACE_ROOT=/home/yusicheng/Documents/1
```

默认值仍必须是系统“文档/页语工作区”，不能把上述 Linux 路径写进产品代码。

### 8.3 推荐进程边界

```text
React renderer
  └─ window.yeyuDesktop（preload 的 contextBridge 白名单）
       └─ ipcRenderer.invoke(...)
            └─ Electron main
                 ├─ 工作区路径解析与首次创建
                 ├─ 路径穿越检查
                 ├─ 课程目录扫描
                 └─ node:fs/promises 文件读写
```

建议 API 最小集合：

```ts
interface YeyuDesktopApi {
  getWorkspaceInfo(): Promise<{ root: string; coursesRoot: string }>;
  listCourses(): Promise<Array<{ directoryName: string; manifest: CourseManifest }>>;
  createCourseDirectory(name: string): Promise<{ directoryName: string }>;
  exists(courseDirectory: string, relativePath: string[]): Promise<boolean>;
  ensureDirectory(courseDirectory: string, relativePath: string[]): Promise<void>;
  readFile(courseDirectory: string, relativePath: string[]): Promise<Uint8Array>;
  writeFile(courseDirectory: string, relativePath: string[], data: Uint8Array): Promise<void>;
}
```

IPC 主进程必须做到：

- 课程目录名经过现有 `sanitizeFileName` 同等强度的处理；
- 所有相对路径使用 `path.resolve` 后验证仍位于 `Courses` 根目录内；
- 拒绝 `..`、绝对路径、空段、NUL 字节和符号链接逃逸；
- 写文件尽量采用“临时文件 → rename”方式，避免断电留下半个 `course.json`；
- 错误返回稳定的用户可读错误码/消息，不把 API Key 写入日志。

### 8.4 存储层改造方式

优先保留 `demo/lib/course-storage/types.ts` 的 `CourseStorage` 接口，新增：

```text
demo/lib/course-storage/desktop-course-storage.ts
```

它通过 `window.yeyuDesktop` 实现与 `BrowserDirectoryStorage` 相同的业务行为。为避免两份实现逐渐分叉，建议把以下纯业务流程从 `browser-directory-storage.ts` 抽出为共享函数：

- 初始化 `CourseManifest` 和空知识图谱；
- 生成/写入课程成果；
- revision 检查；
- 文档导入记录与增量合并；
- History 快照规则。

浏览器版本继续使用 `BrowserDirectoryStorage`；桌面版本使用 `DesktopCourseStorage`。不要让组件继续把 storage 类型写死成 `BrowserDirectoryStorage`，应改为：

```ts
type LabeledCourseStorage = CourseStorage & { readonly label: string };
```

### 8.5 课程工作台改造

重点文件：`demo/components/course-library.tsx`。

桌面环境检测建议使用 `typeof window.yeyuDesktop !== 'undefined'`。桌面模式下：

- 首次进入自动调用 `getWorkspaceInfo()` 并创建工作区；
- 自动扫描 `Courses/*/course.json`，不依赖 IndexedDB 中的目录句柄；
- “创建本地课程”只输入课程名，确认后自动创建课程子目录，不再弹系统文件夹选择器；
- 页面上显示实际工作区路径，并提供“在资源管理器中打开工作区”（可增加一个受限 IPC）；
- 浏览器模式保持现有目录选择流程，避免破坏在线 Demo；
- `recent-courses.ts` 只继续服务浏览器模式，桌面课程以磁盘扫描结果为准。

## 九、建议实施顺序（GLM 可直接照此执行）

### 阶段 A：建立 Electron 外壳

1. 在 `demo/` 安装 Electron 与 Electron Forge；遵循现有 pnpm 和 lockfile。
2. 新增 `demo/electron/main.ts`、`preload.ts`、类型声明和独立 tsconfig。
3. 首次启动创建工作区，窗口关闭时正常退出。
4. Electron 不直接加载线上 URL；必须加载本地构建产物，确保离线也能进入应用。
5. vinext 静态产物包含根绝对 `/_next/` 路径，直接 `file://` 可能失败。更稳妥的初版是在主进程启动仅监听 `127.0.0.1` 随机端口的只读静态文件服务器，然后 `BrowserWindow.loadURL()`；服务器只提供打包内 `dist/client`，不得暴露工作区。

### 阶段 B：实现安全文件桥接

1. 编写工作区路径解析和路径边界检查纯函数；先写单元测试。
2. 注册白名单 IPC handlers。
3. preload 用 `contextBridge.exposeInMainWorld` 暴露窄 API。
4. 给 `window.yeyuDesktop` 增加 TypeScript 全局声明。
5. 禁止 renderer 传入任意工作区根路径；开发环境覆盖值只由 main 读取环境变量。

### 阶段 C：接入课程存储

1. 新增 `DesktopCourseStorage` 并复用现有知识合并与成果渲染逻辑。
2. 将 `CourseLibrary` 中写死的 `BrowserDirectoryStorage` 类型改成公共存储类型。
3. 桌面启动扫描课程；创建后立即显示；重新启动仍能恢复。
4. 导入 `demo/public/sample.pdf`，验证 PDF 被复制、总结/脑图生成、课程 revision 增加。
5. 再用扫描件 `demo/public/scanned.pdf` 验证 OCR 配置缺失时有清晰提示，配置视觉模型后可导入。

### 阶段 D：Windows 打包

新增单独工作流，例如：

```text
.github/workflows/build-windows-desktop.yml
```

建议触发方式：`workflow_dispatch` + `v*` tag。工作流在 `windows-latest` 上执行：

1. checkout；
2. Node 22 + pnpm 10；
3. `pnpm install --frozen-lockfile`；
4. test、lint、tsc；
5. 构建本地 Web 产物；
6. `electron-forge make --platform win32 --arch x64`；
7. 上传 `out/make` 中的安装程序为 Actions artifact。

优先产出 x64 Windows 安装程序。ARM64 可在首版稳定后再加。未签名构建可能触发 SmartScreen，这是分发问题，不应通过关闭 Electron 安全选项规避；正式公开分发再配置代码签名。

### 阶段 E：保留网页发布

现有 `.github/workflows/deploy-pages.yml` 已经完整执行：

```text
根目录文档测试 → 前端测试 → lint → tsc → Pages 静态构建 → 部署
```

不要覆盖它。桌面工作流与 Pages 工作流分开；推送普通提交仍更新在线 Demo，发布 tag 时额外生成 Windows 安装包。

## 十、测试与验收清单

根据根目录 `AGENTS.md`，**每次改动都必须更新测试、全部验证通过并 git commit**。

### 10.1 必须新增的自动测试

- 工作区默认路径和 `YEYU_WORKSPACE_ROOT` 覆盖；
- 课程名清理、重名课程后缀策略；
- `../`、绝对路径、符号链接等路径逃逸全部被拒绝；
- 首次启动幂等创建 `Courses/Cache/Settings`；
- DesktopCourseStorage 初始化、保存、读取、导入、revision 冲突、History 快照；
- preload 只暴露白名单方法，不暴露 `ipcRenderer`/`fs`；
- 浏览器模式仍保留 `showDirectoryPicker` 和原有行为；
- Electron 打包配置确实包含 `dist/client`、main 和 preload 产物。

### 10.2 每次交付前运行

```bash
cd demo
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm pages
cd ..
python3 -m unittest discover tests
```

桌面依赖加入后再增加：

```bash
cd demo
pnpm desktop:build
pnpm desktop:test
```

Windows 安装包必须由 Windows runner 验证，Linux 上“配置能解析”不能等同于 `.exe` 已可运行。

### 10.3 用户验收流程

1. 在全新 Windows 用户环境安装并启动；
2. 自动出现 `Documents\页语工作区`，无需选择目录；
3. 创建课程“MAT3007”，生成独立课程目录与标准文件；
4. 导入文字型 PDF，能查看 PDF、总结和脑图；
5. 关闭程序并重新启动，课程自动恢复；
6. 修改课程后 `revision` 增加，`History` 保留旧版本；
7. API Key 不出现在课程目录、日志、提交或安装包中；
8. 在线 Demo 的 PDF 阅读、翻译、答疑和 OCR 仍可使用。

## 十一、接手时不要做的事情

- 不要继续尝试让普通网页静默写入固定系统目录；浏览器安全模型不会允许可靠实现。
- 不要把 `/home/yusicheng/Documents/1` 或某个 Windows 用户名硬编码到产品。
- 不要开启 `nodeIntegration: true`，不要关闭 `contextIsolation`，不要把任意 `fs` 调用暴露给页面。
- 不要重写 PDF 解析、OCR、翻译、答疑、摘要和脑图模块；这些已经可用，桌面迁移只替换容器和存储适配。
- 不要删除或替换现有 Pages 工作流；网页 Demo 需要继续部署。
- 不要把 API Key 写进固定工作区。初版可继续使用现有本地设置存储；后续桌面加固可迁移到 Electron `safeStorage` 或 Windows Credential Manager。
- 不要跳过提交。每一组通过验证的改动都要独立 `git commit`，便于用户回滚。

## 十二、交接起点

- 仓库：`https://github.com/2952522041-lgtm/mystudyweb.git`
- 分支：`master`
- 当前最新提交：`0927988 feat: add visual OCR for scanned PDFs`
- 公开 Demo：`https://2952522041-lgtm.github.io/mystudyweb/?deploy=0927988`
- 本地测试目录：`/home/yusicheng/Documents/1`（当前为空，仅用于 Linux 开发测试）
- 开始工作前先执行 `git status --short`；正常情况应为空。
- 建议第一笔提交只完成“Electron 外壳 + 固定工作区创建 + 安全路径测试”，不要把整个迁移塞进一个无法回滚的大提交。
