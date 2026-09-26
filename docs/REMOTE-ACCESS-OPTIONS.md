# 页语远程访问：实现审计与优化方案

> 审计基线：`master` / `b82f932`；日期：2026-09-26。
> 本轮仅新增本文档。没有修改实现或测试，没有配置 Tailscale、监听器、证书、自启动，也没有读取真实课程、调用 AI 或验证外网实机连通性。下文的新增文件、接口、配置和验收步骤都是后续实施方案。

## 1. 结论与范围

推荐以 **Tailscale Serve HTTPS → 主机回环上的页语服务 → 主机任务执行器** 为主线，先保留 Electron，逐步增加浏览器可用的翻译、答疑和知识库任务。只有确实要求“无人登录、关掉桌面窗口后仍能工作”时，再把同一服务核心装配为 Node 常驻进程。无需云主机、公网端口、云存储、多用户账号系统或向量数据库。

有两个必须纠正的前提：

1. **当前代码并非只绑定局域网网卡。** `LanShareServer` 默认绑定 `0.0.0.0`，主进程没有覆盖它，因此覆盖全部本机 IPv4 接口。`100.98.55.70:37891` 在服务已开启、系统网络栈和访问策略允许时，可能已经能访问。不能把当前问题直接定性为绑定错误；也不能据源码声称已实测可连。
2. **主机侧代调 AI 不等于资料不出主机。** 当前翻译发送原文，视觉答疑/OCR 发送页面图像，知识库生成发送文档分块；从主机调用第三方模型仍然向第三方披露课程内容。本报告按“课程资料不得上传第三方”的严格含义设计：PDF、提取文字、截图、摘要、问题和资料衍生搜索词都不发送第三方，AI 必须使用主机本地推理。若用户原意仅禁止上传 PDF 文件而允许现有供应商处理内容，那是需要明确修改的隐私边界，不能默认获得授权。

“完整能力”的验收范围应明确列成：浏览主机课程/PDF/已有成果；生成页面及选段翻译；当前页视觉答疑、选段解释和整篇 PDF 检索答疑；本地 OCR；生成/重新生成单 PDF 成果与课程综合；任务取消与恢复查看。创建、导入、删除、编辑用户内容、历史恢复及设置管理单列权限，不能把开放 AI 等同于开放任意文件读写。严格隐私模式下，现有第三方联网搜索不属于可启用能力。

## 2. 现状评估：以代码为准

已阅读 `docs/LAN-SHARING.md`、`docs/LAN-SHARING-DATA-PROTECTION.md`、`docs/TECHNICAL_SOLUTION.md`、`HANDOFF.md`、`AGENTS.md`、`README.md`，并追踪服务端、浏览器入口、AI 链路、工作区存储和相关测试。技术方案包含历史 Tauri/云代理设想，HANDOFF 也保留旧状态；以下结论只描述当前基线代码。

下表链接指向仓库文件，标签给出基线行号；未来实现后应同步更新引用。

| 编号 | 实际实现与边界 | 代码证据（基线文件与行号） |
| --- | --- | --- |
| E01 | Electron 主进程创建独立 `LanShareServer`，IPC 开启/停止；启动时只构造对象，没有自动开启共享。静态资源来自桌面构建产物。 | [main.ts:312–324](../demo/electron/main.ts#L312)、[main.ts:375–387](../demo/electron/main.ts#L375) |
| E02 | 桌面自己的静态服务器只监听回环，和对外共享服务器是两回事。代理桌面静态端口不会让浏览器获得 preload 或课程 IPC。 | [main.ts:108–155](../demo/electron/main.ts#L108)、[main.ts:339–350](../demo/electron/main.ts#L339)、[api.ts:71–102](../demo/electron/api.ts#L71) |
| E03 | 共享 `options.host` 已存在；默认 `0.0.0.0`，用 `node:http` 创建服务器并 `listen(port, host)`，默认端口 37891。地址枚举取所有非 internal 的 IPv4，不筛选 RFC1918 或物理网卡，可能包含 Tailscale 地址；没有 IPv6 监听。`getStatus()` 未按自定义绑定地址过滤列表。 | [lan-share.ts:16–25](../demo/electron/lan-share.ts#L16)、[lan-share.ts:51–55](../demo/electron/lan-share.ts#L51)、[lan-share.ts:162–176](../demo/electron/lan-share.ts#L162)、[lan-share.ts:487–555](../demo/electron/lan-share.ts#L487) |
| E04 | 开启要求至少 6 字符密码。随机 16 字节盐、scrypt 32 字节摘要，仅在主进程内存保留；验证使用 `timingSafeEqual`。没有持久密码配置、账号或主机侧 AI 密钥仓库。 | [lan-share.ts:480–485](../demo/electron/lan-share.ts#L480)、[lan-share.ts:510–534](../demo/electron/lan-share.ts#L510)、[lan-share.ts:634–641](../demo/electron/lan-share.ts#L634) |
| E05 | `POST /api/share/login` 用 JSON 正文传密码，成功发放随机 32 字节 token。Cookie 是 token，不是密码：`HttpOnly; SameSite=Strict; Path=/; Max-Age=...`，没有 `Secure`。内存 Map 记录绝对到期时间，默认 12 小时，不随请求续期；logout 删除会话，stop 清空全部会话/凭据并断开连接。 | [lan-share.ts:158–160](../demo/electron/lan-share.ts#L158)、[lan-share.ts:577–601](../demo/electron/lan-share.ts#L577)、[lan-share.ts:664–736](../demo/electron/lan-share.ts#L664) |
| E06 | 登录正文上限 4 KiB；按 socket 来源地址统计失败，5 分钟窗口累计 5 次后封禁 30 秒。有基础防猜密码能力，但同步 scrypt 会阻塞事件循环；没有全局登录并发限额、会话总量上限和定期清理。反向代理后 socket 来源通常都成回环，不能照搬为按设备限流。 | [lan-share.ts:18–21](../demo/electron/lan-share.ts#L18)、[lan-share.ts:604–661](../demo/electron/lan-share.ts#L604) |
| E07 | 课程数据 API 先鉴权，再仅接受 GET；只识别课程 ID、清单中的文档 ID和固定资料类别。未知 `/api/` 返回 404。没有翻译/答疑/生成/写入 HTTP 接口；限制不只是隐藏按钮。session 路由本身未限制方法，应补严格方法匹配。 | [lan-share.ts:850–858](../demo/electron/lan-share.ts#L850)、[lan-share.ts:1076–1126](../demo/electron/lan-share.ts#L1076) |
| E08 | 输出清单、摘要、脑图经过字段投影，不返回工作区设置、凭据或整份浏览器存储；通过 ID 查课程再拼固定路径。文件层检查路径段和符号链接，静态资源也有逐段检查。不是通用文件服务器，也不能将其扩展为客户端传路径的读写代理。 | [lan-share.ts:213–348](../demo/electron/lan-share.ts#L213)、[lan-share.ts:397–428](../demo/electron/lan-share.ts#L397)、[lan-share.ts:444–471](../demo/electron/lan-share.ts#L444)、[workspace.ts:112–191](../demo/electron/workspace.ts#L112) |
| E09 | 实际已支持读取 `Translations/<documentId>/*.json` 中发布的译文，限制文件数、单文件大小和响应大小，校验字段并排除 mock；这比最早 LAN 文档描述更丰富，但不会生成新译文。 | [lan-share.ts:800–847](../demo/electron/lan-share.ts#L800)、[lan-share.ts:916–929](../demo/electron/lan-share.ts#L916)、[lan-share.ts:1130–1217](../demo/electron/lan-share.ts#L1130) |
| E10 | PDF 整个读入 Node 内存后返回 200，未实现 Range/206。浏览器下载完整 blob 转 File，再读 arrayBuffer 并复制给 PDF.js；慢网、大扫描件会增加首屏时间和内存峰值。 | [lan-share.ts:951–966](../demo/electron/lan-share.ts#L951)、[lan-share-api.ts:89–117](../demo/lib/lan-share-api.ts#L89)、[shared-pdf-reader.tsx:392–415](../demo/components/shared-pdf-reader.tsx#L392) |
| E11 | `?yeyu-share=1` 选择独立 `SharedCourseViewer`；同源 fetch 携 Cookie。SharedPdfReader 只有总结/脑图/已有翻译面板，没有 AI 面板。去掉 query 只能落入普通 Web UI，不能得到主机 IPC。`/share` 本身目前不足以判定共享模式。 | [page.tsx:2197](../demo/app/page.tsx#L2197)、[lan-share-api.ts:31–40](../demo/lib/lan-share-api.ts#L31)、[lan-share-api.ts:129–134](../demo/lib/lan-share-api.ts#L129)、[shared-pdf-reader.tsx:377–379](../demo/components/shared-pdf-reader.tsx#L377) |
| E12 | 查看器有 Canvas、TextLayer、DPR≤2、翻页/缩放、窄屏成果区。它先遍历所有页面尺寸才显示 PDF，`visiblePages` 只增不减，已访问页面不会从渲染集合移出；卸载只置 cancelled，没有销毁 loadingTask/pdfDoc。容器仍有 `min-h-[620px]`。不能把主阅读器已有优化等同于共享端也已拥有。 | [shared-pdf-reader.tsx:60–120](../demo/components/shared-pdf-reader.tsx#L60)、[shared-pdf-reader.tsx:384–424](../demo/components/shared-pdf-reader.tsx#L384)、[shared-pdf-reader.tsx:472–501](../demo/components/shared-pdf-reader.tsx#L472)、[shared-pdf-reader.tsx:529](../demo/components/shared-pdf-reader.tsx#L529)、[shared-pdf-reader.tsx:793–861](../demo/components/shared-pdf-reader.tsx#L793) |
| E13 | 三套 AI 设置含 Key，实际通过 `localStorage` 读写，不是主进程密钥链；知识库初次可继承答疑设置。缓存另有 IndexedDB。打开另一个浏览器 origin 不会继承 Electron 的设置。 | [reader-cache.ts:464–506](../demo/lib/reader-cache.ts#L464)、[chat-cache.ts:46–80](../demo/lib/chat-cache.ts#L46)、[knowledge-settings.ts:51–80](../demo/lib/knowledge-settings.ts#L51) |
| E14 | 翻译/答疑适配器直接 fetch 配置的 `/chat/completions`，Bearer Key 和正文一起发往该地址。答疑正文含原文/可选页图/历史；明确搜索意图可以调用第三方搜索。现有调用方在 UI 中构造 provider，未经过共享服务。 | [translation.ts:290–328](../demo/lib/translation.ts#L290)、[openai-client.ts:41–63](../demo/lib/openai-client.ts#L41)、[chat.ts:94–177](../demo/lib/chat.ts#L94)、[ai-chat-panel.tsx:226–243](../demo/components/ai-chat-panel.tsx#L226) |
| E15 | 知识库流程由 CourseLibrary 调度“提取/OCR→analyzeDocument→synthesizeCourseKnowledge→storage”。已有分块、输出校验、AbortSignal、缓存接口可复用，但默认摘要缓存依赖 IndexedDB；PDF.js loader 使用 `document.baseURI`，页图渲染使用 DOM Canvas，不能直接搬到无界面 Node。 | [course-library.tsx:567–657](../demo/components/course-library.tsx#L567)、[ai-knowledge-provider.ts:129–140](../demo/lib/knowledge/ai-knowledge-provider.ts#L129)、[ai-knowledge-provider.ts:257–286](../demo/lib/knowledge/ai-knowledge-provider.ts#L257)、[document-digest.ts:136–197](../demo/lib/knowledge/document-digest.ts#L136)、[pdfjs.ts:24–34](../demo/lib/pdfjs.ts#L24)、[page-vision.ts:59–66](../demo/lib/page-vision.ts#L59) |
| E16 | DesktopCourseStorage 先加载/比较 revision，之后多次异步写文件；单文件用临时文件+rename。没有覆盖整个业务提交的锁或原子 CAS。文档成果先写、History 后写；History 仅保存课程清单/知识/总结，不能当成所有 PDF/文档成果的完整备份。 | [desktop-course-storage.ts:173–235](../demo/lib/course-storage/desktop-course-storage.ts#L173)、[desktop-course-storage.ts:244–276](../demo/lib/course-storage/desktop-course-storage.ts#L244)、[desktop-course-storage.ts:464–575](../demo/lib/course-storage/desktop-course-storage.ts#L464)、[workspace.ts:228–249](../demo/electron/workspace.ts#L228) |
| E17 | 关闭所有桌面窗口就退出；退出停止共享。Electron 单实例锁只约束该应用实例，不能防止以后 Node 服务并行写目录。 | [main.ts:360–369](../demo/electron/main.ts#L360)、[main.ts:385–387](../demo/electron/main.ts#L385)、[main.ts:409–411](../demo/electron/main.ts#L409) |
| E18 | 已有认证、会话、只读、路径安全、占用端口和临时目录哈希测试；共享浏览器回归覆盖来源跳页、窄窗口等，依赖显示环境可跳过，不等于手机 Safari/Android 或 Tailscale 实测。 | [lan-share.test.ts:418](../demo/tests/lan-share.test.ts#L418)、[lan-share.test.ts:539](../demo/tests/lan-share.test.ts#L539)、[lan-share.test.ts:624](../demo/tests/lan-share.test.ts#L624)、[lan-share.test.ts:793](../demo/tests/lan-share.test.ts#L793)、[shared-viewer-regression.test.ts:1455–1535](../demo/tests/shared-viewer-regression.test.ts#L1455) |

安全头目前只有 `nosniff`、`no-referrer`、`noindex,nofollow`（[lan-share.ts:85–89](../demo/electron/lan-share.ts#L85)）；数据返回 `no-store`。未见明确 Host/Origin 校验、CSRF token、CSP 或防嵌入策略。它们应作为远程写操作开放前的补强，不应据此把目前只读功能描述成已经被攻破。

## 3. 与目标的差距

| 目标 | 已有基础、需扩展 | 在共享/主机服务侧完全缺失的部分 |
| --- | --- | --- |
| 外地访问 | Tailscale 互通是用户提供的前提；现有 IPv4 监听可能已可达，`host` 可配置 | 正式 remote 模式、绑定地址对应的状态展示、固定 externalOrigin、tailnet 策略与入口验收 |
| 浏览器安全登录 | 密码摘要、随机会话、过期、退出、基础限速 | HTTPS/Secure Cookie、CSRF/Origin/Host、持久凭据和恢复开关、会话上限、全局限速 |
| 翻译/问答 | 完整桌面适配器、SSE 解析、取消信号、已发布译文读取 | 主机任务 API、服务端 provider/密钥配置、主机会话存储、同源远程客户端适配器 |
| 私密 AI | 可替换的兼容接口、文字/视觉输入与分块 | 经实测合格的本地文字/视觉模型、禁止外发的出口策略；主机硬件能力尚未知 |
| 知识库生成 | 摘要/综合/校验/渲染和 CourseStorage 可复用 | 脱离可见 UI 的任务执行器、后台状态/取消/恢复、主机 PDF 提取/页图入口 |
| 可控资源与费用 | 各 provider 已有部分取消、重试、缓存机制 | 全主机队列、幂等、配额预留、用量记账、长任务超时、异常重启处理 |
| 写入一致性 | revision、单文件 rename、History、路径约束 | 桌面+远程统一的业务提交锁、提交前再次比较、故障恢复、全量备份与恢复演练 |
| 常驻服务 | Electron main 内已有 Node HTTP/文件层 | 无桌面 Node 入口、自启动、凭据非交互加载、进程监管和脱敏日志；图形会话自启也未实现 |
| 手机使用 | 同源数据 API、TextLayer、翻页缩放、窄屏成果面板 | 移动实机验收、PDF Range 流式加载、真虚拟化/资源释放、触屏选段动作和键盘适配 |

## 4. 五种候选方案及取舍

工作量按单人完成实现、相关测试及验收估计：小约 1–3 个工作日，中约 1–2 周，大约 3–6 周或以上；这是规划尺度，不是交付承诺。本地模型适配、扫描件质量和硬件瓶颈另计。A 是连通性/只读过渡；B/C/D 共用第 5 节的 AI 和写入工作，不能重复相加或误认为接 HTTPS 就完成 AI。

| 方案 | 做法与改动模块 | 安全影响 | 工作量与体验 | 失败模式与回退 |
| --- | --- | --- | --- | --- |
| A：Tailscale IP 直连 HTTP | 先验证现有 `http://100.98.55.70:37891/share?yeyu-share=1`。产品化时 main 显式传 `host: '100.98.55.70'`，修改 lan-share 的地址展示和 api/course-library 的状态字段；继续只读，不新增业务写接口。绑定失败应报错，不能回退 `0.0.0.0`。 | Tailscale 隧道已有加密，但 HTTP URL 不让浏览器成为可信 HTTPS origin；Cookie 仍无 Secure。IP 绑定不是用户授权，仍需 tailnet 策略+原密码。 | **小**；最快确认远程读资料。无法满足新 AI 需求，不作为最终交付。 | IP 未分配、Tailscale 未启动、策略/防火墙阻断、主机休眠；保留本地桌面使用，关闭该共享监听。不通过开放所有网卡“修复”。 |
| B：Tailscale Serve HTTPS + Electron 内业务服务（推荐起步） | 页语 remote 监听 `127.0.0.1:37891`；Serve 代理整个同源站点。扩展 lan-share/main/api/preload、shared 两组件、lan-share-api；增加 remote-auth、remote-jobs、ai-service、主机 PDF worker、统一课程提交模块。 | tailnet 门禁+应用密码双层；Secure Cookie、CSRF 等在应用内落实。密钥只在主机；AI 只连本地模型。仍依赖桌面图形会话，常驻不能只靠 Serve。 | **中：安全入口+翻译/答疑；完整知识库和写入为大**。浏览器原生阅读/触屏体验最好，能复用现有 UI 和领域逻辑。 | Electron 退出、worker 崩溃、模型 OOM、长任务断网；按 jobId 恢复查看，停止新增 AI 后保留已生成资料；关闭 remote 模式及本服务的 Serve 映射。 |
| C：Tailscale + 本地 HTTPS/私有 CA + 同一业务服务 | B 的业务层不变，TLS 由 Node `https.createServer` 或仅绑定 tailnet IP 的本机反向代理终止。新增 remote-tls 配置、证书读取/续期运维说明。证书 SAN 包含实际 IP/主机名。 | 可避免公开证书透明日志中的设备名，但要在每台客户端可信地安装私有 CA；CA 私钥只留主机/离线管理位置，不复制给客户端。 | **中，完整业务为大；比 B 多证书运维**。浏览器信任配置后可正常使用；手机安装 CA、系统信任开关和续期更麻烦。 | 自签不受信、SAN 不匹配、证书过期、换机后失去信任；回退 B 或只读 A，不能把“点击忽略警告”作为长期安全方案。 |
| D：Tailscale Serve HTTPS + 独立 Node 常驻服务 | 从 B 提取可复用服务装配，新增 `demo/server/main.ts`、Node PDF adapter、服务构建脚本和 systemd unit；Electron 通过受限 IPC 到同一业务核心/本机服务，不再另当写入者。 | 能独立于桌面登录运行；必须有工作区级单写者约束、服务凭据和最小权限。不能让 Node 和旧 Electron 各自认为自己是唯一写入者。 | **大，五者最大**。浏览器断开和桌面退出都不影响后台任务；增加运行时和打包工作。 | 服务抢锁、目录配置错、无头 PDF/OCR 不兼容、升级失败；服务启动失败关闭写接口；停服务并完成目录交接后再回桌面独占。 |
| E：Tailscale HTTPS + noVNC 操作主机桌面 | 本机 noVNC/websockify/VNC 串联，通过 Serve 暴露浏览器入口；VNC 和 WebSocket 后端仅回环，不发布 VNC 原始端口。页语不必新增 AI API；新增的主要是部署配置与运行说明。 | 等同远程操控 Linux 用户桌面，可见设置/密钥且可操作其他文件，权限远大于页语业务 API。使用专用会话、VNC 认证、Origin 校验，关闭不需要的剪贴板/文件传输。AI 外发风险仍在，不能借此绕开本地推理要求。 | **小到中：部署试用；隔离和可靠运行更接近中**。最快体验当前桌面全部功能，电脑上可用；手机像操控远程屏幕，文本选段、键盘与 PDF 缩放较差。 | Wayland/X11 会话兼容、锁屏/注销、图形渲染、WebSocket 断线、桌面操作互相干扰；停网关即可回本机桌面。只作临时替代，不作推荐产品路线。 |

noVNC 是浏览器 VNC 客户端，通常配合 WebSocket 到 VNC 的代理；支持手机浏览器不等于页语触屏体验合格。[noVNC 官方说明](https://novnc.com/info.html)、[websockify 官方仓库](https://github.com/novnc/websockify)。

**排序：A（只读） < E（试用） < B（原生远程） ≤ C（同业务+证书维护） < D（无桌面常驻）。** B/C 的完整目标也属于大工作量。公网转发、Funnel、付费云服务器、把课程托管到静态站点/网盘等不在候选范围内；它们既不解决主机业务 API 缺口，也违反本轮约束。

## 5. 推荐路线的具体设计

### 5.1 网络、TLS、身份和原会话的关系

目标链路：

```text
本人浏览器（本人已入网设备）
  → Tailscale 网络门禁
  → https://<主机名>.<tailnet>.ts.net/share?yeyu-share=1
  → 本机 tailscaled Serve 终止 TLS
  → http://127.0.0.1:37891（remote 模式，密码+会话+权限）
  → 主机任务队列 → 本地推理端点 / 工作区业务服务
```

Serve 仅供 tailnet 内访问，Funnel 是公网入口，二者不能混淆；Serve 也受 tailnet 访问规则约束。本方案把 Serve 当作用户已有 Tailscale 的本机接入组件，而不是资料托管服务。[Tailscale Serve 官方说明](https://tailscale.com/docs/features/tailscale-serve)。

后续实施时先检查实际版本、现有 Serve/Funnel 配置、443 是否已用于其他服务，再执行部署，不覆盖已有映射。本轮没有执行下列命令：

```bash
# 只读核对：在主机执行，并避免把包含设备身份的完整输出公开
tailscale version
tailscale ip -4
tailscale status
tailscale serve status
tailscale funnel status
ss -ltnp

# 以下仅为以后部署模板：后端已切为回环、证书及策略已确认后才执行
tailscale serve --bg --https=443 http://127.0.0.1:37891

# 仅撤销上述页语映射；保留同机其他 Serve 配置
tailscale serve --bg --https=443 off
```

应以本机 `tailscale serve --help` 核对版本语法。`--bg` 让映射在 tailscaled 重启后恢复，**不会启动或监管页语**。根路径代理可同时覆盖 `/api/`、脚本、PDF worker 和字体；不要只代理 `/share`，更不能把 Serve 目标设成真实课程目录。若 443 已占用，应分配独立 HTTPS 端口和匹配 origin，而非重置所有 Serve 配置。[Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

部署门槛：

- remote 模式监听 `127.0.0.1`，状态返回实际绑定地址与配置的外部 HTTPS 地址；不再用全部网卡列表伪装可用入口。固定 IP `100.98.55.70` 用于网络定位，浏览器正式使用证书对应的完整 `*.ts.net` 主机名，不能把主机名证书用于 `https://100.98.55.70`。
- 在 tailnet 原有 grants/ACL 基础上，只允许本人选定设备到主机的 HTTPS 端口；移除仍会放行的宽泛规则后验证。不要把 `100.64.0.0/10` 当成本人的设备集合。若要求“只有这两台设备”，只限制登录用户也不够，需精确设备来源约束。系统防火墙检查所有实际入口，不默认某一条 UFW 规则必然覆盖 Tailscale。[Tailscale grants](https://tailscale.com/docs/features/access-control/grants)。
- 明确关闭/不授权本机 Funnel，并做非 tailnet 访问失败验收。若还保留 LAN 只读服务，应另起受限监听实例，强制只有 `read` 能力、独立会话命名与凭据；禁止把 remote 的 AI/写入路由挂到旧 `0.0.0.0` 监听器。单人场景优先关闭旧 LAN 入口，家中也通过 Tailscale 使用。
- Tailscale 数据链路使用 WireGuard 加密，直接或 DERP 中继都不会让中继读取明文；但会依赖第三方协调/可能经过密文中继。如果“不经第三方”连密文转发也禁止，就与现有 Tailscale 使用前提冲突，不能承诺本方案满足这种更严格含义。[Tailscale 连接类型](https://tailscale.com/docs/reference/connection-types)。

TLS 的现实选择：

| 方式 | 加密/浏览器效果 | 本方案意见 |
| --- | --- | --- |
| Tailscale 上 HTTP | 设备间隧道加密，但浏览器不知道这层保护；普通远程 HTTP origin 仍非安全上下文 | 只用于 A 的诊断/只读过渡；不能因装了 VPN 就声称 HTTPS 已完成 |
| Serve 自动 HTTPS | 浏览器信任的主机名证书，前端同源 HTTPS，后端回环 HTTP；无需开放公网 80/443 来托管资料 | 默认推荐；开启 MagicDNS/HTTPS 并使用实际完整域名 |
| 私有 CA/自签 HTTPS | 正确信任和匹配 SAN 后可用；未信任时警告/请求失败，手机配置各异 | 仅在拒绝公开证书名字时选 C；不指导关闭证书校验 |
| 手工 `tailscale cert` + Node/反代 | 可复用 Tailscale 主机名证书，但自行保管私钥、续期、重载 | 已有成熟反代时可选；本项目没有必要先增加这一层运维 |

Tailscale 证书会公开设备完整域名到证书透明日志，不公开课程；先检查主机名是否含敏感信息。证书的域名、签发与续期条件以官方说明为准。[Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)。浏览器对远程 HTTP 的安全上下文限制仍然存在；HTTPS 也不会让浏览器直接读取主机硬盘，主机数据仍走 API。[MDN Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)。

**鉴权不需要重做成账号平台，但必须扩展现有密码/Cookie：**

1. 新增 `demo/server/remote-auth.ts`，复用密码摘要与随机会话思路；初始推荐长随机口令（至少 16 字符），持久化盐、scrypt 参数及摘要到工作区外的本机配置文件（目录 0700、文件 0600），不存明文口令。新增非交互启动入口读取摘要；首次没有凭据时 remote 服务保持关闭。
2. remote Cookie 使用独立 `__Host-yeyu_remote_session`：`Secure; HttpOnly; SameSite=Strict; Path=/`，不设 Domain；12 小时绝对过期可沿用，不把 token 放 URL/localStorage。会话仍放内存，重启全部失效是可接受的单人取舍；建议最多 8 个会话，定期清理，改口令/停止服务立即撤销。浏览器 `Secure` 标志由固定 remote HTTPS 配置决定，不盲信请求的 `X-Forwarded-Proto`。[Cookie 属性规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。
3. `GET /api/remote/session` 返回有效期、只读能力清单和 session 绑定的随机 CSRF token。所有改变状态的 POST/PATCH/DELETE 校验 CSRF header、`Origin === externalOrigin`、JSON Content-Type，并限制 Host；登录也检查 Origin/格式，logout 检查 CSRF。不开放跨域 CORS。`SameSite` 是补充，不替代这些校验。
4. 权限是一个主机用户的开关集合：`read / translate / chat / generate / manage`；后端每次检查，不信浏览器传回的开关。默认只读，远程 AI 和生成由主机本地开启，远程端不能提升权限或修改模型地址/密钥。
5. 密码哈希改为异步并限制并行验证为 1；保留失败窗口，增加全局请求限额/队列上限。Serve 后可先按全局限额+会话限额处理单人使用，不急于依赖身份 header。若将来使用 Tailscale identity header，只有在代理来源被限定且无直连绕过时才可信；绝不直接相信任意客户端的 X-Forwarded-For。
6. remote 页面补 CSP（按生产构建校验脚本/hash/worker需求）、`frame-ancestors 'none'`、安全链接和远程图片限制。Markdown 不执行原始 HTML，不加载回答里的第三方图片，避免资料经图片 URL 外泄。前端 `connect-src` 限制为同源，模型推理只在主机发生。

### 5.2 主机 AI：隐私、密钥、执行位置

严格隐私模式的数据流为“本人浏览器 ↔ 本人主机 ↔ 主机回环本地模型”。模型权重可以预先下载，课程内容不随下载发送。可评估 llama.cpp 的本地兼容接口与视觉支持，但本轮不指定模型大小，不承诺小主机能流畅运行；先核对 CPU、RAM、GPU/显存，并用非敏感夹具测试译文、图表/OCR、知识库 JSON 与中文问答质量。[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[多模态说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)。

本地推理端点只监听回环、固定端口；不启用模型服务自带文件工具/MCP/联网工具。缺少视觉模型就明确禁用 OCR/视觉答疑，不能偷偷切换到云模型。主机算力或质量不达标时，允许停留在远程只读/文字功能；“不上传第三方”和“完全沿用云模型效果”不能同时无条件保证。

具体模块安排（均为拟改/拟新增）：

| 文件 | 改动职责 |
| --- | --- |
| `demo/server/ai-service.ts`（新增） | 用主机配置创建 translation/chat/knowledge provider；服务端构造系统提示和上下文，只允许列举的任务类型，不提供通用 `/proxy?url=` 或任意 chat-completions 转发 |
| `demo/server/remote-config.ts`（新增） | 读取外部 origin、绑定模式、能力、预算、本地模型端点；配置与凭据位于工作区之外。缺失/非法配置 fail closed，不降级开放 |
| `demo/server/credential-store.ts`（新增） | Key/本地服务令牌保存在主机，响应只返 `configured` 等非敏感状态；优先系统凭据能力，不能无人解锁时用严格文件权限的本机 secret 文件并如实说明不是加密保险箱 |
| `demo/lib/translation.ts`、`chat.ts`、`openai-client.ts` | 保留提示词、流式解析、错误分类与取消；注入服务端配置/fetch，增加 usage 与超时所需数据。远程模式屏蔽可回显供应商请求内容的原始错误 |
| `demo/lib/knowledge/ai-knowledge-provider.ts`、`knowledge-settings.ts` | provider 显式注入配置和主机缓存，不能走 localStorage/IndexedDB 默认值；支持本地模型能力验证，不因空 Key 回退 mock。取消 UI 设置模块对服务运行时的隐式依赖 |
| `demo/electron/pdf-task-worker.ts`、专用 worker preload（新增） | B 阶段使用受沙箱约束的本机隐藏 BrowserWindow 运行现有 PDF.js/Canvas，按 jobId 读取批准的 PDF，返回页文字/临时页图。它不加载远程 URL、不持有模型 Key、不暴露通用 fs；图片用完释放，不持久化 |
| `demo/lib/knowledge/document-digest.ts`、`pdfjs.ts`、`page-vision.ts` | 注入 PDF/Canvas 运行时边界；B 复用 Chromium 实现，D 才补 Node PDF.js/Canvas adapter 与实测，不假定 DOM API 在 Node 可直接用 |
| `demo/lib/document-chat.ts` | 把按页提取的文本作为可注入输入，主机复用现有关键词检索与页码引用逻辑，不引入向量库；整篇检索答疑单独验收 |
| `demo/server/host-cache.ts`（新增） | 复用现有缓存键语义，持久保存完成的译文/OCR/摘要/答疑；与 browser KV 分离。增加配置标识，区分同模型名但不同本地端点/模型版本 |
| `demo/lib/remote-api.ts`（新增）、`lan-share-api.ts` | 保留只读调用，新增同源任务/事件客户端，不传 Key、provider URL、文件路径或客户端自造的系统提示词 |
| `shared-course-viewer.tsx`、`shared-pdf-reader.tsx`、`ai-chat-panel.tsx` | 按服务端 capabilities 显示 AI/生成入口；给聊天面板注入远程 transport 和主机会话接口，不能直接复用其浏览器 provider 创建逻辑 |
| `demo/electron/api.ts`、`preload.ts`、`main.ts`、`reader-settings-dialog.tsx` | 本机管理配置、一次性迁移旧 renderer 设置的受限 IPC；迁移成功并验证后才清除旧明文 Key。后续 getSettings 返回脱敏视图，桌面 AI 也走主机服务，避免双份配置 |
| `demo/scripts/build-electron.mjs`、`electron/tsconfig.json`、`package.json` | 现有 Electron rootDir 仅限 electron；跨目录复用 server/lib 必须增加明确的服务 bundle/编译入口与 worker 产物，保留 sandbox preload 单文件打包。不能仅添加 import 就宣称可打包 |

翻译/答疑/知识库保持三套逻辑配置，即使指向同一本地模型也不共享可变设置。页面/OCR缓存和知识成果是私密资料，不输出日志、不进入 git，不复制到公共站点。现有课程中 `Translations` 的发布格式继续复用；远程生成先写主机缓存，只有显式选择发布时才提交课程内译文，保持“读资料”和“改资料”边界清晰。

**不外发必须由服务控制。** remote 模式的出站 fetch 只允许预配置回环 IP+端口，拒绝用户 URL、重定向到外部、外部图片 URL、代理环境绕行和任意工具调用；主机本地模型进程同样审计联网/遥测配置。禁用 `web-search.ts` 的实际出口，不能仅靠提示词或 UI 开关。预算默认“第三方花费 0”；若以后用户明确改变硬约束，需另做供应商数据边界审查，不能本轮预先启用。

### 5.3 新接口与任务契约

保留 `/api/share/*` 为原只读协议；remote listener 在同一 origin 上增加以下 `/api/remote/*`。服务端路由精确匹配长度/方法。旧 LAN listener 不注册这些路由。所有数据/任务/事件接口均鉴权；状态变更另校验 CSRF 与 capability。

实现时把 `lan-share.ts` 的读资料处理与认证策略分离：**remote listener 上复用的 `/api/share/courses...` 读取路由必须验证 remote Cookie**，不能继续硬编码 `yeyu_share_session`，否则新登录后仍无法读课程。LAN 实例仍用旧会话和只读权限；remote 实例禁用旧 `/api/share/login/logout/session` 认证入口，只接受下表定义的 remote 会话，避免旧低强度登录成为绕过路径。`shared-course-viewer.tsx` 的登录/退出/过期处理和 `lan-share-api.ts` 的错误处理也要按服务模式使用同一认证契约。

| 方法与路径 | 入参/响应 | 后端动作 |
| --- | --- | --- |
| `POST /api/remote/login`、`POST /api/remote/logout`、`GET /api/remote/session` | 密码仅 login 正文；session 返回 expiresAt、capabilities、csrfToken | 复用并加固密码会话；不返回口令摘要或 Key |
| `POST /api/remote/jobs` | `type`、`courseId`、`documentId`、适用的 `pageNumber/targetLanguage/question/selection`、`expectedRevision`；header 带 `Idempotency-Key` | 校验文档存在和页码范围、建立不可变快照；成功 `202 {jobId,status,statusUrl,eventsUrl}`。type 枚举 translate-page、translate-selection、chat-page、chat-document、generate-document、synthesize-course、publish-translation |
| `GET /api/remote/jobs/:id`、`GET /api/remote/jobs?active=1` | 状态、进度、结果/错误码、用量；仅本人实例任务 | 重连后查询已有任务，不重复提交；无权限 403、过期 401 |
| `GET /api/remote/jobs/:id/events` | SSE：有序 eventId、status/delta/progress/done/error；同源 Cookie | `text/event-stream`、`no-store`；小范围事件缓冲，支持续看/状态快照；没有生成副作用 |
| `POST /api/remote/jobs/:id/cancel` | 无任意 provider 参数 | 撤销排队或触发 AbortController；幂等返回当前状态 |
| `GET /api/remote/conversations/:courseId/:documentId?scope=page&page=...` | 主机已有对话，或 scope=document | 复用页级/文档级 key 语义；服务端保存完成消息，多设备刷新可见 |
| `DELETE /api/remote/conversations/:courseId/:documentId?...` | CSRF、明确的会话 scope | 只清理选择的聊天记录，不删 PDF/知识库 |
| `GET/PUT /api/remote/reading-state/:courseId/:documentId` | 页码、缩放、version，PUT 带 If-Match | 主机保存进度；冲突返回 409，避免手机旧状态覆盖电脑新状态 |
| `GET /api/remote/capabilities`、`GET /api/remote/health` | 鉴权后返回功能/模型就绪/队列状态，不含路径或 secrets | 本地运维探针另走受限回环/Unix socket，不公开管理功能 |

请求只能引用课程内文档；主机从文件提取原文，不能相信浏览器声称的指纹、页数、源文本或生成成果。选段需绑定文档与页码，限制长度并与主机页文字/选区核对。禁止客户端提交任意磁盘路径、覆盖目标、模型地址、Key、max_tokens 或任意消息角色。

建议起始限额（非已测性能）：登录 4 KiB；任务 JSON 64 KiB；问题/选段各最多 8,000 字符；队列最多 10 个；同一任务 SSE 最多 2 条连接；主机同时仅 1 个推理请求，PDF 解析最多 1 个。文字、页图由主机生成和限制：单页最多 4 百万像素，图片编码上限 8 MiB；输出设明确 token 上限。超限 413，排队/额度满 429+Retry-After，文档消失 404，版本冲突 409，不支持功能 422。参数须经第 P0 阶段实测调整。

队列放在新增 `demo/server/remote-jobs.ts`，不用 Redis。持久状态放主机私有状态目录，记录 `queued/running/succeeded/failed/cancelled/interrupted`、输入引用、配置版本、幂等 key、预算预留和完成结果位置：

- 翻译/问答交互任务优先；知识库按块执行，在块间让出队列。限制连续交互插队，避免批任务永远饿死。取消预取比取消用户主动任务优先，默认关闭远程自动预取。
- 入队与执行前均校验 capability、文档指纹和预算。同一个幂等 key+相同输入返回同 job；同 key 不同输入返回 409；同一页面相同缓存身份可合并任务，强制重新生成须显式操作。
- 暂定模型单次调用总超时 180 秒、流空闲超时 60 秒，知识任务总时限 30 分钟（本地慢模型可由主机调整）。使用贯穿提取/推理/提交的 AbortSignal，取消排队立即生效；提交事务开始后完成或恢复该小事务，不在中途留下半套成果。
- 浏览器锁屏/断线只断开订阅，不自动重发任务；短任务可继续至时限，知识任务继续运行，重连按 ID 查询。退出登录默认取消该会话仍在运行/排队的任务；到期后不再接收新任务，已批准的有界任务可完成，重新登录后查看。主机“禁用远程 AI/撤销全部会话/停止服务”取消全部远程任务。
- SSE 每约 15 秒心跳；重连可能重复事件，前端按 eventId 去重。缓冲丢失时回到状态快照；不承诺进程崩溃后的逐 token 完整回放。每次订阅校验会话，到期关闭事件流。
- 重启把 running 标为 interrupted，queued 默认暂停待用户恢复；不自动重跑可能已经消耗推理/费用的整份 PDF。只复用成功校验的分块缓存；幂等记录/额度在重启后仍有效。
- 将现有 provider 的重试与外层队列重试统一计数，避免乘法式重试；流已产生输出或供应商是否受理不明时不自动重复。知识库 JSON 一次修复重试也计入调用预算。取消并不保证上游停止计算或免计费。

费用与滥用控制即使本地推理也要落实：主机按日请求数/token/推理时长设硬上限，任务开始前预留预算，结束后结算；同时约束内存/页数/CPU 时间。本地模式无第三方账单，但仍可能耗尽主机资源。预留结构支持未来明确授权的按模型费率估算，并接 usage 记账；未知 usage 标成估算，不虚报精确费用，精确货币上限还需供应商自身额度。日志只记录随机 jobId、类型、状态、耗时、计数、错误类别，不记录问题、回答、文件名、PDF 内容、token、Key 或请求正文。

### 5.4 写入、课程目录和桌面端协调

知识库生成是写操作，必须先解决 E16：两个调用者都读到 revision=7，分别通过检查，随后都提交 revision=8，单文件 rename 也挡不住丢失更新。同一 Electron 进程里的多个异步请求也会发生，不只是多进程问题。

推荐新增 `demo/server/course-service.ts`，承接 `generate/updateDocumentArtifacts/mergeDocument/import/remove/restore` 等业务事务；`DesktopCourseStorage` 和 remote job 都经它提交。复用纯分块、合并、渲染和路径校验，禁止把 `YeyuDesktopApi.writeFile(relativePath, data)` 原样暴露到 HTTP。

最小可执行提交协议：

1. 任务取输入快照（courseId/documentId、PDF 指纹、revision、相关文件哈希、配置版本），耗时推理在锁外进行。
2. 提交时取得按课程的互斥锁，再读取当前 manifest 并比较 revision/指纹/受影响文件哈希；不匹配返回 409，保存私有候选结果供检查，不自动覆盖、不自动重新付出整份生成成本。
3. 在私有 staging 写入并校验所有新成果，先保留受影响旧文档成果及清单的完整快照；新 JSON 使用不可变版本标识。现有 `knowledge-vN` 不能覆盖仍由旧 manifest 引用的同版本文件。
4. 短事务内完成文件安装，最后原子切换 manifest；读 API 在这个阶段使用同一锁或稳定快照。短期沿用固定文件名时必须加提交 journal，记录每项替换及恢复状态，启动先恢复，再开放读写；不能只说“manifest 最后写”就声称多文件事务已原子化。
5. 完成后更新桌面/远程视图；按容量策略清理已失效 staging，不删除仍由任务/版本引用的文件。持久性需要文件和目录同步策略；rename 本身不等于断电耐久保证。

旧桌面粗粒度文件 IPC 绕过业务事务的问题必须一起解决：所有会修改课程的入口（生成、导入、合并、删除、译文发布、历史恢复）迁到同一协调器，或在迁移期间硬性禁用相应写入口。只禁用 UI 按钮、只在 Node 服务里放一个锁、只要求用户“别同时用”，都不算防护完成。

D 阶段额外使用覆盖工作区的操作系统级独占锁/单写者进程：常驻服务持锁，Electron 只作客户端；旧版本桌面不可同时打开这个可写工作区。外部编辑器不遵守锁，仍需提交前文件哈希检查和“应用写入期间勿手工修改”的使用边界；无法保证任意外部进程并发写入安全。

第一次启用远程生成前，建立真实课程目录的本地离线备份与恢复演练，不上传第三方。[现有数据保护记录](LAN-SHARING-DATA-PROTECTION.md) 明确没有真实备份证明，仅有临时夹具哈希测试。今后的验收必须分别证明“只读访问不改文件”和“生成只改预期成果、冲突/中断不损坏旧成果”。回退旧应用前先停新服务并恢复兼容数据快照，不能认为 git revert 能撤销课程数据变更。

若用户要求浏览器进一步拥有完整管理能力，后续在相同事务/权限体系中增加：`POST /api/remote/courses`（创建）、`POST /api/remote/courses/:id/documents`（限大小 PDF 导入到本人主机，先暂存/校验指纹再入队）、`PATCH .../documents/:id`（纳入状态）、`DELETE .../documents/:id`、`DELETE .../courses/:id`、`POST .../courses/:id/revisions/:revision/restore`。删除默认移入主机私有回收区，缺回收能力时拒绝，不能沿用桌面回收失败就物理删除的回退。编辑只允许明确 schema 的用户笔记/节点接口，附 If-Match。该批接口以 `manage` 默认关闭，纳入单独验收；网页永不获得任意路径写入或远程修改密钥/监听策略的权限。

### 5.5 常驻、自启动和运维

**B 的边界：** 可新增“关闭窗口仍在托盘运行”、本机启用的共享恢复配置，以及图形会话登录后的自启动。密码摘要和模型令牌必须可安全非交互加载。它依赖用户登录/显示会话；仅 `Restart=on-failure` 包住当前 Electron，不能凭空实现无人登录启动，当前正常关闭窗口也会退出。先允许用户接受这一阶段限制，不要求自动登录桌面。

**D 的边界：** 新增无 Electron 依赖的 `demo/server/main.ts`，入口加载明确配置、工作区、静态目录、credential store、queue、course-service。首次启动不猜 `~/Documents`，使用经确认的绝对路径并验证根目录/版本；目录不存在时不静默新建另一个空工作区。新增 `demo/scripts/build-server.mjs` 和 `server:build/server:start`，Node 版本遵循项目 engines，打包产物不依赖开发服务器或外部静态网站。

拟新增 `deploy/systemd/yeyu-remote.service`（实施阶段才写）。采用 systemd 系统 unit、以工作区所属普通用户运行，或经用户选择的 user unit+linger；二选一，不同时安装。系统 unit 的关键配置为：

```ini
[Unit]
Description=页语私有远程服务
After=network-online.target tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=<工作区所属用户>
WorkingDirectory=<已安装的页语服务目录>
ExecStart=<node绝对路径> <服务产物绝对路径> --config <不含密钥的配置文件路径>
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

这是含占位符的部署模板，不是当前可启动 unit。`Restart=on-failure` 处理异常退出；进程仍活着但卡死需健康检测与任务时限，不能声称该设置覆盖一切故障。[systemd 官方服务说明](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)。

上线验收还包括：SIGTERM 停接新任务、取消/标记未完成任务并结束事务；重启会话失效；模型慢启动时 health 标记未就绪但可读资料；journal 限额/保留期；设置/任务状态权限；构建版本与配置版本可追踪。主机断电、休眠、网络断开无法由应用重启策略解决，需由用户决定电源策略。采用私有 CA 时另加证书有效期检查；Serve 正常不代表其后端健康。

不将 secrets 放 ExecStart、命令行、仓库、课程目录或 unit 内；不运行 root 页语。常驻服务和本地模型分别受内存/CPU 限额，模型 OOM 不能拖垮读取课程的 HTTP 服务。常驻迁移必须验收“冷启动、无人登录可读+可运行任务”和“桌面连接同一服务，无第二写入者”。

### 5.6 手机浏览器：必须实际补齐的阅读链路

不依赖手机 File System Access API：课程始终由主机 API 提供。需要同时改 `shared-pdf-reader.tsx`、`shared-course-viewer.tsx`、`lan-share-api.ts`、`pdfjs.ts` 和 `app/globals.css`：

- 先显示首页与估算占位，复用 `progressive-page-sizes.ts` 的渐进尺寸思想；离开视口卸载 Canvas/TextLayer，保留当前页及少量邻页。加载/换文件/退出时取消 loadingTask、renderTask 并 destroy PDF 文档，测试反复打开不会累积 worker/内存。
- PDF GET 增加安全的单范围 Range/206、Content-Range/Accept-Ranges、HEAD、416 与流式读取；每次 range 都鉴权。增加稳定 ETag/If-Range 或等价版本校验，防止多段来自不同 PDF 版本。安全路径检查要覆盖实际打开的文件；限制并发与无效范围，不能把所有范围再次全文件读内存。
- `loadSharedPdf` 改为返回受保护同源 URL/元数据，PDF.js 用 URL+凭据加载；扩展现有 `pdfjs.ts` 只接 `data` 的类型。确保 PDF worker、字体/CMap/wasm 等实际使用资源从主机本地构建产物提供，不用第三方 CDN；不能只改服务端 Range 却继续前端全量 blob 下载。
- 手机默认适合页宽、原文与 AI 面板单屏切换/抽屉，保留返回原文位置；采用 `100dvh`、安全区和动态键盘布局，移除共享端 620px 最小高度。翻页/页码输入/取消按钮触摸区域建议至少 44px；横竖屏切换保持页码，缩放后仍可选字。
- 已有 TextLayer 可以选字，但需连接 `selection.ts`、`selection-toolbar.tsx` 的能力：长按选段后提供翻译/解释；选区快照绑定页码，原生选择手柄优先，不以全局 `preventDefault` 破坏滚动/双指缩放。扫描件没有文字层时提供整页提问/主机 OCR 明确入口，不虚报可选字。
- 手机锁屏常会暂停页面连接；进度/任务结果由主机保存，回前台先检查 session 和 jobId。登录到期回到同一文档页，不能因重连再次收费/推理。默认不做离线 PDF/PWA 缓存；no-store 也不能阻止已授权浏览器保存或截图，设备必须是用户信任的设备。

后续验收矩阵：桌面 Chrome/Edge、真实 Android Chrome、真实 iOS Safari；至少 360/390px 竖屏与横屏、虚拟键盘弹出、原生长按选字、200 页文字 PDF、50 MiB 扫描 PDF、连续翻到末尾再返回、10 次打开关闭、4G 切换/锁屏 5 分钟、会话到期/主机重启。记录首屏时间/主机和客户端内存基线与峰值，限额以目标设备实测确定。当前仅有窄窗口测试，不声称已通过这些手机验收。

## 6. 分阶段执行与独立验收

推荐按 P0→P1→P2→P3→P4 实施；P5 是否前置由无人值守需求决定。P0 可以与入口设计并行做技术验证，但本轮未执行。每个实施阶段均补/更新相关测试、完成该阶段检查、独立中文 commit；本轮“不要动测试”的限制只针对本次文档任务。

| 阶段 | 实施包与工作量 | 独立验收标准 | 失败/回退 |
| --- | --- | --- | --- |
| P0：边界与可行性 | 小；核对运行版本是否真是 b82f932、监听/Tailscale/证书现状、主机算力、目标手机；非敏感 PDF 测本地文字/视觉模型 | 能明确回答“现有 IP 是否可达”“HTTPS 名称是什么”“本地 AI 哪些能力质量/耗时可接受”；不外发资料的出口验证通过 | 算力不足保留只读，不采购云推理；留下测量结果供用户决定资源投入 |
| P1：安全远程只读 | 小到中；落地 B 的回环绑定、externalOrigin、Serve、独立 remote 会话/凭据、安全头、权限默认 read；修正 /share 路由识别及地址展示 | 本人外网设备 HTTPS 登录读 PDF/成果；无 tailnet/无会话不可读；旧 LAN 不能访问 remote 路由；重启/退出/过期失效；真实目录前后哈希一致 | 停 remote+仅撤销页语映射，桌面仍可使用；保留旧数据格式 |
| P2：主机翻译与答疑 | 中；主机配置/本地推理、任务队列/SSE/取消/预算、PDF worker、缓存/会话 API；覆盖页面、选段和整篇问答 | 浏览器网络仅访问页语，无 Key/供应商地址；模型出口只回环；中文/公式/图表夹具、重复请求幂等、断网重连、取消、超时和配额全部通过；不写课程成果 | 主机关闭 translate/chat，降回 P1；失败结果不发布，不回退云模型 |
| P3：课程生成与一致性 | 大；course-service/业务锁/journal/快照，迁移桌面所有相关写入口，再启用 generate-document/synthesize-course/publish-translation | 两端同 revision 竞争只一方成功；409 不覆盖；故障注入后旧版本完整；无私密内容外发；用户节点/笔记保留；新单 PDF 和课程成果可按来源跳页；备份恢复演练通过 | 停生成接口，保留读和答疑；先停写、恢复数据再回退程序 |
| P4：移动与弱网优化 | 中；Range+URL PDF 加载、渐进尺寸/回收、选段/抽屉/键盘/进度；薄客户端 transport 复用 | 第 5.6 节实机矩阵通过；内存不随访问过的全部页面持续增长；PDF 首屏无需等待全量尺寸；断线无重复任务 | 回退具体 UI 优化并保留接口；大文档不达标如实提示限制，不标记“移动端完成” |
| P5：无人值守常驻（按需） | 大；B 服务核心装配成 D、Node PDF/Canvas adapter、构建/部署 unit、单写者及桌面连接模式 | 无图形登录的冷启动、异常杀进程重启、interrupted 任务不误重跑、日志无 secrets、主机重启重新登录、桌面/远程共用同目录无丢更新 | 停 Node 并释放独占锁，再启动兼容桌面服务；不双开写入 |
| P6：可选远程管理 | 中到大，依据用户选定功能；第 5.4 节 manage 接口及界面 | PDF 导入只进本人主机；超限/伪 PDF 拒绝；删除可回收；版本恢复经过冲突检查；权限关闭时接口拒绝 | 关闭 manage，不影响已有翻译/答疑/生成 |

后续测试落点：扩展 `demo/tests/lan-share.test.ts`（保留原只读拒写断言），新增 `remote-auth.test.ts`、`remote-jobs.test.ts`、`remote-ai.test.ts`、`course-service.test.ts`、`remote-service-lifecycle.test.ts`；扩展 `shared-viewer-regression.test.ts`、`shared-translation.test.ts` 与相关存储测试。模拟模型响应与临时工作区，不使用真实课程/付费 API。Range 与 CSRF/代理信任、成本预留重启、取消和并发冲突需测试真实行为，不能仅断言源码包含字符串。

代码实施阶段按实际模块跑 `pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`、生产 Web/Electron 编译；涉及壳/后台 worker 跑 `pnpm desktop:test` 并区分 DISPLAY 缺失的跳过；涉及打包实际验证相应产物。服务端新增后另做无显示环境启动测试。手机、tailnet 与本地模型质量单列实机记录，不能拿单测通过替代。

推荐 B 的原因是主机已有 Electron/Node 和 Tailscale，可以先验证安全入口与真正的主机 AI，把付出集中在当前缺失的业务接口。A 不能实现 AI；C 增加证书管理且没有减少业务工作；E 暴露整个桌面且手机体验弱；D 解决真实常驻需求但增加 DOM/PDF 运行时迁移，不应只因“架构更先进”提前做。若用户把无人登录运行列为首期硬要求，应明确选 D 并接受工作量，不能以 B 的托盘驻留冒充。

## 7. 主要风险与停止条件

| 风险 | 预防/检测 | 停止或降级条件 |
| --- | --- | --- |
| 误把 0.0.0.0 当 LAN 专用 | 显式回环/指定 IP；检查实际监听和非 tailnet 访问；旧 LAN 实例不注册 remote API | 发现业务接口可绕过预期入口立即停 remote |
| AI 外发违反硬约束 | 本地 endpoint 白名单、禁止重定向/搜索/外图、模拟外部目标拒绝测试，审计本地模型出口 | 本地模型不可用时禁用相关 AI，不偷偷用已有云设置 |
| 本地推理性能/质量不够 | P0 真实硬件与非敏感夹具测量；分开验证文字、视觉/OCR、结构化生成 | 未达标能力不开放，工作量估算不包含保证硬件升级有效 |
| 两端写入丢更新或多文件半提交 | 单写者、课程锁、提交前校验、staging/journal、备份和故障注入 | 协调器未覆盖所有桌面写入口前不得开放远程生成 |
| 会话/设备失窃导致私密资料和资源滥用 | tailnet 精确授权、Secure Cookie、CSRF、配额、一键撤销、设备移除 | 设备遗失先撤销 tailnet 访问与应用会话；不靠只改 URL |
| 双击/重连/自动重试造成重复推理 | 幂等记录、预算预留、失败状态保留、job 查询/订阅分离 | 不确定是否已执行时显示 interrupted/待确认，不自动再跑 |
| Electron/显示会话/密钥链依赖 | B 明确保持运行；D 单独无头运行时及凭据方案 | 无桌面自启未实测前不承诺常驻 |
| 大 PDF 和多次渲染耗尽手机/主机 | Range、并发上限、渐进尺寸、Canvas/worker销毁、模型资源隔离 | 超出实测资源上限拒绝任务并可继续读小文件 |
| 证书/DNS/Serve 映射失效 | health 分层区分 Tailscale、TLS、应用、模型；记录具体 externalOrigin | 不退回公网或无认证 HTTP；在本机修复入口 |
| 日志/Markdown/浏览器缓存泄漏 | 日志无正文与凭据、禁止外图、CSP、私有状态目录、默认不离线缓存 | 无法确认脱敏的错误只返回固定错误码 |

## 8. 必须由用户决定的问题

以下是后续实施的输入；本文档没有替用户启用任何选项。建议逐条按编号回答。

1. **访问范围：** 是否只允许本人指定的 Tailscale 设备？是否同意在家也使用同一 HTTPS 入口，关闭旧 LAN HTTP；如需保留 LAN，它是否始终只读？（推荐：只限本人设备，关闭旧入口。）
2. **资料隐私的精确定义：** 是否连页面文字、图像、摘要和搜索词也禁止发第三方？本方案默认“全部禁止”，同时允许现有 Tailscale 的加密传输/可能的密文中继。若仅禁止上传 PDF 文件而允许供应商处理内容，请明确说明，这是另一个隐私范围，不自动生效。
3. **远程 AI 权限：** 是否允许浏览器发起页面/选段翻译、视觉/整篇答疑、OCR？在本地模型慢或质量不足时，是否接受先只开放通过验证的能力？
4. **模型资源与容忍度：** 小主机的 CPU、内存、GPU/显存是什么；可接受单页问答/翻译、整份知识库生成等多久；是否只用现有硬件？（不要求为方案购买云服务。）
5. **HTTPS 选择：** 是否接受 Serve 的自动可信证书，以及设备完整域名进入公开证书透明日志？若不接受，是否愿意在每台电脑/手机安装并维护私有 CA？（推荐：Serve，不长期点击忽略自签警告。）
6. **“完整”是否包含改资料：** 是否允许生成/重新生成成果和并入课程；创建、导入、删除、编辑笔记/节点、恢复历史分别需要哪些？（推荐先 generate，manage 默认关闭；主机配置/Key 只在本机管理。）
7. **常驻要求：** 初期是否接受保持 Electron 和图形会话运行？还是首期就必须冷启动后无人登录、关闭桌面窗口仍可用？这决定先 B 还是前置 D。
8. **资源/费用和断线行为：** 每日任务数/token/推理时长上限如何设；是否接受并发 1、批任务排队、断网继续、主动退出取消、重启任务需手工恢复？严格本地模式第三方费用上限固定 0。
9. **主要客户端与记录：** 主要是电脑、Android 还是 iPhone；最低要支持什么设备/浏览器；是否接受对话和阅读进度保存在主机供各设备共用？需要保留多久？
10. **备份与写入交接：** 启用远程生成前，本地备份放哪里、保留多久；是否接受常驻模式下桌面也统一连接主机服务、旧版本桌面不同时写同一目录？

## 9. 本轮交付与验证边界

本轮只提交 `docs/REMOTE-ACCESS-OPTIONS.md`，遵循本次明确的“不要改代码、不要动测试”要求；不新增/更新测试文件，不 push。文档校验包括引用文件/行号存在、相对链接可解析、必要章节齐全、git 差异仅该文件及空白检查；运行现有根目录文档测试不改变测试内容。上述测试不会验证本方案尚未实现的能力。

实际验证：`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover tests`，16/16 通过；65 个本地文件引用及起始行号检查通过，9 个主要章节齐全、代码围栏成对。未运行应用构建或整套运行时测试，因为本轮没有实现变更。

没有运行或宣称通过 Tailscale 外网连接、证书签发、真实手机、主机模型推理、真实工作区备份或并发故障验收。现有代码证据与后续设计分列，部署命令和 unit 均未应用。将来若实现改变现有 LAN 的产品边界，需同步更新 LAN 说明、README/HANDOFF 和相关测试；本轮按约束保留这些文件不动。
