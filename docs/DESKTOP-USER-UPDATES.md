# 桌面免密码更新

从0.2.2开始，`pnpm desktop:update`默认构建并安装到当前用户目录。它不写`/usr/lib`，不调用sudo，不保存密码，不启动网络更新服务。Codex或本地工具以后可直接调用该接口完成更新。

```sh
cd /home/yusicheng/project/learning_app/demo
pnpm desktop:update
pnpm desktop:update --check
pnpm desktop:update --rollback
```

运行中的页语继续使用原来的完整release；更新程序不关闭窗口、不取消后台任务。完成后正常退出再从应用菜单或`~/.local/bin/yeyu`打开，才运行新版本。`--check`检查当前选中的用户安装，并不声称已运行的旧进程已经升级。

## 自动化接口

直接用Node调用可以让stdout只包含一个JSON结果；构建日志进入stderr，错误退出码为1：

```sh
node scripts/update-desktop.mjs --json
node scripts/update-desktop.mjs --skip-build --json
node scripts/update-desktop.mjs --check --json
node scripts/update-desktop.mjs --rollback --json
node scripts/update-desktop.mjs --dry-run --json
```

`--skip-build`安装`out/Yeyu-linux-x64`，会检查包版本与当前项目版本一致；返回实际构建commit，调用者应核对它是不是所需代码。`--check`验证当前选中release，即使刚回滚到旧版也能通过。`--dry-run`不写用户文件。成功状态为`installed`、`unchanged`、`verified`或`rolled-back`，安装/回滚结果带`requiresRestart: true`。错误JSON有`ok: false`、`code`和`error`。

程序调用可从`demo/scripts/user-desktop-update.mjs`导入：

```js
import {installUserDesktop, checkUserDesktop, rollbackUserDesktop} from './scripts/user-desktop-update.mjs';
await installUserDesktop({home, source: packagedDirectory, icon: iconFile, expectedVersion: '0.2.2'});
await checkUserDesktop({home});
await rollbackUserDesktop({home});
```

这是同一用户权限下的本地API，输入是已在本机构建的完整目录，不接收远程URL、上传文件或任意命令。应用共享网页不开放更新权限。

## 安装与故障恢复

- 完整程序在`~/.local/opt/yeyu/releases/<版本-内容标识>`；暂存副本核对全部文件字节、执行位后才能发布。同版本不同构建使用不同目录，发布后不原地覆盖。
- `active`单个软链接指向一次激活记录，里面同时记录当前和上一个release。切换失败会尝试恢复旧入口及两个launcher，原入口备份留在激活记录目录。恢复本身失败会明确报错，不报成功。
- shell入口在启动时解析实际release路径；桌面入口经固定`/bin/sh`执行该脚本。固定保留原profile `~/.config/页语`及`--ozone-platform=x11 --disable-gpu`，不使用`--no-sandbox`。
- `--rollback`交换当前和上一个用户release，可再次执行切回。首次从系统版迁入时没有上一个用户release，命令会明确拒绝；原系统安装仍可通过`/usr/bin/yeyu`运行。回滚仅涉及程序，不恢复或迁移课程、配置及数据库。
- 构建、复制、安装、回滚共用`.update-lock`，并发调用会失败。进程异常退出可能留下锁；先确认锁中PID已结束且没有更新任务，再删除该锁文件。不会自动清理旧release，避免删除仍运行中的版本。
- 用户层`yeyu.desktop`会覆盖同名系统菜单入口；`~/.local/bin/yeyu`为用户命令入口。课程、设置、认证、独立DSH runtime以及原系统DEB不搬迁、不覆盖。

## 本机沙箱前提

Ubuntu桌面可能限制普通用户命名空间，单纯复制Electron程序不能保证冷启动。更新器使用现有只读`verifySandboxHelper`检查系统`/usr/lib/yeyu/chrome-sandbox`：root拥有、4755、父路径符合要求，且字节与新包helper完全一致后，才在release建立链接。新包原helper保留为`chrome-sandbox.bundled`。

这是复用已安装的系统运行基础，不是永久绕过系统安装权限。首次安装或未来Electron升级时若helper不匹配，需要通过系统DEB安装更新；当下普通应用代码更新不再重复要求sudo密码。详见[沙箱验证记录](LINUX-DESKTOP-SANDBOX.md)。
