# 页语 — PDF 随页翻译与 AI 答疑阅读器

导入外文 PDF，左侧阅读原文，右侧可在随页翻译和基于当前页的 AI 视觉答疑之间切换。

## 日常使用

```bash
./start.sh
```

然后打开 http://localhost:8787 （按 Ctrl+C 停止）。

1. 点「导入 PDF」选择一份**文字型**外文 PDF（扫描版暂不支持）
2. 左侧阅读、翻页，停顿约半秒后右侧自动翻译当前页
3. 右侧顶部可在「页面翻译」与「AI 答疑」之间切换
4. 右上角齿轮「阅读服务设置」分别配置翻译服务和 AI 答疑服务

默认是**演示模式**（不联网，显示占位译文）。要看真实译文：打开「阅读服务设置」中的「页面翻译」，选择智谱或 DeepSeek 推荐配置，再填写对应平台的 API Key。也可以选择 OpenAI 兼容接口后手动填写服务地址和模型名。

AI 答疑需要单独配置 OpenAI 兼容接口、API Key 和支持图片输入的模型，并在保存前确认模型具备视觉能力。发送问题时，应用会把当前页提取文字和清晰页面图像一起发送给该服务，因此可以解读本页图片、图表、表格和公式。每一页拥有独立会话，翻页后自动切换，回到原页时恢复历史。

推荐配置：

- 日常英文 PDF 翻译优先使用 `glm-4.7-flashx`：价格低、延迟稳定，应用会自动关闭深度思考。
- 更看重复杂论文和术语稳定性时使用 `deepseek-v4-flash`：价格低，非思考模式响应快。
- 翻译不建议使用 GLM-5.2、DeepSeek V4 Pro 或其他深度思考模型；它们更适合复杂推理，通常只会增加翻译等待和输出费用。

- API Key、译文缓存、答疑记录和阅读进度都只保存在本机浏览器，不会上传
- 两个推荐配置分别保存自己的 API Key，切换模型不会串用密钥
- 同一文件再次导入时自动恢复上次阅读页码，已翻译页面秒开（缓存）
- 当前页翻译完成后自动预取下一页，顺序阅读时减少等待
- 翻译失败会显示具体原因，可点「重新翻译」重试

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
- `demo/lib/chat.ts` — 多模态 AI 答疑适配器、SSE 流式回答和安全提示词
- `demo/lib/page-vision.ts` — 当前页离屏渲染、视觉图像尺寸控制和文字上下文提取
- `demo/lib/chat-cache.ts` — 独立 AI 设置与逐页对话的 IndexedDB 存储
- `demo/lib/reader-cache.ts` — IndexedDB 缓存、阅读进度、设置存储
- `demo/lib/current-page.ts` — 当前页判定（最大可见面积规则）

产品与架构文档见 `PRODUCT_DESIGN.md` 和 `docs/TECHNICAL_SOLUTION.md`。

## 部署为公开网站

两种方式任选：

**GitHub Pages（静态、免费）**：仓库已包含 `.github/workflows/deploy-pages.yml`，推送到 `master` 后会先执行测试、lint、类型检查和静态构建，再通过 GitHub Actions 自动部署。首次使用时，在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。站点地址为 `https://<用户名>.github.io/<仓库名>/`。本地也可在 `demo/` 目录执行 `pnpm pages` 检查 `dist/client/` 产物；脚本会根据 `GITHUB_REPOSITORY` 自动改写项目子路径，本地默认使用当前仓库名 `mystudyweb`。

**Cloudflare Workers**：在 `demo/` 目录执行 `npx wrangler deploy` 即可发布（需要登录 Cloudflare 账号）。注意：国内访问 `*.workers.dev` 不稳定。

注意：公开部署时翻译与 AI 答疑请求仍由浏览器直接发往各自配置的服务；如需托管密钥的代理后端，见技术方案第 6.4 和 15.8 节。
