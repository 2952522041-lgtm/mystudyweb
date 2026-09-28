// Opt-in, separately installed official runtime. Never run package lifecycle scripts.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { copyFile, chmod } from 'node:fs/promises';
if (Number(process.versions.node.split('.')[0]) < 22)
  throw new Error('DSH requires Node.js 22 or later.');
const root = path.join(
  homedir(),
  '.local',
  'opt',
  'yeyu-dsh-runtime-0.1.7-rc.2',
);
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  [
    'install',
    '--prefix',
    root,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    '@deepseek-ai/dsh@0.1.7-rc.2',
    '@deepseek-ai/dsh-sdk-client@0.1.7-rc.2',
  ],
  { stdio: 'inherit', shell: false },
);
if (result.error || result.status !== 0) process.exitCode = 1;
else {
  // A desktop shortcut does not inherit nvm's PATH. Pin the installer Node too.
  const executable = path.join(
    root,
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  console.log(`DSH runtime installed at ${root}`);
}
