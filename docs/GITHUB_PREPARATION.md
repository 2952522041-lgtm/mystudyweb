# GitHub 准备检查（2026-10-05）

- 起点：`master` / `b7337a9`，工作区干净，已有 137 个提交；保留全部历史。
- Remote：`https://github.com/2952522041-lgtm/mystudyweb.git`。远端 master 为 `4ebd55a`，与本地历史已分叉，并非本地祖先。整理提交 `7a63730` 后本地独有 97 个提交、远端独有 9 个提交；合并预检存在 10 个文件冲突。应先推送独立评审分支，避免覆盖远端或为上传而修改业务代码。
- 当前跟踪文件（含历史验证压缩包解压内容）及 1,347 个历史 blob 的凭据模式检查未发现真实 API Key、访问令牌或私钥；测试中存在明确的假凭据。模式扫描不能证明不存在任何形式的秘密，二进制图片内容未进行 OCR 审计。
- `demo/scripts/blackboard/config.json` 含个人课程范围，停止跟踪但保留本地文件；新增默认禁用的 `config.example.json`。首次克隆按 `BLACKBOARD-AUTOMATION.md` 配置可选同步。
- `docs/validation/2026-09-26*/` 下五个 `.tar.gz` 是历史验证日志，停止跟踪但保留本地文件；旧报告中对应压缩包引用仅供原本机追溯。历史提交仍包含旧配置和日志，没有清洗或重写历史。课程标识也出现在旧文档和测试夹具中，不是登录凭据。
- 未发现项目 `.env`、真实私钥或 Cookie 文件。Wrangler 本地 SQLite、依赖、构建和打包目录均被忽略。保留实际构建依赖的 `demo/.openai/hosting.json`，其中项目标识不是访问密钥。
- 根 `.gitignore` 补充依赖/缓存、环境变量、凭据文件、本地设置、工作区数据、日志、数据库、打包产物与 IDE/系统临时文件；源代码、资源、API/IPC 定义、package 和 lock 文件保持跟踪。新增空值 `demo/.env.example`。

## 验证结果

使用本机 Node v22.23.2、pnpm 11.24.0；CI 配置使用 Node 22、pnpm 10。

- Web：`pnpm build` 通过；`pnpm dev --host 127.0.0.1` 启动成功，首页 HTTP 200。
- 桌面：`pnpm desktop:web`、`pnpm desktop:test` 通过；19 项 Electron/工作区测试通过，无跳过。
- 完整测试：与 `pnpm test` 相同的 Node 测试命令，979 项通过，无失败/跳过。修改后的 Blackboard 示例测试另行复验，14 项通过。
- 类型检查通过；lint 无错误，有 40 条现存警告（可访问性、Hooks、类型等），未修改 UI 处理这些警告。Web 构建有 chunk 体积和路由静态分类提示。
- `python3 -m unittest discover tests`：19 项通过，包含新增忽略规则、必要源码与空环境示例的保护测试。
- 沙箱内浏览器测试及开发服务受权限限制；上述运行验证在获准的沙箱外重跑通过。

未验证真实付费 AI 服务、个人 Blackboard 登录或跨机器局域网端到端流程。未改 UI、业务实现、API 或本机桌面安装。Gemini 阅读入口为 `GEMINI_UI_CONTEXT.md`。

推送 master 会触发现有 GitHub Pages 工作流；独立评审分支不触发该工作流的 master 推送条件。
