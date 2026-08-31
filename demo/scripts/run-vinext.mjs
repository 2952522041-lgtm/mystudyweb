/**
 * 包装 vinext CLI 的构建命令。
 *
 * vinext build 在成功后调用 process.exit(0)；Windows 上若此时 miniflare/
 * workerd 相关的 libuv 句柄尚未关闭，Node 会以
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`
 * 崩溃退出——但构建产物其实已经完整落盘。这里包装一层：日志出现
 * "Build complete" 且 dist/client 产物存在时，把这类退出崩溃视为成功；
 * 其余失败（真实构建错误）原样透传退出码。
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD_COMPLETE_MARKER = 'Build complete';

/** @param {string} clientDir */
export async function hasBuildArtifacts(clientDir) {
  try {
    const entries = await readdir(clientDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * 判定一次非零退出是否属于“构建已完成、仅退出阶段崩溃”的已知 Windows 问题。
 *
 * @param {number | null} exitCode
 * @param {string} output
 * @param {string} clientDir
 */
export async function shouldTolerateExit(exitCode, output, clientDir) {
  if (exitCode === 0 || exitCode === null) return false;
  if (!output.includes(BUILD_COMPLETE_MARKER)) return false;
  return hasBuildArtifacts(clientDir);
}

async function main() {
  const demoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const args = process.argv.slice(2);
  const child = spawn(
    process.execPath,
    [path.join(demoRoot, 'node_modules', 'vinext', 'dist', 'cli.js'), ...args],
    { stdio: ['inherit', 'pipe', 'inherit'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
    process.stdout.write(chunk);
  });
  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(1));
  });
  if (
    await shouldTolerateExit(exitCode, output, path.join(demoRoot, 'dist', 'client'))
  ) {
    console.warn(
      'run-vinext: build finished, tolerating the known win32 libuv exit crash ' +
        '(Assertion in src\\win\\async.c) after successful artifact output.',
    );
    return 0;
  }
  return exitCode ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
