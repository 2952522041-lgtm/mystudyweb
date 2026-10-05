import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { installationDigest, updateLauncher } from './desktop-update-utils.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => !['--dry-run', '--check'].includes(arg)))
  throw new Error('仅支持 --dry-run 或 --check。');
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('此更新命令用于 Linux x64；其他平台请使用对应安装包。');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const deb = path.join(
  root,
  'out',
  'make',
  'deb',
  'x64',
  `yeyu_${pkg.version}_amd64.deb`,
);
const launchers = [
  path.join(homedir(), '.local/bin/yeyu'),
  path.join(homedir(), '.local/share/applications/yeyu.desktop'),
];
const command = (exe, argv) => {
  const result = spawnSync(exe, argv, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw new Error(`${exe} 执行失败，更新已停止。`);
};
if (args.includes('--dry-run')) {
  console.log(
    `退出页语 → pnpm desktop:make → sudo apt install --reinstall ${deb} → 备份并修正旧启动入口 → 校验安装内容。`,
  );
} else {
  if (!args.includes('--check')) {
    const running = spawnSync('pgrep', ['-x', 'yeyu']);
    if (running.status === 0)
      throw new Error('请先正常退出页语，保存内容并停止本次运行，再执行更新。');
    command('pnpm', ['desktop:make']);
    await stat(deb);
    command('sudo', ['apt', 'install', '--reinstall', deb]);
    for (const file of launchers) {
      let before;
      try {
        before = await readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const after = updateLauncher(before, homedir());
      if (before === after) continue;
      const suffix = `${Date.now()}-${process.pid}`;
      await copyFile(file, `${file}.bak-${suffix}`);
      const mode = (await stat(file)).mode & 0o777;
      await writeFile(`${file}.tmp-${suffix}`, after, { mode });
      await rename(`${file}.tmp-${suffix}`, file);
    }
  }
  const expected = await installationDigest(
    path.join(root, 'out/Yeyu-linux-x64/resources'),
  );
  const actual = await installationDigest('/usr/lib/yeyu/resources');
  if (actual !== expected)
    throw new Error('已安装文件与本次构建不一致，请重新执行更新。');
  for (const file of launchers) {
    const text = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (updateLauncher(text, homedir()) !== text)
      throw new Error(`启动入口仍指向旧版本：${file}`);
  }
  console.log(
    '页语桌面安装内容与构建一致（包含前端与主进程）。重新打开后可在课程页核对构建版本。',
  );
}
