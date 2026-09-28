# Linux 桌面启动与沙箱验证

## 2026-09-28 故障

GNOME 启动新版页语时立即退出。用户日志明确报告 `setuid_sandbox_host.cc` 权限错误：用户目录中的 `chrome-sandbox` 为当前用户所有，权限 0755，不是系统正确安装的 root-owned 4755 辅助程序。

开发终端继承了 `chatgpt (unconfined)` AppArmor 上下文；桌面会话为 `unconfined`，且机器启用了 `apparmor_restrict_unprivileged_userns=1`。因此终端启动成功不足以证明 GNOME 快捷方式启动成功。

## 本机修复

没有新增 setuid 程序、改变系统安全策略、关闭沙箱或修改课程配置。系统已经安装的 `/usr/lib/yeyu/chrome-sandbox` 是 root:root、4755，其父目录由 root 控制，并且与本次构建携带的 helper 字节完全一致：

```text
a4f6dfd7325ddd55f94ddc0c487d22726d40ef099ded6475d5dffe236e277896
```

将本地安装目录的原 helper 保留为 `chrome-sandbox.bundled`，原位置改成指向上述已安装 helper 的符号链接。桌面快捷方式和程序主体不变，继续运行 `yeyu-20260928-background-import` 新版。只是复用同版本已正确安装的沙箱辅助程序，不会启动旧版页语主体。

此修复依赖系统 helper 保持安装。以后更换 Electron 版本、升级/卸载系统包时，必须重新核对 helper 哈希及权限；不应盲目复用其他应用的 helper。普通用户可写目录中不能随意创建新的 root-owned setuid 副本。正常发布仍优先使用 DEB 安装流程。

## 验证要求

1. 使用 `demo/scripts/check-linux-sandbox.mjs` 只读检查 helper 的真实路径、owner、权限、父目录及与构建产物的哈希匹配情况。
2. 停止待替换的空闲测试实例前确认没有导入和后台 AI 任务，不强制中断用户工作。
3. 从用户桌面服务管理器启动 `.desktop` 文件，确保不是继承开发终端的 AppArmor 上下文；不要只唤醒已经运行的单实例来冒充冷启动测试。
4. 核对 MCP 课程列表正常、没有新 fatal 启动日志，并读取渲染进程 `/proc/<pid>/status` 确认隔离状态。

本机只读检查命令（传原件与实际 helper，不能把本地符号链接冒充 root-owned 原件）：

```bash
node demo/scripts/check-linux-sandbox.mjs \
  /home/yusicheng/.local/opt/yeyu-20260928-background-import/chrome-sandbox.bundled \
  /usr/lib/yeyu/chrome-sandbox
```

本次在桌面会话通过 `gio launch` 冷启动后，主进程安全上下文为 `unconfined`，MCP 成功读取原有 7 门课程，课程库 loading=false。渲染进程显示独立 PID 命名空间、`NoNewPrivs: 1` 和 `Seccomp: 2`，没有关闭沙箱。修复前后 7 门课程的 `course.json` 和课程笔记 SHA-256 完全一致。

验证使用的 `yeyu-desktop-verify.service` 是一次性临时服务，不是定时任务，不会在开机时重启；应用退出后由 systemd 自动回收。

Luna 实现的只读检查器经主 Agent 审查，在本机正确 helper 上通过、在原错误 owner 的副本上明确拒绝。新增 10 项测试，全套 538 项测试通过，无跳过；TypeScript 与 lint 检查通过（项目保留既有 lint 警告）。

## 参考

- [Electron 进程沙箱](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Chromium setuid helper 选择与权限检查源码](https://github.com/chromium/chromium/blob/main/sandbox/linux/suid/client/setuid_sandbox_host.cc)
