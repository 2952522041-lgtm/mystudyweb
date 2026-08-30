# 页语 — PDF 随页翻译阅读器

导入外文 PDF，左侧阅读原文，翻到哪一页，右侧自动显示该页译文。

## 日常使用

```bash
./start.sh
```

然后打开 http://localhost:8787 （按 Ctrl+C 停止）。

1. 点「导入 PDF」选择一份**文字型**外文 PDF（扫描版暂不支持）
2. 左侧阅读、翻页，停顿约半秒后右侧自动翻译当前页
3. 右上角齿轮「翻译设置」可切换目标语言、配置真实翻译服务

默认是**演示模式**（不联网，显示占位译文）。要看真实译文：打开「翻译设置」，选择智谱或 DeepSeek 推荐配置，再填写对应平台的 API Key。也可以选择 OpenAI 兼容接口后手动填写服务地址和模型名。

推荐配置：

- 日常英文 PDF 翻译优先使用 `glm-4.7-flash`：免费、支持流式输出，应用会自动关闭深度思考。
- 免费接口繁忙或更在意稳定低延迟时使用 `glm-4.7-flashx`：仍然便宜，官方定位为轻量高速版本。
- 更看重复杂论文和术语稳定性时使用 `deepseek-v4-flash`：价格低，非思考模式响应快。
- 翻译不建议使用 GLM-5.2、DeepSeek V4 Pro 或其他深度思考模型；它们更适合复杂推理，通常只会增加翻译等待和输出费用。

- API Key、译文缓存、阅读进度都只保存在本机浏览器，不会上传
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
- `demo/lib/reader-cache.ts` — IndexedDB 缓存、阅读进度、设置存储
- `demo/lib/current-page.ts` — 当前页判定（最大可见面积规则）

产品与架构文档见 `PRODUCT_DESIGN.md` 和 `docs/TECHNICAL_SOLUTION.md`。

## 部署为公开网站

`demo/` 已配置 Cloudflare Workers（wrangler）。在 `demo/` 目录执行 `npx wrangler deploy` 即可发布（需要登录 Cloudflare 账号）。注意：公开部署时翻译请求仍由浏览器直接发往所配置的翻译服务；如需托管密钥的代理后端，见技术方案第 6.4 节的公开阶段规划。
