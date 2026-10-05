import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBuildInfo } from '../electron/build-info.ts';
import {
  installationDigest,
  updateLauncher,
} from '../scripts/desktop-update-utils.mjs';

void test('desktop update migrates only old Yeyu paths and keeps profile/display flags', () => {
  const home = '/home/test.user';
  const legacy = `${home}/.local/opt/yeyu-20260929-all-ai-dsh/yeyu`;
  for (const value of [
    `#!/bin/sh\nexec ${legacy} --user-data-dir=/data/页语 --ozone-platform=x11 "$@"\n`,
    `Exec=${legacy} --disable-gpu %U\nIcon=yeyu\n`,
  ]) {
    assert.equal(
      updateLauncher(value, home),
      value.replace(legacy, '/usr/bin/yeyu'),
    );
    assert.equal(
      updateLauncher(updateLauncher(value, home), home),
      updateLauncher(value, home),
    );
  }
  assert.equal(
    updateLauncher('/home/testXuser/.local/opt/yeyu-old/yeyu', home),
    '/home/testXuser/.local/opt/yeyu-old/yeyu',
  );
  assert.equal(
    updateLauncher('exec /opt/custom/yeyu "$@"', home),
    'exec /opt/custom/yeyu "$@"',
  );
});

void test('installed digest checks frontend as well as asar; build metadata has safe fallbacks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yeyu-update-'));
  try {
    await mkdir(path.join(dir, 'client'));
    await writeFile(path.join(dir, 'app.asar'), 'main');
    await writeFile(path.join(dir, 'client/index.html'), 'v1');
    const first = await installationDigest(dir);
    await writeFile(path.join(dir, 'client/index.html'), 'v2');
    assert.notEqual(await installationDigest(dir), first);
    const metadata = path.join(dir, 'build-info.json');
    assert.equal((await readBuildInfo(metadata, '0.2.0', true)).commit, null);
    await writeFile(
      metadata,
      JSON.stringify({
        commit: 'abcdef1234567',
        builtAt: '2026-10-05T00:00:00Z',
        dirty: true,
        secret: 'never expose',
      }),
    );
    assert.deepEqual(await readBuildInfo(metadata, '0.2.0', true), {
      version: '0.2.0',
      commit: 'abcdef1234567',
      builtAt: '2026-10-05T00:00:00Z',
      dirty: true,
      packaged: true,
    });
    await writeFile(metadata, '{');
    assert.equal((await readBuildInfo(metadata, '0.2.0', true)).builtAt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
