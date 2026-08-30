# 项目交接文档

> 写给下一位接手的人。读完这份 + `README.md` + `PRODUCT_DESIGN.md` + `docs/TECHNICAL_SOLUTION.md` 就能上手。
> 最后更新：2026-08-30

## 一、项目是什么

「页语」——PDF 随页翻译与 AI 答疑阅读器。用户导入外文 PDF，左侧读原文，右侧可切换随页译文和基于当前页文字、图片及公式的视觉答疑。产品范围、验收标准见 `PRODUCT_DESIGN.md`；架构设计见 `docs/TECHNICAL_SOLUTION.md`。

## 二、当前状态（MVP 已可用）

已实现并经过真实浏览器端到端验证的能力：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| PDF 导入与解析 | ✅ | PDF.js，浏览器本地解析，不上传 |
| 页面渲染 | ✅ | 连续滚动 + 页面虚拟化（远处页释放 canvas）+ 缩略图懒加载 + 缩放 + 跳页 |
| 文字提取与段落重建 | ✅ | 行合并、双栏检测、连字符合并、段落推断（`lib/pdf-text.ts`） |
| 当前页判定 | ✅ | 最大可见面积规则 + 显示页码/翻译页码分离，页面稳定 300ms 后才翻译 |
| 随页翻译 | ✅ | **流式输出**，段落边生成边显示；当前页完成后预取下一页 |
| 翻译供应商 | ✅ | OpenAI 兼容接口（用户自备 Key），内置演示供应商（不联网） |
| 缓存 | ✅ | IndexedDB，逐页缓存；键含 provider/model/提示词版本，换配置不串缓存 |
| 阅读进度恢复 | ✅ | 按文件 SHA-256 指纹；重新导入同一文件自动跳回上次页码 |
| 错误处理 | ✅ | 错误分类（网络/鉴权/限流/额度/服务端），透传服务端原始错误信息，瞬时错误自动重试 ≤2 次 |
| 扫描版 PDF | ✅ | 抽样前 3 页，无文字层则明确提示不支持（MVP 不做 OCR） |
| 重新翻译 | ✅ | 绕过缓存强制重翻并覆盖 |
| 翻译 / AI 双模式 | ✅ | 右侧顶部切换，左侧阅读位置保持不变 |
| 当前页视觉答疑 | ✅ | 同时发送规范化文字和离屏渲染 PNG，支持图片、图表、表格和公式理解 |
| 独立 AI 配置 | ✅ | 答疑 API 地址、Key、模型与翻译完全隔离，要求视觉模型 |
| 每页独立会话 | ✅ | IndexedDB 本地保存；翻页切换、返回恢复，流式回答归属原页面 |
| AI 回答展示 | ✅ | Markdown + GFM + KaTeX，支持表格、代码和 LaTeX 公式 |

已实测的真实使用案例：港中深 MAT 3007 期中试卷（旧配置 `glm-4-flash`，整页十几秒，流式 2 秒内出首段）。当前推荐改用关闭深度思考的 `glm-4.7-flashx`。

## 三、技术栈与代码地图

React 19 + vinext（Vite 的 Next 兼容层，beta）+ PDF.js + Tailwind 4 + Base UI（shadcn 风格）+ Cloudflare Workers（部署目标）。

```
demo/
├─ app/page.tsx            # 阅读器主页面、稳定页码与右侧模式协调
├─ app/globals.css         # 主题与布局类
├─ components/ai-chat-panel.tsx       # 每页对话、流式状态、Markdown/公式展示
├─ components/reader-settings-dialog.tsx # 翻译与 AI 独立设置
├─ lib/pdfjs.ts            # pdf.js 懒加载（worker 由 predev/prebuild 复制到 public/）
├─ lib/pdf-text.ts         # 文本提取规范化流水线 + sha256（纯函数，Node 可测）
├─ lib/translation.ts      # 供应商适配器、SSE 流式解析、错误分类、重试、缓存键、提示词
├─ lib/chat.ts             # 多模态答疑适配器、SSE、错误分类和安全提示词
├─ lib/chat-cache.ts       # 独立 AI 设置与逐页会话存储
├─ lib/page-vision.ts      # 固定质量离屏渲染与页面视觉输入
├─ lib/reader-cache.ts     # KV 存储（IndexedDB/内存）、译文缓存、进度、设置
├─ lib/current-page.ts     # 当前页判定（纯函数）
├─ lib/reader-model.ts     # 缩放步进、页宽计算等纯函数
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
7. **页面图像按需生成且不持久化**。只有用户提问时才离屏渲染 PNG，IndexedDB 只保存完成的对话消息。
8. **PDF 内容是不可信数据**。答疑系统提示词要求忽略页面内试图改变规则的指令，只依据绑定页面作答。

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

1. **E2E 测试缺失**。建议引入 Playwright：导入 `public/sample.pdf` → 翻页 → 断言译文面板状态。目前只有单元测试和源码正则冒烟测试（`tests/reader-layout.test.ts` 较脆弱，重构 UI 时记得同步）。
2. **没有 CI**。建议 GitHub Actions：test + lint + tsc + build 四件套。
3. **桌面端（Tauri）未启动**。当前是纯 Web 实现（技术方案允许的容器替换路线）。Web 版限制：文件句柄不持久，重开页面需重新导入文件（同文件可恢复进度）。Tauri 化后可做"最近文档直接打开"。
4. **无托管密钥的薄后端代理**。当前翻译和答疑 Key 存本地浏览器、浏览器直连供应商（已在设置界面告知）。公开运营前需按技术方案 6.4 和 15.8 建代理。
5. **源语言固定为 auto**，未做语言检测展示。
6. **双栏论文语料未覆盖**。`lib/pdf-text.ts` 的双栏检测有单元测试，但缺真实双栏论文验证；`public/` 里应补充双栏测试 PDF。
7. **vinext 是 beta**（1.0.0-beta.5），升级时注意 RSC 相关破坏性变更。
8. **真实视觉供应商需要人工冒烟**。自动测试使用模拟多模态响应；上线前需用目标供应商检查图片字段兼容、CORS、请求体限制和公式理解质量。

## 六、踩过的坑（重要）

- **pdf.js worker 不要用 `?url` 导入**：会破坏 SSR（`window is not defined`）。当前方案是 predev/prebuild 脚本把 worker 复制进 `public/`，`workerSrc = '/pdf.worker.min.mjs'`。
- **翻译 effect 不要依赖自己的状态输出**：曾导致无限"翻译→abort"循环。会话内状态放 `translationStatesRef`，effect 只依赖页码/语言/文档。
- **react-compiler（oxlint）很严格**：effect 内同步 setState、渲染期写 ref、闭包引用判定都会报错，提交前必须 `pnpm lint` 清零。
- 翻译应关闭深度思考。当前推荐 `glm-4.7-flashx`（稳定低延迟）或 `deepseek-v4-flash`；设置界面有一键配置并默认发送 `thinking: disabled`。
- 两个推荐配置分别保存自己的 API Key；旧版单 Key 设置加载时只迁移到当前匹配的配置，不会复制到其他配置。
- **智谱返回的具体错误在 `error.message`**，应用已透传显示；排查用户问题先看译文面板的错误行。
- 本地多实例调试时注意端口占用：`start.sh` 会自动跳过被占端口。
