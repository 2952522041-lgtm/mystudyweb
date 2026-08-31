/**
 * Electron 主进程/preload 以 CommonJS 产出，但 demo/package.json 声明了
 * "type": "module"。在 electron/dist 放一个更近的 package.json，
 * 让 Node/Electron 按 CommonJS 加载编译产物，preload 沙箱才能 require。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

await writeFile(
  path.resolve(import.meta.dirname, '../electron/dist/package.json'),
  `${JSON.stringify({ type: 'commonjs' })}\n`,
);
console.log('build:electron marked electron/dist as CommonJS');
