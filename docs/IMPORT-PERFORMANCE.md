# PDF 导入性能与同步排障

导入包含内容指纹检查、逐页文字提取/OCR、AI 文档分析、AI 课程综合和本地事务提交。复制 PDF 本身不是完整导入；只有课程清单及成果提交成功后才算完成。

## 本次改进

- 提取/OCR 最多同时处理两页，返回结果仍按原始页序排列。取消信号传到图像渲染和 OCR 网络请求，停止排队并等待正在执行的页面清理。
- UI 和 MCP 复用同一份导入进度；`yeyu_get_state` 的 `courseLibrary.importProgress` 给出文件、阶段、百分比、总耗时与当前阶段耗时。百分比不会因并行任务乱序完成而倒退。
- MCP 本机 HTTP 通道使用明确的长请求时限，避免 Node fetch 默认 300 秒等待响应头超时，而 Electron 仍在执行 30 分钟导入的矛盾。
- Linux 自动读取 XDG 系统文档目录，不再默认假设用户使用英文 `Documents`；显式控制文件和工作区环境变量仍优先。
- 课程综合在文档级元数据及身份表保留文件名，不在每条概念来源中重复；逐条来源保留 documentId 和原页码，本地校验时恢复文件名。紧凑输入能落入既有最终预算时直接综合，避免仅因重复元数据产生中间归并，完整请求仍接受字节预算与来源范围校验。
- 关系字段示例使用单个合法标签，单独声明可选值，避免把竖线分隔的枚举当成输出值；不合规关系仍拒绝，并在错误中列出实际标签和端点。
- 对模型写反的“包含”关系，仅在唯一节点 ID 与显式 parentId 能证明方向时本地交换端点，继续执行来源、层级和循环校验；不会删边、改变正文或为修复格式新增 AI 请求。

并行主要缩短扫描件逐页等待。文档分析与课程综合依赖 AI 服务，仍可能花费数分钟；没有更换用户模型、缩减材料、跳过校验或伪造总结。

## 通过现有 MCP 操作

在 `demo/` 下构建后、保持页语桌面端运行：

```bash
pnpm mcp:build
node scripts/yeyu-tool.mjs state
node scripts/yeyu-tool.mjs import course-name /absolute/path/lecture.pdf
```

脚本使用 stdio MCP，不直接写课程数据库。导入默认生成总结、脑图并纳入课程综合，每 15 秒读取一次进度。自定义工作区可设置 `YEYU_WORKSPACE_ROOT` 或 `YEYU_MCP_CONTROL_FILE`；不要把控制文件中的令牌复制到日志或仓库。

如果导入调用断开或超时，先查 `importProgress.active`、课程清单和文件哈希。运行中的导入不能重复提交；已提交的 PDF 应通过指纹去重。尚未完成的资料不能仅凭下载成功就标记为同步成功。

## 验证

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm desktop:build
pnpm desktop:test
```

本机同时提供 Wayland 和 X11 时，Electron 浏览器回归测试可能因显示后端启动而超时。可在测试命令中使用 `env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11`，无需修改系统显示设置。桌面启动冒烟测试使用固定本机端口，应在没有正在运行的页语实例时执行，避免单实例锁和端口竞争。
