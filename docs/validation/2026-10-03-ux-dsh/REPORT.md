# 用户体验与 DSH 完善：保存进度

保存日期：2026-10-03。本轮开发与验证跨 2026-10-02 至 2026-10-03；按用户要求完成收尾后停止扩展功能。

## 已完成

- 全局后台任务中心：查看进度、暂停、继续、取消、重试及批量操作；保留 PDF 和已完成成果。桌面后台由独立隐藏窗口执行，主界面重载不影响任务，后台异常最多自动重建 3 次。
- 课程并发保护：保存使用短事务锁，AI 请求在锁外；拒绝过时成果。删除先提交课程清单再清理文件，避免中断后清单仍引用已删除 PDF；补齐迟到译文与删除的竞态保护。
- DSH 设置与运行：本机运行时自检、模型能力校验、显式连接测试、交互请求保留并发槽、后台与预取优先级、分类错误及排队/执行诊断。CLI 等待流程识别暂停和取消，不误报完成。
- 阅读与课程体验：恢复页码、页内位置、缩放、右栏与分栏宽度；保留聊天草稿，修复中文输入法发送与滚动跟随；继续阅读、搜索排序、来源追问、笔记编辑与摘记、历史只读预览和结构差异。
- DSH CLI 执行者试跑：在独立临时任务目录生成耗时显示、任务计数两个纯函数及测试；主 Agent 审阅并独立验证 9 项测试后集成。清理试跑的临时认证副本。
- 个人与项目两处 Luna 技能均替换为 `dsh-assisted-development`，同步开发指引。技能提交：`688f33c`。两份技能均通过 `quick_validate.py`；独立场景评估后明确正常执行权限申请的边界。

## 验证结果

以下结果均来自实际执行，无跳过；各组可能有覆盖重叠，不能相加作为独立用例总数。

| 检查 | 结果 |
| --- | --- |
| `cd demo && node --test --test-concurrency=1 --experimental-strip-types tests/*.test.ts` | 715 通过，0 失败，0 跳过 |
| `python3 -m unittest discover -s tests` | 16 通过 |
| `cd demo && pnpm exec tsc --noEmit` | 通过 |
| `cd demo && pnpm lint` | 退出码 0；0 错误、40 条警告 |
| `cd demo && pnpm desktop:build` | Linux x64 静态页面、Electron/MCP 编译与桌面打包通过 |
| `cd demo && node --test --test-concurrency=1 --experimental-strip-types tests/electron-workspace.test.ts tests/electron-smoke.smoke.ts` | 19 通过；包含编译版、打包版及真实后台窗口重载/崩溃恢复 |
| `cd demo && node --test --test-concurrency=1 --experimental-strip-types tests/dsh-runtime.smoke.ts` | 已安装运行时的 4 项离线配置与 SDK 握手通过，使用假密钥，未请求模型 |
| `git diff --check` | 通过 |

真实 Chromium 回归包含任务控制、扫描失败后的不可用状态与恢复、卸载后的迟到事件、旧初始快照不能覆盖实时快照、阅读恢复、草稿、输入法、滚动跟随及课程导入。

## 交付边界与后续入口

- 本轮生成的桌面包位于 `demo/out/Yeyu-linux-x64/`；没有安装到用户现有应用，没有发布或推送远程。
- 没有进行本轮真实 PDF 的在线模型质量、费用或延迟评估；离线握手不能证明在线服务可用。
- 历史功能只提供预览与差异，不提供完整课程备份恢复；退出应用后后台停止，下一次启动恢复未完成阶段。
- Windows 构建和实机验证未执行；40 条 lint 警告仍待后续清理。
- 后续工作从 [待优化清单](../../OPEN-OPTIMIZATION-BACKLOG.md)、[DSH 接入说明](../../DSH-INTEGRATION.md) 和 [后台任务验收](../../BACKGROUND-IMPORT-ACCEPTANCE.md) 接续。用户未要求继续新功能时，不自动扩大范围。
