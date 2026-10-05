# Blackboard 固定同步流程

目标：调度任务只执行固定步骤，不要求模型每轮分析仓库、编写脚本或猜测是否成功。复用已有每两天的 Codex 任务。模型负责调用浏览器接口、关联工具返回的下载路径、转达需要人工处理的异常；筛选、去重、转换、导入和成果核验由代码执行。

这不是一个脱离 Codex 的系统后台爬虫。当前登录属于 Codex 浏览器，必须通过授权的浏览器工具访问，不能复制 Cookie、读取浏览器凭据库或用隐藏 HTTP 接口绕过登录。电脑和 Codex 需运行，Blackboard 登录需有效；页语后台 AI 需要页语运行。

## 固定配置

`demo/scripts/blackboard/config.json` 是唯一课程范围配置，属于本地个人配置，不纳入 Git。首次使用先复制同目录 `config.example.json` 为 `config.json`，填入自己的学期、课程与内容标识，再按需启用课程；示例默认禁用同步。既有本地配置保持不变，只有用户明确要求后才修改课程范围。Preview / preivew / 预习、课程大纲、教材不导入。未知材料输出待检查，不能自行扩展范围。

执行目录为 `/home/yusicheng/project/learning_app/demo`：

```bash
node scripts/blackboard/sync.mjs plan
node scripts/blackboard/sync.mjs import /绝对路径/本轮下载清单.json
node scripts/blackboard/sync.mjs status
node scripts/blackboard/sync.mjs wait
node scripts/blackboard/sync.mjs blocked AUTH_REQUIRED
```

路径默认取当前用户的 `文档/Blackboard同步/2610UG/automation` 和 `文档/页语工作区`；可用 `YEYU_DOCUMENTS_ROOT`、`YEYU_BLACKBOARD_ROOT`、`YEYU_WORKSPACE_ROOT` 显式指定。PPT 转换使用 `YEYU_BUNDLED_SOFFICE` 或已配置的 Codex bundled soffice 绝对路径，不使用用户桌面版 LibreOffice。

## 自动任务操作规程

### 1. 浏览器检查与扫描

通过 CUA 的受支持入口获取浏览器清单，选择当前任务的 Blackboard 标签。先读浏览器接口文档。不得硬编码 tab ID。找不到浏览器时记录 `blocked BROWSER_UNAVAILABLE`，不要抓取凭据或创建另一个浏览器配置来绕过问题。

在 CUA JavaScript 会话中导入仓库模块，使用已取得的 `tab`：

```js
var bbSync = await import('/home/yusicheng/project/learning_app/demo/scripts/blackboard/browser.mjs');
var bbFs = await import('node:fs/promises');
var bbConfig = JSON.parse(await bbFs.readFile('/home/yusicheng/project/learning_app/demo/scripts/blackboard/config.json', 'utf8'));
var bbScan = await bbSync.scanBlackboard(tab, bbConfig);
nodeRepl.write(bbScan);
```

扫描器读取页面 DOM、递归遍历同课程目录、按规则筛选附件、限制页数并避免循环。任何根目录失败都终止，不产生伪造的完整扫描。只调用文档化的 `goto`、只读 `evaluate`、下载接口；不调用页面后台函数，不用 fetch，不读 Cookie。

如果抛出 `AUTH_REQUIRED`，运行 `blocked AUTH_REQUIRED`，按 `notify` 决定是否通知用户重新登录，然后结束。遇到 `SOURCE_LAYOUT_CHANGED`，记录对应 blocked 状态，报告站点结构需要适配，不让弱模型临时猜选择器。当前提取器要求 Blackboard Original 的 `#content_listContainer`，其他界面明确失败。

### 2. 下载

对 `bbScan.attachments` 中每一项执行：

```js
nodeRepl.write(await bbSync.downloadAttachment(tab, bbConfig, bbScan.attachments[0]));
```

索引由实际清单决定，按顺序逐项调用。下载前再次校验页面和链接。将**浏览器下载通知返回的确切本地路径**写入对应项目 `localPath`，不得根据文件名猜路径，不得扫描其他下载记录。浏览器没有返回可用路径时记录 `blocked DOWNLOAD_REQUIRED` 并结束。每轮重新下载并计算内容哈希，以识别同一附件链接下的替换版本，不仅按文件名或来源 ID 去重。

保留整个 `bbScan`，只添加 `localPath`，通过 `apply_patch` 保存为本轮下载清单 JSON；不得手工补 `complete=true`、虚构 pages 或刷新旧清单 scannedAt。没有新增也必须完成本轮扫描与内容核对。扫描清单超过 24 小时失效。

### 3. 导入与转换

先 `node scripts/yeyu-tool.mjs state` 确认页语就绪。如果未运行，启动 `/home/yusicheng/.local/bin/yeyu`，不要使用旧 `/usr/bin/yeyu`，不要杀进程或重启正在整理的页语。

运行固定 `sync.mjs import` 命令。程序先将原件按哈希缓存，验证文件格式、PDF 页数，PPT/PPTX 使用隔离转换目录和进程超时，绝不覆盖原件；接着检查目标课程实际 PDF 哈希，只有确实缺失才调用 MCP。更新版本保留为独立文档，不删除旧笔记和成果。临时失败再次运行同一清单会先核对磁盘，不重复导入已保存文件。

PPT 转换后自动页数/文件校验不代表视觉无误。输出 `CONVERSION_REVIEW_REQUIRED` 时，从台账中取得转换 PDF 路径，按 PDF/演示文稿技能渲染并检查，确认后才在该项增加 `visualReviewConfirmed:true` 并重新执行 import；不能让模型未经查看就自动置 true。没有转换工具或无法检查则通知，保留原件，不能称已同步。

### 4. 完成核验

- `pending`：PDF 已保存，后台仍在生成。执行一次 `wait`，程序每 30 秒核验，最多等 30 分钟，无需模型反复发查询命令。使用异步终端执行，让工具及时返回运行会话；不重新导入、不清空缓存、不重启页语。超时仍明确保持 pending，下一次任务再核验。
- `needs_attention` / `failed`：根据错误码报告。AI 失败只重试页语中失败阶段；当前同步 CLI 不伪造重试、不改课程库。
- `complete`：必须由程序读取目标 PDF、单篇摘要/脑图文件和课程知识库版本核验产生，不能只根据 MCP 导入返回判断。
- `unchanged`：本轮完整检查无新增，保持安静。
- `status` 的 `sourceChecked:false`：仅核验先前已下载任务，不代表本轮检查过 Blackboard。

程序台账、缓存、报告均在 automation 子目录，旧 `sync-index.json` 只作为历史记录保留，不被覆盖。报告不包含密码、Cookie、API Key 或 MCP 控制令牌。

## 退出与通知

退出 0 可能是 pending，必须读 JSON 状态；退出 2 表示 blocked/needs_attention，退出 1 表示执行失败，退出 3 表示后台仍 pending 且等待到上限。`last-report.json` 的 `notify` 去重相同异常，无变化保持安静。后台完成从 pending 转 complete 可以通知一次；每次状态查询不等于要求周期性播报。

调度提示只应要求阅读本操作规程并执行，不要求运行模型重新修代码。需要功能修改应报告，由维护任务处理。
