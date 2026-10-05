/**
 * Electron 桌面壳的确定性编译流水线：
 *
 * 1. `tsc -p electron/tsconfig.json` 把主进程编译成 CommonJS（main.js 按需
 *    require 同级的 workspace.js 等模块，主进程没有 sandbox 限制）；
 * 2. esbuild 把 `preload.ts` 及其依赖（api.ts）打包成**单个** CommonJS
 *    `preload.js`。sandbox preload 的 `require` 只能加载内置模块，不能加载
 *    拆分的本地文件（HANDOFF 13.1 的阻断问题），所以 preload 必须自包含；
 * 3. 在 electron/dist 写入 `{ type: "commonjs" }`，因为 demo/package.json
 *    声明了 "type": "module"，需要更近的 package.json 让 Electron 按
 *    CommonJS 加载编译产物。
 */
import { spawnSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(demoRoot, 'electron');
const distDir = path.join(electronDir, 'dist');
const packageInfo = JSON.parse(await readFile(path.join(demoRoot, 'package.json'), 'utf8'));
const git = (...args) => spawnSync('git', args, { cwd: demoRoot, encoding: 'utf8' });
const revision = git('rev-parse', 'HEAD');
const status = git('status', '--porcelain');

const tsc = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', path.join(electronDir, 'tsconfig.json')],
  { stdio: 'inherit' },
);
if (tsc.status !== 0) {
  process.exitCode = tsc.status ?? 1;
  process.exit(process.exitCode);
}

await esbuild.build({
  entryPoints: [path.join(electronDir, 'preload.ts')],
  outfile: path.join(distDir, 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // electron 在 sandbox preload 中由内置加载器提供，保留为外部依赖。
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

await writeFile(
  path.join(distDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' })}\n`,
);
await esbuild.build({
  entryPoints: [path.join(electronDir, 'dsh-worker.ts')],
  outfile: path.join(distDir, 'dsh-worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: false, legalComments: 'none', logLevel: 'info',
});
console.log('build:electron compiled main, bundled sandbox preload, marked dist as CommonJS');
await writeFile(path.join(distDir, 'build-info.json'), JSON.stringify({
  version: packageInfo.version,
  commit: revision.status === 0 ? revision.stdout.trim() : null,
  builtAt: new Date().toISOString(),
  dirty: status.status === 0 && Boolean(status.stdout.trim()),
}, null, 2));
