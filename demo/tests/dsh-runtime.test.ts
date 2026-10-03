import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectDshRuntime, DSH_PACKAGES } from '../electron/dsh-runtime.ts';
import { DSH_RUNTIME_VERSION } from '../lib/dsh-capabilities.ts';

void test('runtime self-check distinguishes missing installation from incompatible packages and checks Node', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-inspection-'));
  try {
    assert.equal((await inspectDshRuntime(root)).errorCode, 'runtime_missing');
    for (const component of DSH_PACKAGES) {
      const dir = path.join(root, 'node_modules', '@deepseek-ai', component);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: DSH_RUNTIME_VERSION }));
      await mkdir(path.join(dir, 'lib'));
      await writeFile(path.join(dir, 'lib', component === 'dsh' ? 'bin.js' : 'index.js'), '');
    }
    await copyFile(process.execPath, path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'));
    const ready = await inspectDshRuntime(root);
    assert.equal(ready.available, true);
    assert.equal(ready.checks.length, 5);
    assert.equal(JSON.stringify(ready).includes(root), false);
    await writeFile(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.0.0' }));
    assert.equal((await inspectDshRuntime(root)).errorCode, 'runtime_version');
  } finally { await rm(root, { recursive: true, force: true }); }
});
