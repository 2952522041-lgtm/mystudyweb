/**
 * sandbox: true 时，preload 的 require 只允许 Electron 内置模块，
 * 不能加载 ./api.js 这样的本地文件。必须把 preload.ts 连同 api.ts
 * 打包成单个 CommonJS 文件，覆盖 tsc 的多文件编译产物。
 * electron 保持 external —— 沙箱 preload 允许 require('electron')。
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'electron/dist/preload.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

console.log('build:electron bundled preload.ts + api.ts into a single CommonJS preload.js');
