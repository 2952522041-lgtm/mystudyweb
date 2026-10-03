import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { DSH_RUNTIME_VERSION } from './dsh-capabilities.ts';
import type { DshRuntimeStatus } from './dsh-types.ts';

export const dshRuntimeRoot = () => path.join(homedir(), '.local', 'opt', `yeyu-dsh-runtime-${DSH_RUNTIME_VERSION}`);
export const DSH_PACKAGES = ['dsh', 'dsh-sdk-client', 'dsh-llm-pi-ai', 'dsh-attachment-local'] as const;

/** Main process chooses paths. Never accept a renderer-supplied executable. */
export async function inspectDshRuntime(root = dshRuntimeRoot()): Promise<DshRuntimeStatus> {
  const checks: DshRuntimeStatus['checks'] = [];
  let missing = false;
  for (const component of DSH_PACKAGES) {
    try {
      const metadata = JSON.parse(await readFile(path.join(root, 'node_modules', '@deepseek-ai', component, 'package.json'), 'utf8'));
      await access(path.join(root, 'node_modules', '@deepseek-ai', component, 'lib', component === 'dsh' ? 'bin.js' : 'index.js'), constants.R_OK);
      const version = typeof metadata.version === 'string' && /^[\w.+-]{1,60}$/.test(metadata.version) ? metadata.version : undefined;
      checks.push({ component, ok: version === DSH_RUNTIME_VERSION, ...(version ? { version } : {}) });
    } catch { missing = true; checks.push({ component, ok: false }); }
  }
  const node = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    await access(node, constants.X_OK);
    const version = await new Promise<string>((resolve, reject) => execFile(node, ['--version'], { timeout: 3_000, maxBuffer: 256, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
    const ok = Boolean(match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 13)));
    checks.push({ component: 'node', ok, ...(match ? { version } : {}) });
  } catch { missing = true; checks.push({ component: 'node', ok: false }); }
  return { available: checks.every(check => check.ok), expectedVersion: DSH_RUNTIME_VERSION, checkedAt: new Date().toISOString(), checks, ...(!checks.every(check => check.ok) ? { errorCode: missing ? 'runtime_missing' as const : 'runtime_version' as const } : {}) };
}
