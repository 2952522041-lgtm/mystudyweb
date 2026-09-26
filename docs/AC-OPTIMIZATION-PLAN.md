# 页语 · A 类 + C 类优化改造计划

## 执行状态（2026-09-26）

本节反映当前代码；后面的方案与旧基线保留为历史计划，不表示其中全部项目已落地。
上一轮从 `156f8cf` 开始，基线测试 **254 通过 / 0 失败 / 0 跳过**，完成 A3 与四项审计优化。本轮从 `96ca8e9` 开始，先自证基线 **267 通过 / 0 失败 / 0 跳过**，只完成本地 A2 与课程上下文导致的初始 PDF 重复载入修复。

| 项目 | 状态 | 实际实现与边界 |
| --- | --- | --- |
| C1 快捷键 | 已完成 | 翻页、缩放、Alt+1..4、F / Ctrl+Shift+F、Esc；尊重输入控件、弹窗与隐藏阅读器。 |
| C2 翻译状态可视化 | 已完成 | 缩略图状态徽章、右栏进度；按当前目标语言统计。 |
| C3 底部状态栏整合 | 已完成 | 页码、缩放、模式、翻译状态和缓存状态；窄窗口信息布局。 |
| A1 划词 / 选段翻译 | 已完成 | PDF TextLayer、翻译 / 解释 / 复制浮条、选段归属与取消；解释复用当前页视觉答疑，保留 `allowWebSearch: false`。 |
| A2 原文 ↔ 译文逐段对照 | 已完成 | 原文 / 译文双向点击高亮并按需滚动；等数量按非空段落顺序对齐，不等数量按顺序、相对长度与共有词估算连续合并 / 拆分；扫描页或不可映射文字禁用定位并提示。 |
| A3 AI 全文问答 | 已完成 | 同一答疑面板切换“当前页 / 全文”；本地逐页提取、按页分块、关键词与近期问题检索，最多 5 块、每块 2400 字符；带可跳页来源。 |
| P1 PDF 导入生命周期 | 已完成 | 请求代次隔离；过期加载、解析失败、替换和卸载释放资源；失败保留原可用文档。当前 PDF.js 6.x 的销毁入口是 `doc.loadingTask.destroy()`，代理自身没有 `destroy()`。 |
| P1 答疑存储异常处理 | 已完成 | 读取、保存、删除分别提示和恢复；保存失败保留回答，重新保存不调用 AI；读取未恢复时不发送或覆盖历史。 |
| P2 首屏等待全部页面尺寸 | 已完成 | 首页尺寸就绪后预留全部页位；后台补齐、跳页优先、按页与页内位置保持视口；未就绪页面不渲染错比例画布；失败可重试。 |
| P2 阅读器最小高度 | 已完成 | 阅读器及同样受影响的课程外壳改为动态视口高度和 `min-h-0`；真实渲染验证 420px 高窗口的状态栏、翻页和答疑操作区。 |

兼容性与限制：

- 旧单页键仍为 `chat:{fingerprint}:{pageNumber}`；全文使用 `chat:{fingerprint}:document:v1`，翻页不切断全文会话，两种范围互不混读。
- 全文检索只在首次发送问题时在本地提取文字，完整索引按 PDF 代理缓存在内存中；不引入向量库，不自动 OCR 整篇，不把 PDF 中的搜索指令当成用户工具请求。无文字、图表或扫描内容使用已有当前页视觉答疑。
- 轻量关键词检索对跨语言、同义改写和无明确主题的追问存在局限；无命中时提示补充关键词或页码，不调用 AI。真实检索相关性、回答依据与复杂 PDF 仍需人工验收。
- 只做本地提交，未 push；未修改密钥、部署配置、Electron 打包流程或 PDF/OCR/翻译/摘要/脑图算法。

上一轮回归测试新增/更新：`document-chat.test.ts`、`chat.test.ts`、`pdf-import-lifecycle.test.ts`、`chat-storage-browser.test.ts`、`progressive-page-sizes.test.ts`、`reader-progressive-browser.test.ts`、`reader-layout.test.ts`；根目录 `tests/test_docs.py` 校验本状态表。最终前端验证为 **267 通过 / 0 失败 / 0 跳过**，lint 与 TypeScript 检查通过。Linux `pnpm desktop:build` 通过；`xvfb-run -a pnpm desktop:test` 为 **17 通过 / 0 失败 / 0 跳过**（含编译产物与打包产物真实启动）；根目录 Python 文档测试 **16/16 通过**。Windows 打包安装与实机仍需人工验收。


### 本轮 A2 与重复导入修复（2026-09-26）

- `paragraph-alignment.ts` 是无 DOM / 网络依赖的纯函数。保留原数组下标，空段不连线；模型编号仅在对齐评分中忽略，不改显示内容或缓存。非空段落数相等时逐项对应；不等时用动态规划将较长数组分成连续非空组，相对长度误差加共有词标记评分，支持 1:N / N:1。超过 200 段时按数量比例分组，限制计算量；所有数量不等情况都提示“估算”。模型乱序、漏译或等数量下的语义错位无法可靠识别，不宣称语义对齐。
- 用现有 `normalizePage` / 分栏规则将原文段落映射到 PDF.js TextLayer 的真实 span；兼容断词、空白、兼容字符、重复文字与双栏顺序。点击译文或 Enter / Space 高亮对应原文，点击原文反向定位译文；保持原有拖选翻译 / 解释 / 复制。只滚动对应阅读窗格，按所有高亮行的实际矩形定位；每次点击只发起一次滚动，避免重渲染拉回翻页。
- 翻译完成 / 缓存恢复后才启用对照，流式过程中不猜最终映射。无文字层扫描页、文字稀少而触发 OCR 的页面、映射失败或文字层错误不伪造坐标；翻页、语言切换、重新翻译和替换文档隔离旧选中状态。共用 `demo/app/page.tsx`，不改 PDF 解析、翻译流程、缓存键、远程访问、部署或打包配置。
- **重复导入复现**：真实 Chromium / React StrictMode 渲染 `PdfReader`，保持同一 `initialFile`，仅将 `courseContext` 替换为等价的新对象；新增测试修复前失败，期望 PDF.js `getDocument` 调用 1 次，实际 2 次。原因是 `handleFile` 依赖整个上下文，初始导入 effect 随之重跑。这里证实的是阅读器重复载入，不是课程存储新增两条记录。
- **最小修复**：在延迟导入真正开始时记住已消费的 File 交接；上下文重载 / 清空不会再次载入旧文件，新 File 仍可打开。测试还覆盖“课程 A → 阅读器导入独立 B → 清空上下文”仍保留 B，以及 StrictMode 的 effect 取消。课程存储层未改动。
- 本轮测试新增：`reader-initial-import-browser.test.ts`、`paragraph-alignment.test.ts`、`paragraph-dom.test.ts`、`paragraph-comparison-browser.test.ts`；更新 `pdf-text-layer.test.ts` 与根目录 `tests/test_docs.py`。真实 PDF.js 交互覆盖双向高亮、全部行可见、键盘激活、拖选互不干扰、缩放、第二页、目标语言、缓存恢复及无文字页。
- 本轮最终前端验证：**287 通过 / 0 失败 / 0 跳过**；lint（另检查新增组件）与 TypeScript 检查通过；Linux 桌面构建通过，桌面测试 **17 通过 / 0 失败 / 0 跳过**，根目录文档测试 **16/16 通过**。复杂 PDF、真实模型合并 / 乱序输出、Windows 安装版仍需人工验收。

---


> 范围：A1 划词翻译 / A2 原文↔译文逐段对照 / A3 AI 全文问答；C1 快捷键 / C2 翻译状态可视化 / C3 底部状态栏整合。
> 目标载体：**浏览器版 与 Electron 桌面版同步改**（二者共用 `demo/` 下同一套 React 代码，阅读器在 `demo/app/page.tsx`）。
> 依据：AGENTS.md（每次改动必须 git commit + 更新测试）、HANDOFF.md 第十一节（不要重写 PDF 解析/OCR/翻译/答疑/摘要/脑图模块）、技术方案缓存键与不可信数据规则。
> 生成日期：2026-09-03。执行者：zcode（GLM-5.3-Flash，免费套餐额度），由 Hermes 审查。

---

## 0. 现状基线（已确认）

- 阅读器主页 `demo/app/page.tsx`（1693 行），单文件承载核心逻辑。
- **PDF 渲染是纯 canvas**：`PdfPageCanvas` 只 `pdfPage.render()` 到 `<canvas>`，**没有任何 TextLayer**，页面文字不可选择/不可定位。这是 A1 的结构性前提。
- 原文提取 `demo/lib/pdf-text.ts`：`NormalizedPageText { paragraphs: string[]; text: string }`，**原文段落结构已存在**（这对 A2 很有利）。
- 翻译结果 `demo/lib/translation.ts`：`TranslationResult { paragraphs: string[] }`，**译文也是段落数组**；缓存键规则见 `reader-cache.ts`（fingerprint+page+souceHash+lang+provider+model+vPROMPT_VERSION）。
- 答疑 `demo/components/ai-chat-panel.tsx`：当前绑定「单页」，页面即上下文。
- 当前页判定 `demo/lib/current-page.ts`：最大可见面积规则（纯函数，可测）。
- 缓存/设置 `demo/lib/reader-cache.ts`：IndexedDB + 本地存储。
- pdf.js `6.2.108`：新版 API 提供 `TextLayer`（`new pdfjs.TextLayer({...}).render()`）。
- git 基线：`master` 最新 `f6aa243 feat: add grounded web search to page chat`，工作区干净。

---

## 1. C 类（低风险、独立、建议先行）

### C1 快捷键体系
- **目标**：翻页、切换右侧模式、缩放、折叠右栏、跳转，全部可键盘完成。
- **改法**：新增纯函数 `demo/lib/reader-shortcuts.ts`（把 `KeyboardEvent` → 动作指令），在 `PdfReader` 加一个 `keydown` listener。纯函数便于单测。
- **拟定键位**：
  - `PageUp / PageDown`、`← / →`、`Home / End`：翻页
  - `+ / - / 0`：放大 / 缩小 / 还原
  - `Alt+1..4`：右侧模式（翻译/答疑/总结/脑图）
  - `Ctrl+Shift+F` 或 `F`：折叠/展开右栏
  - `Esc`：关闭弹窗 / 收起划词浮条
- **新增测试**：`tests/reader-shortcuts.test.ts` 断言各键→动作映射、修饰键组合、输入框内不拦截（避免在 textarea 里按 `→` 翻页）。
- **验收**：在阅读器内不碰鼠标可完成翻页、缩放、切模式。

### C2 翻译状态可视化
- **目标**：每页译文状态（识别中/翻译中/已完成/已缓存/失败）在缩略图栏和右栏清晰可见，可一眼扫出哪些页读过了。
- **改法**：`PdfPageThumbnail` 增加状态徽章（复用现有 `PageTranslationState.status`）；右栏顶部加「已翻译 N / 总页数 M」进度。
- **新增测试**：`tests/reader-cache.test.ts` 或新测试断言状态徽章映射逻辑（纯函数：`status → 徽章样式/label`）。
- **验收**：滚动时缩略图能看到各页翻译状态，右栏显示翻译完成进度。

### C3 底部状态栏整合
- **目标**：把当前页/总页、缩放、翻译状态、当前模式、缓存状态集中到一条底部栏，消除顶部工具条的拥挤。
- **改法**：`page.tsx` 底部加入一个 `<footer>` 状态栏，展示页码、缩放、右栏模式、翻译进度；顶部工具栏移除重复项或精简。
- **新增测试**：状态栏只读渲染，配合已有的 reader-model 纯函数。
- **验收**：底部状态栏信息准确、与顶部不冗余。

> **执行建议：C1 先做**（独立、可立即提交）。建议一个 commit 一项，或 C1 一个 commit、C2+C3 一个 commit。

---

## 2. A 类

### A1 划词 / 选段翻译（核心，改动最大）
- **目标**：在页面选中一段英文后，弹出浮条，一键翻译 / 查词 / 走 AI 答疑解释该选段。
- **结构性前提**：当前 canvas 无文字层，必须叠加 **PDF.js TextLayer**。
  - 改法：每个页面在 canvas 之上再渲染一个透明的 `TextLayer`（`pdfjs.TextLayer`），让原文字符可被 `window.getSelection()` 选中；利用 TextLayer 已给出的字符坐标把「选中的文本」和「页面坐标」关联。注意保持 `aria-hidden` 与透明度、不重复布局。
  - 这点改动是独立且必要的一步，建议它自己也单独一个 commit（`feat: add pdf text layer for selection`）。
- **浮条与动作**：选中文本后出现浮条「翻译 / 解释 / 复制」(解释 → 复用答疑视觉链路，用选段文字 + 页码提问)。浮条定位跟随选区；`Esc` 收起。
- **复用**：翻译直接走现有 `TranslationProvider`（`createProviderForSettings`）做一段短文本翻译，可新增一个 `translateSelection` 但**不污染**整页缓存键，选段翻译单独缓存或仅会话内。
- **边界**：
  - 文本层只在 `pageHasText` 为真的页面启用；扫描/手写页（无文字层）不显示浮条，给出「该页无可选文字」提示。
  - 双栏 PDF：TextLayer 按 pdf.js 排版即可选中，无需额外分栏逻辑。
  - 翻译同样遵守「失败不写缓存、错误分类透传」。
- **新增测试**：`tests/text-layer.test.ts`（纯函数：字符定位/选区→文本与页码坐标映射）；补一个短文本翻译的单元测试。
- **风险**：TextLayer 与现有 `PdfPageCanvas` 的尺寸/缩放(DPL 2 封顶)要同步，缩放时坐标要一致；这块最容易出 bug，务必结合 `reader-model.ts` 的 `fillColumnPageWidth`/缩放换算。

### A2 原文 ↔ 译文逐段对照
- **目标**：右栏译文可点击/悬停某一段，左侧原文同段高亮；反之亦然，形成可追溯的双语对照。
- **基础**：原文 `NormalizedPageText.paragraphs` 与译文 `TranslationResult.paragraphs` 都存在，但**段落数量不一定相等**（原文被翻译时可能合并、拆块、拆分）。必须先做**段落对齐**。
- **对齐纯函数**：新增 `demo/lib/paragraph-alignment.ts`，输入原文段落与译文段落，输出对应映射（基于文本相似度 + 长度 + 顺序匹配的贪心/对齐算法，参考句子对齐）。这个函数必须**纯函数、可单测**，不依赖 DOM/网络。
- **交互**：`TranslationBody` 每个 `<p>` 加 `data-paragraph-index`，点击/悬停 → 在高亮区域标注对应原文段；左侧需在 TextLayer (或一个 overlay) 上高亮对应段落区域。
- **与 A1 的耦合**：A2 的「原文高亮」依赖 A1 建立的 TextLayer/overlay 基础设施，建议**后于 A1** 做（依赖 TextLayer 已存在）。
- **新增测试**：`tests/paragraph-alignment.test.ts`（1:1、合并、拆分、空段、乱序、双语对照数据）；渲染层测试断言点击译文段触发正确的高亮回调。
- **验收**：任意一页译文，点击任一段落，左侧原文对应段高亮。

### A3 AI 全文问答（跨页/整份文档）
- **目标**：除逐页答疑外，用户可就整份 PDF 或某几页连续提问而不受单页上下文限制。
- **改法**（分两层）：
  1. **入口**：右栏新增「全文问答」标签（与「页面翻译/AI 答疑/总结/脑图」并列）；或在答疑面板加「扩大到全文」开关。
  2. **上下文策略**：长文不可能整篇塞进模型。采用**检索式**：
     - 预先对全文做 `pdf-text.ts` 逐页提取 + 分块（复用 `knowledge/pdf-chunks.ts` 的按页边界分块思路）；
     - 用 `ai-chat-panel` 现有的视觉/通用/搜索链路，改造为「问题 → 检索 top-K 相关块 → 注入上下文 → 带页码来源回答」。检索可先用轻量 TF-IDF/关键词重叠(纯函数可测)起步，不引入向量库（符合「暂不引入复杂向量库」约束）。
  3. **不可信数据**：沿用手册规则——块内试图改变指令的内容忽略；结论必须标注页码来源；不得编造页码。
- **明确不做**（本阶段）：跨文档问答、全文向量数据库、文档级长期记忆。
- **新增测试**：分块/检索纯函数 + 上下文注入 + 页码来源标注；沿用 `ai-knowledge.test.ts` 的不可信数据断言风格。
- **风险**：检索质量是短板。第一版靠关键词重叠，能覆盖「找某概念在哪页、这两页关系」类问题；「灵活对话」仍建议用单页答疑。

---

## 3. 实施顺序与 commit 切分（建议）

| 顺序 | 项 | commit 主题示例 |
|---|---|---|
| 1 | C1 快捷键 | `feat: add reader keyboard shortcuts` |
| 2 | C2 + C3 状态 | `feat: add translation status badges and bottom status bar` |
| 3 | A1 铺垫：TextLayer | `feat: add pdf text layer for selection` |
| 4 | A1 浮条 + 选段翻译 | `feat: add selection translate/explain over text layer` |
| 5 | A2 段落对齐 + 对照 | `feat: add paragraph-level source/translation alignment` |
| 6 | A3 全文问答 | `feat: add full-document Q&A with retrieval` |

> 每完成一个 commit：`pnpm test`（含新增单测）、`pnpm lint`（0 错误）、`npx tsc --noEmit`；涉及桌面时再 `pnpm desktop:build && pnpm desktop:test`。根目录 `python3 -m unittest discover tests`。全部通过才 commit（AGENTS.md）。

---

## 4. 直接可执行的 zcode 任务书（第一步）

> 以下为交给 zcode 的第一条任务。若改动因 A2/A3 较复杂被拆成多批，后续任务书由 Hermes 按首批结果再生成。

```text
工作目录: /home/yusicheng/project/learning_app
技术栈: React 19 + vite(vinext) + pdfjs-dist@6.2.108 + Tailwind 4,阅读器位于 demo/app/page.tsx。
基线: master 最新 f6aa243,工作区当前干净。

请严格逐一完成以下任务,每个子项完成后先验证再单独 git commit(遵循 AGENTS.md:每次改动都要 commit,且更新相关测试)。

【C1 快捷键,先行】
- 新建 demo/lib/reader-shortcuts.ts:导出纯函数,把 KeyboardEvent 映射为阅读器动作(翻页 PageUp/PageDown/←/→/Home/End;缩放 + - 0;切换右侧模式 Alt+1..4;折叠右栏;Esc 收起)。
- 在 PdfReader 挂 keydown 监听,注意:作用域在阅读器内,但输入框(textarea/input)内不拦截方向键与空格。
- 新增 tests/reader-shortcuts.test.ts,断言映射与输入框豁免。
- 跑 pnpm test + pnpm lint(0错误)+ npx tsc --noEmit 通过后 commit。

【C2+C3 翻译状态徽章与底部状态栏】
- PdfPageThumbnail 加翻译状态徽章(复用现有 status: recognizing/translating/complete/cached/error),纯函数映射 status→label/样式。
- 底部加状态栏:当前页/总页、缩放、当前右侧模式、翻译完成进度(完成页/总页)。精简顶部工具栏冗余项。
- 新增/更新测试覆盖徽章映射与状态栏渲染。跑 pnpm test + lint + tsc 通过后 commit。

【A1-a 铺垫:PDF TextLayer】
- 为每个渲染页叠加 PDF.js 透明 TextLayer(pdfjs-dist 6.2.108 新版 TextLayer API,worker 已按 download 到 public/),使其文字可被 getSelection 选中。保持 aria-hidden,坐标随缩放(DPL≈2封顶)同步。
- 只对 pageHasText 的页面启用;扫描/手写页跳过并标记「无可选文字」。
- 新增 tests/text-layer.test.ts 测试坐标/选区定位纯逻辑。验证后单独 commit(不要混入 A1 浮条)。

【A1-b 选段翻译/解释浮条】
- 监听 selection,弹出浮条:「翻译」「解释」「复制」。翻译用现有 TranslationProvider(createProviderForSettings)做短文本翻译,单独会话/轻缓存,不污染整页缓存键;解释走答疑视觉链路(选段文字+页码提问)。
- Esc 收起;点击空白收起;翻译失败透传错误分类。
- 新增测试。pnpm test + lint + tsc 通过后 commit。

【A2 段落对齐+对照(依赖 A1 TextLayer,最后做)】
- 新建 demo/lib/paragraph-alignment.ts:纯函数,输入原文段落与译文段落,输出 1:1/合并/拆分对齐映射(文本相似度+长度+顺序贪心或对齐,不依赖 DOM)。
- 右栏译文每段可点击/悬停→在左侧 TextLayer 高亮对应原文段(反之亦然)。
- 新增 tests/paragraph-alignment.test.ts(1:1/合并/拆分/空段/乱序)。pnpm test + lint + tsc 通过后 commit。

【A3 全文问答(独立,可最后做)】
- 右栏新增「全文问答」标签(与页面翻译/AI答疑/总结/脑图并列)。
- 全文逐页提取+分块(复用 knowledge/pdf-chunks.ts 按页边界思路);用轻量关键词重叠/TF-IDF(纯函数可测)检索 top-K 相关块,注入上下文并带页码来源回答。继承不可信数据规则。
- 不做:跨文档问答、向量库、文档级记忆。
- 新增检索/注入/来源标注测试。pnpm test + lint + tsc 通过后 commit。

最终验收:浏览器版与桌面版(vinext 桌面构建)都通过 pnpm test / pnpm lint / npx tsc --noEmit;桌面版再 pnpm desktop:build + pnpm desktop:test。全部通过后,git log 呈现上述按主题切分的提交。
```

---

## 5. 待 Hermes/用户拍板的设计取舍

1. **A2 对照交互形式**：点击译文段 → 左侧高亮(推荐,单向清晰) 还是 双向悬停(更顺但对 TextLayer 高亮性能压力大)?推荐单向点击。
2. **A3 检索精度**：第一版是否为保真而**牺牲质量**接受关键词重叠,还是需要引入更好检索(可能要更多 AI/本地计算)?推荐先用关键词重叠跑通闭环。
3. **执行批次**：6 个 commit 是否全部一次性交给 zcode,还是先交 C1~A1(前 4 批)验证质量再交 A2/A3?推荐分批、先小后大。
