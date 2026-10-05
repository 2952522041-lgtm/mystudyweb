import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { checkUserDesktop, installUserDesktop, rollbackUserDesktop, userDesktopPaths } from './user-desktop-update.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
function build() {
  return new Promise((resolve, reject) => {
    // Build output never contaminates the machine-readable stdout response.
    const child = spawn('pnpm', ['desktop:build'], { cwd: root, stdio: ['inherit', 2, 2] });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`桌面构建失败（${code}），原版本未切换。`)));
  });
}
try {
  if (args.some(arg => !['--dry-run', '--check', '--skip-build', '--rollback', '--json'].includes(arg)) || new Set(args).size !== args.length) throw new Error('支持 --dry-run、--check、--skip-build、--rollback、--json。');
  if (args.includes('--check') && (args.includes('--rollback') || args.includes('--skip-build')) || args.includes('--rollback') && args.includes('--skip-build')) throw new Error('--check、--rollback、--skip-build 不能混用。');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('此更新接口用于 Linux x64。');
  const home = homedir();
  let report;
  if (args.includes('--dry-run')) {
    report = { ok: true, status: 'planned', action: args.includes('--rollback') ? 'rollback' : args.includes('--check') ? 'check' : 'install', builds: !args.some(arg => ['--check', '--rollback', '--skip-build'].includes(arg)), directory: userDesktopPaths(home).base, sudo: false };
  } else if (args.includes('--check')) report = await checkUserDesktop({ home });
  else if (args.includes('--rollback')) report = await rollbackUserDesktop({ home });
  else {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    report = await installUserDesktop({ home, source: path.join(root, 'out/Yeyu-linux-x64'), icon: path.join(root, 'assets/icons/png/yeyu-256.png'), expectedVersion: pkg.version, prepare: args.includes('--skip-build') ? undefined : build });
  }
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else if (report.status === 'planned') console.log(`操作：${report.action}；${report.builds ? '先构建 → ' : ''}用户目录 ${report.directory}；完整校验及沙箱检查，无需 sudo。`);
  else console.log(`页语 ${report.version}：${report.status}。${report.requiresRestart ? '下次正常退出并重新打开后生效，当前任务可继续。' : '用户安装、启动入口和沙箱校验通过。'}\n${report.directory}`);
} catch (error) {
  const report = { ok: false, code: error.code ?? 'UPDATE_FAILED', error: error.message };
  (json ? process.stdout : process.stderr).write(`${json ? JSON.stringify(report) : report.error}\n`);
  process.exitCode = 1;
}
