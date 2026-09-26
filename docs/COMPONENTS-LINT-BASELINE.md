# Components lint 存量诊断记录

日期：2026-09-26。首次把 `demo/components` 加入 `pnpm lint` 时，72 个组件文件暴露 36 条存量诊断（原配置均为 error）。运行 `pnpm exec oxlint components --fix --format json` 后没有文件发生改动，36 条诊断均无安全自动修复。未使用可能改变行为的 `--fix-suggestions` 或 `--fix-dangerously`。

本轮保留这些诊断为可见 warning：`.oxlintrc.json` 只对下表涉及的具体文件/规则组合设置 `warn`，不忽略文件、不关闭规则、不降低整个 components 目录的检查级别。相同规则在新文件仍为 error，已有文件中的其他错误仍会阻断 lint。此策略按文件/规则限定，不是逐行豁免；同一文件同一规则的后续问题也会成为告警，需在后续维护时审查并逐项收紧。

当前分类：可访问性 23 条、React Hooks/Compiler 9 条、类型规则 4 条，共 36 条。共享相关文件只纳入检查与清单，未修改实现。

| 规则 | 数量 | 暂缓原因 |
| --- | ---: | --- |
| `jsx-a11y(anchor-has-content)` | 1 | 分页链接通过 props 接收内容，需检查调用处与最终可访问名称。 |
| `jsx-a11y(click-events-have-key-events)` | 1 | InputGroup 附件存在点击聚焦行为，需与键盘操作一起审查。 |
| `jsx-a11y(label-has-associated-control)` | 5 | 含可复用 Label 与自定义输入组件，需逐处确认实际 DOM 的标签关联。 |
| `jsx-a11y(no-autofocus)` | 3 | 移除自动聚焦会改变现有弹窗/登录交互，需先确认键盘焦点策略。 |
| `jsx-a11y(no-noninteractive-element-interactions)` | 1 | 同一 InputGroup 附件的交互角色问题，需与键盘访问一并处理。 |
| `jsx-a11y(prefer-tag-over-role)` | 12 | 语义标签替换可能改变分组、焦点、原生 dialog 或组件布局；需结合调用处与辅助技术验收。 |
| `react(react-compiler)` | 7 | 涉及 effect 内状态同步、现有规则抑制和 memo 依赖推断；避免为 lint 重排状态生命周期。 |
| `react-hooks(exhaustive-deps)` | 2 | 两个启动 effect 的桌面 API 依赖；修改依赖可能触发重复初始化，需要专门的生命周期回归。 |
| `typescript(no-deprecated)` | 1 | 共享查看端的 FormEvent 类型弃用；属于类型维护，本轮不修改共享模块。 |
| `typescript(restrict-template-expressions)` | 3 | Chart 的动态键/ReactNode 插值；需定义允许的值类型与输出语义后处理。 |

具体位置（行号为本轮完成时的版本）：

- `jsx-a11y(anchor-has-content)`：`demo/components/ui/pagination.tsx:58`。
- `jsx-a11y(click-events-have-key-events)`：`demo/components/ui/input-group.tsx:52`。
- `jsx-a11y(label-has-associated-control)`：`demo/components/course-library.tsx:1545,1558,1618`；`demo/components/shared-course-viewer.tsx:495`；`demo/components/ui/label.tsx:9`。
- `jsx-a11y(no-autofocus)`：`demo/components/course-library.tsx:1555,1626`；`demo/components/shared-course-viewer.tsx:504`。
- `jsx-a11y(no-noninteractive-element-interactions)`：`demo/components/ui/input-group.tsx:52`。
- `jsx-a11y(prefer-tag-over-role)`：`demo/components/course-library.tsx:1164`；`demo/components/selection-toolbar.tsx:122`；`demo/components/ui/breadcrumb.tsx:66`；`demo/components/ui/button-group.tsx:32`；`demo/components/ui/carousel.tsx:124,161`；`demo/components/ui/field.tsx:79`；`demo/components/ui/input-group.tsx:15,53`；`demo/components/ui/input-otp.tsx:78`；`demo/components/ui/item.tsx:12`；`demo/components/ui/spinner.tsx:8`。
- `react(react-compiler)`：`demo/components/course-library.tsx:895,900`；`demo/components/shared-course-viewer.tsx:395`；`demo/components/shared-pdf-reader.tsx:199,239,387`；`demo/components/ui/carousel.tsx:98`。
- `react-hooks(exhaustive-deps)`：`demo/components/course-library.tsx:193,288`。
- `typescript(no-deprecated)`：`demo/components/shared-course-viewer.tsx:440`。
- `typescript(restrict-template-expressions)`：`demo/components/ui/chart.tsx:155,203,302`。

验证与后续验收：

- `tests/lint-scope.test.ts` 在临时目录执行正式 lint 脚本的范围和配置，验证新组件的相同规则仍报错、存量文件中的无关错误仍阻断、仅存量告警时退出码为 0 且告警保持可见。
- 测试脚本显式设置 `--test-concurrency=1`，且参数位于文件通配符前；测试覆盖该约束，避免多个浏览器/构建测试同时抢占内存。
- 后续处理可访问性告警时，需要键盘操作、屏幕阅读器、焦点和布局验收；处理 React 告警时，需要初始化、切换文档和渲染状态回归。逐项修复后删除对应 warning 覆盖。
