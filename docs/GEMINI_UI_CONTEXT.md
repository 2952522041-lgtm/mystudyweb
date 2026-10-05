# Gemini UI/UX 上下文

页语是本地课程知识库与 PDF 阅读器，提供随页翻译、AI 答疑、笔记、复习、知识整理和局域网共享。当前任务仅重新设计和改进 UI/UX，保持现有功能、数据兼容性和 API 契约。

## 实际架构与入口

- 应用代码在 `demo/`，Web 与 Electron **共享同一套前端**，不是两套 UI。
- 前端：React 19、TypeScript、vinext（Vite，兼容 Next 风格 App Router）；PDF.js 负责 PDF 渲染。
- Web 入口：`demo/app/page.tsx`、`layout.tsx`；桌面加载同一前端的静态构建。
- Electron：`demo/electron/main.ts`、`preload.ts`；`api.ts` 定义 IPC 桥接契约，`global.d.ts` 声明浏览器端桥接类型。
- 后端：没有独立的传统数据库业务服务器。桌面主进程提供文件工作区、后台任务、DSH、局域网分享与本机 MCP 控制；Web 使用浏览器存储/目录授权并请求外部 AI 服务。默认 Web 服务构建面向 Cloudflare Workers，也可静态导出。
- 样式：Tailwind CSS 4，`demo/app/globals.css`，组件内工具类；公共 UI 使用 shadcn/Base UI、Lucide 图标。
- 主要界面：`demo/components/course-library.tsx`、`shared-pdf-reader.tsx`、`shared-course-viewer.tsx`、`ai-chat-panel.tsx`、`reader-settings-dialog.tsx`。
- 公共组件：`demo/components/ui/`；共享 hooks 在 `demo/hooks/` 和组件目录。
- API client：`demo/lib/openai-client.ts`、`dsh-client.ts`、`lan-share-api.ts`、`yeyu-mcp-control.ts`；存储桥接在 `lib/course-storage/desktop-course-storage.ts`。
- 资源：`demo/public/`、`demo/assets/`；依赖及锁文件：`demo/package.json`、`pnpm-lock.yaml`。

## 不应随 UI 改动的边界

保留 `demo/lib/` 中 PDF 提取、翻译/OCR、知识综合、缓存、存储结构、后台任务和重试规则；保留 `demo/electron/`、`demo/mcp/` 的 IPC、权限和接口契约。组件中也混有任务调度、阅读状态与数据保存逻辑，不能整体替换而丢失这些行为。保持桌面与 Web 的能力差异、快捷键、取消/恢复任务和现有测试。

## 本地运行与验证

使用 Node.js >=22.13 和 pnpm 10，在 `demo/` 执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
# 检查
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm build
pnpm desktop:web
pnpm desktop:test
```

Electron 冒烟需要图形会话；打包使用 `pnpm desktop:build`。API 密钥在应用设置中配置，不需要为启动填写密钥；外部 AI 能力需要用户自己的服务。可选公开站点变量见 `demo/.env.example`，桌面运行时变量见 README。Blackboard 可选同步需把 `scripts/blackboard/config.example.json` 复制为本地 `config.json` 后配置。

优先以源码与本文件判断当前实现；`PRODUCT_DESIGN.md`、`docs/TECHNICAL_SOLUTION.md` 包含历史规划（如 Tauri/SQLite），不代表当前技术栈。
