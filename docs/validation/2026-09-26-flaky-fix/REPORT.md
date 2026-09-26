「页语」flaky 回归修复验证记录（2026-09-26）

本次确认并修复了两个不同根因：共享阅读器测试在原生输入之后、React 提交之前断言；渐进阅读产品在尺寸发布和提交之间提前清除滚动锚点。没有增加共享或远程功能。

**基线与复现**

开工核对 `git log --oneline -3`、`git status`：`master@799e1e4`，工作区干净。`cd demo && xvfb-run -a pnpm test`：359 通过，0 失败，0 跳过，TAP 耗时 32.924 秒。

压力采用 CPU 竞争：通过 `os.sched_setaffinity(0, [0, 1])` 将测试及其子进程限制在两个核心，另启动两个同样继承亲和性的 `yes > /dev/null`。保留 `--test-concurrency=1`，不并行跑完整套件。这能放大主进程、渲染进程和 React 的调度时间窗，且负载进程几乎不额外消耗内存。每组结束用 `finally` 逐一 terminate/wait 清理占用进程。

共享阅读器原代码在负载第 2 轮复现。共完成 4 轮，1 轮失败（74.936 秒）；拿到样本后中断正在进行的第 5 轮，该轮不计入通过或失败。原始日志 `before-load-002.log` 保留完整事件和布局诊断。失败消息中的标签状态为 `PDF 脑图:false`，内容仍是翻译；同一次错误处理随后采集的诊断却已经是 `PDF 脑图 selected=true`、脑图内容可见。原生 pointerdown/up/click 全部命中脑图，click 时间为渲染器时钟 1165.6ms，三个标签中心命中检查也均为 true。

这排除了该样本中的坐标点错和活动标签持续被重置。产品代码另外核查了 `demo/components/shared-pdf-reader.tsx:377` 的受控 panel 状态、`:426` 的 ResizeObserver，以及 `:720`、`:804` 的宽窄面板：两个面板共用 panel，只有标签 onValueChange 调用 setPanel，resize 只更新尺寸，不重置 panel。缓存旧坐标虽不是本次样本直接根因，仍是独立的脆弱假设，已一起移除。

渐进阅读原测试在相同负载下 20 轮失败 4 轮（76.342 秒），均为 `estimated jump mispositioned`。延后观察的诊断版 10 轮失败 3 轮，带锚点追踪版 10 轮失败 1 轮。`progressive-trace-008.log` 显示目标页 top=193.234375、阅读区 top=123，相差 70.234375 像素，1 秒后仍完全相同，证明不是临时未完成渲染。

该样本的产品事件序列：818.9/819.2ms 发布第 15/3 页尺寸并保存 `{page:15,fraction:0}`；823.9ms 导航 rAF 按旧布局滚动后把锚点清空；尺寸随后提交但没有锚点可恢复；882ms 下一次尺寸发布把错误位置捕获为 `{page:14,fraction:0.765743...}`，后续布局便保留了错误位置。

**修复与确定性回归**

`demo/tests/shared-viewer-regression.test.ts:1084` 在每一次原生点击前重新查找可见、可用的控件，测量实际传入 Electron 的整数坐标并验证 elementFromPoint 身份；捕获事件后再次检查实际点击目标。输入只发送一次，没有点击重试。

`:1194` 等待脑图标签 `aria-selected=true` 且对应脑图内容实际可见，再执行原断言。原生输入入队不再被当作 React 提交屏障。`:1167` 的刷新检查要求服务端新响应版本出现在可见内容里，避免把点击前的旧译文当作刷新完成；移除了 resize 后固定 100ms 等待。

`:1273` 的并发握手先启动脑图断言，再放行唯一一次原生点击；新增测试（`:1617`）明确验证检查确实先于输入送达启动。反向验证仅删除新增 UI 等待后，正式流程和引用同一流程的新断言都失败（`mutation.log`：6 通过、2 失败），保留修复时 8/8 通过。两个失败来自同一次浏览器流程，并非两个独立 flaky。

`demo/app/page.tsx:753` 增加待提交尺寸快照引用；`:1198` 在发布尺寸时记录快照；`:960` 导航帧在存在待提交尺寸时保留锚点；`:898` 布局提交完成恢复后，只有确认最新快照已经提交才清空它。旧布局提交或提前执行的动画帧均不能再丢弃新尺寸对应的阅读锚点，修复针对的是发布—提交之间的生命周期，而不是延长等待。

`demo/tests/reader-progressive-browser.test.ts:42` 更新现有浏览器回归：固定第 3 页尺寸发布发生在导航帧之前、提交发生在导航帧之后，暂时阻塞其他页尺寸，防止其他更新偶然补偿锚点。测试中的构建插桩只拦截 setPageSizes 的调度，且断言必须恰好命中一个发布位置；生产代码没有测试开关。测试样式关闭 Chromium 自动滚动锚定，让阅读器自己的恢复行为独立接受检验。旧产品代码在该场景稳定失败（`progressive-mutation-confirmed.log`：1 失败，等待定位超时），修复后通过。

渐进阅读原先固定的 100/700/80ms 等待替换为目标位置、全部页面实际尺寸以及 AI 输入区可见的条件。像素容差仍为 <3，页面跟踪、虚拟化和短窗口控件可见性断言均保留。没有加长超时、重试动作、跳过失败或吞异常。

**最终连续验证**

下表耗时是逐轮外层命令实测 wall time 之和，包含 Xvfb、进程启动和构建；与上述基线 TAP 时长口径略有不同。每轮均为独立 Node 测试进程，共享阅读器每轮重新执行正式构建和浏览器流程。所有组串行执行，被测代码固定为 `c84e3f5`。

| 验证组 | 完整运行次数 | 失败轮数 | 每轮通过测试数 | 总耗时 |
|---|---:|---:|---:|---:|
| 共享阅读器：正常条件 | 50 | 0 | 8 | 484.413 秒 |
| 共享阅读器：两核心 + 两个 CPU 负载进程 | 50 | 0 | 8 | 934.033 秒 |
| 完整套件：串行 | 5 | 0 | 360 | 156.137 秒 |
| 渐进阅读：确定性回归，负载 | 50 | 0 | 1 | 165.366 秒 |
| 渐进阅读：原测试 / 原样式，负载 | 20 | 0 | 1 | 79.553 秒 |

完整套件每轮均为 360 通过 / 0 失败 / 0 跳过；新增的共享浏览器断言使总数从 359 增至 360。`pnpm lint` 退出 0，0 错误、34 条现有警告；`pnpm exec tsc --noEmit` 退出 0、0 诊断。最后再次确认 CPU 负载进程全部退出，工作区已提交干净。

**可复核命令与材料**

在仓库根目录创建 `/tmp/yeyu-flake-evidence`，解压本目录 `evidence.tar.gz` 到该目录，即可查看所有逐轮日志、JSON 计数及实际使用的 `run.py`。其中 runner 的仓库路径为本任务的 `/home/yusicheng/project/learning_app/demo`。

```bash
mkdir -p /tmp/yeyu-flake-evidence
tar -xzf docs/validation/2026-09-26-flaky-fix/evidence.tar.gz -C /tmp/yeyu-flake-evidence
python /tmp/yeyu-flake-evidence/run.py reproduce-normal 50 normal
python /tmp/yeyu-flake-evidence/run.py reproduce-load 50 load
python /tmp/yeyu-flake-evidence/run.py reproduce-suite 5 suite
```

单文件每轮实际命令（cwd=demo）：

```bash
xvfb-run -a pnpm exec node --test --test-concurrency=1 --experimental-strip-types tests/shared-viewer-regression.test.ts
```

完整套件每轮和交付检查实际命令（cwd=demo）：

```bash
xvfb-run -a pnpm test
pnpm lint
pnpm exec tsc --noEmit
```

runner 的 JSON 分别保留每轮 exit code 和耗时；失败不会被删除或算作成功，统计使用各子命令真实退出码。`failure-samples.json` 提取了两类失败的完整诊断。`summary.json` 保留最终各组统计。日志归档也包含定位阶段和测试开发阶段日志，不能把预期的反向验证失败计入修复后连续通过的组。

**其它失败与限制**

除了两个已确认问题，开发测试时还出现过一次 `short window clipped the AI composer`：最初把固定延时换成“元素存在”仍会读到隐藏面板中的输入框，已改为等待真正可见，原可视区域断言保留。早期渐进阅读闸门也曾因其他尺寸发布补偿而让旧代码通过，最终增加明确的第 3 页发布和其他页闸门后才完成红绿验证。这些探索日志均保留。最终连续验证中未发现其它 flaky。

自动验证环境为 Linux + Xvfb + Electron。人工尚未验证 Windows/macOS 以及真实大 PDF 的高 DPI、快速连续跳页体验；建议发布前按现有阅读器验收流程检查。这不影响本次两条已捕获竞态的自动回归结论。

本地实现提交：`803cd3a test: synchronize narrow viewer clicks with committed UI state`；`c84e3f5 fix: retain reading anchors until pending page dimensions commit`。验证材料另作本地提交，hash 随交付消息提供。全程未 push。
