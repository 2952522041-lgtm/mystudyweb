import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPackage } from '@electron/asar';
import { checkUserDesktop, desktopTreeDigest, installUserDesktop, rollbackUserDesktop, userDesktopPaths } from '../scripts/user-desktop-update.mjs';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeyu-user-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, '用户 home');
  const source = path.join(root, 'package');
  const app = path.join(root, 'app');
  await mkdir(path.join(app, 'electron/dist'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ version: '0.2.2', productName: '页语', main: 'electron/dist/main.js' }));
  for (const entry of ['main.js', 'preload.js', 'dsh-worker.mjs', 'yeyu-mcp.js']) await writeFile(path.join(app, 'electron/dist', entry), '// fixture');
  await writeFile(path.join(app, 'electron/dist/build-info.json'), JSON.stringify({ version: '0.2.2', commit: 'a'.repeat(40), dirty: false }));
  await mkdir(path.join(source, 'resources/client'), { recursive: true });
  await createPackage(app, path.join(source, 'resources/app.asar'));
  await writeFile(path.join(source, 'resources/client/index.html'), 'frontend one');
  await writeFile(path.join(source, 'yeyu'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(source, 'chrome-sandbox'), 'helper', { mode: 0o755 });
  await writeFile(path.join(source, 'chrome_crashpad_handler'), 'handler', { mode: 0o755 });
  for (const entry of ['icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'libffmpeg.so']) await writeFile(path.join(source, entry), 'runtime');
  await mkdir(path.join(source, 'locales'));
  await writeFile(path.join(source, 'locales/en-US.pak'), 'locale');
  const icon = path.join(root, 'icon.png');
  await writeFile(icon, 'icon');
  const verifyHelper = async () => ({ ok: true, helperPath: '/usr/lib/yeyu/chrome-sandbox', sha256: '0'.repeat(64) });
  const options = { home, source, icon, verifyHelper };
  return { ...options, options, paths: userDesktopPaths(home), root };
}

void test('user install verifies complete runtime, preserves source/data and supports two-way rollback', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.config/页语'), { recursive: true });
  const data = path.join(f.home, '.config/页语/persistent-data');
  await writeFile(data, 'settings, auth and course references');
  const originalDigest = await desktopTreeDigest(f.source);
  const first = await installUserDesktop(f.options);
  assert.equal(first.status, 'installed');
  assert.equal(first.requiresRestart, true);
  assert.equal(first.previous, null);
  assert.equal((await checkUserDesktop(f.options)).release, first.release);
  assert.equal(await desktopTreeDigest(f.source), originalDigest);
  assert.equal(await readlink(path.join(first.directory, 'chrome-sandbox')), '/usr/lib/yeyu/chrome-sandbox');
  assert.equal((await installUserDesktop(f.options)).status, 'unchanged');
  await assert.rejects(rollbackUserDesktop(f.options), { code: 'NO_PREVIOUS_RELEASE' });
  await writeFile(path.join(f.source, 'resources/client/index.html'), 'frontend two');
  const second = await installUserDesktop(f.options);
  assert.notEqual(first.release, second.release, 'same version, different build uses a different directory');
  assert.equal(second.previous, first.release);
  assert.equal(await readFile(path.join(first.directory, 'resources/client/index.html'), 'utf8'), 'frontend one');
  assert.equal((await rollbackUserDesktop(f.options)).release, first.release);
  assert.equal((await checkUserDesktop(f.options)).release, first.release, 'check validates selected version independently of latest package');
  assert.equal((await rollbackUserDesktop(f.options)).release, second.release);
  assert.equal(await readFile(data, 'utf8'), 'settings, auth and course references');
  await writeFile(path.join(second.directory, 'yeyu'), 'runtime corruption');
  await assert.rejects(checkUserDesktop(f.options), { code: 'CORRUPT_RELEASE' });
});

void test('failed build/copy, mismatched sandbox and incompatible package leave old selection intact', async t => {
  const f = await fixture(t);
  const first = await installUserDesktop(f.options);
  await writeFile(path.join(f.source, 'resources/client/index.html'), 'new');
  const active = await readlink(f.paths.active);
  const launcher = await readFile(f.paths.shell, 'utf8');
  await assert.rejects(installUserDesktop({ ...f.options, prepare: async () => { throw new Error('build failed'); } }), /build failed/);
  await assert.rejects(installUserDesktop({ ...f.options, copy: async () => { throw new Error('disk full'); } }), /disk full/);
  await assert.rejects(installUserDesktop({ ...f.options, verifyHelper: async () => { throw new Error('helper mismatch'); } }), /helper mismatch/);
  await assert.rejects(installUserDesktop({ ...f.options, expectedVersion: '9.9.9' }), { code: 'STALE_PACKAGE' });
  assert.equal(await readlink(f.paths.active), active);
  assert.equal(await readFile(f.paths.shell, 'utf8'), launcher);
  assert.equal((await checkUserDesktop(f.options)).release, first.release);
  assert.equal((await readdir(f.paths.releases)).some(name => name.startsWith('.staging-')), false);
});

void test('copy corruption, runtime links and executable bit loss are detected before activation', async t => {
  const f = await fixture(t);
  await assert.rejects(installUserDesktop({ ...f.options, copy: async (source: string | URL, target: string | URL, options) => {
    await cp(source, target, options);
    await writeFile(path.join(String(target), 'yeyu'), 'bad copy');
  } }), { code: 'COPY_MISMATCH' });
  await symlink('/etc/passwd', path.join(f.source, 'outside'));
  await assert.rejects(installUserDesktop(f.options), { code: 'INVALID_PACKAGE_ENTRY' });
  await rm(path.join(f.source, 'outside'));
  const first = await installUserDesktop(f.options);
  await chmod(path.join(first.directory, 'yeyu'), 0o644);
  await assert.rejects(checkUserDesktop(f.options), { code: 'CORRUPT_RELEASE' });
});

void test('installation and rollback share a lock including the build phase', async t => {
  const f = await fixture(t);
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = installUserDesktop({ ...f.options, prepare: async () => { started(); await gate; } });
  await ready;
  try {
    await assert.rejects(installUserDesktop(f.options), { code: 'UPDATE_BUSY' });
    await assert.rejects(rollbackUserDesktop(f.options), { code: 'UPDATE_BUSY' });
  } finally { resume(); }
  assert.equal((await pending).status, 'installed');
  assert.equal((await checkUserDesktop(f.options)).status, 'verified');
});

void test('unexpected activation/launcher links are refused without redirecting writes', async t => {
  const f = await fixture(t);
  await installUserDesktop(f.options);
  const before = await readlink(f.paths.active);
  await rm(f.paths.desktop);
  const unrelated = path.join(f.root, 'unrelated');
  await writeFile(unrelated, 'keep me');
  await symlink(unrelated, f.paths.desktop);
  await assert.rejects(installUserDesktop(f.options), { code: 'INVALID_LAUNCHER' });
  assert.equal(await readFile(unrelated, 'utf8'), 'keep me');
  assert.equal(await readlink(f.paths.active), before);
  await rm(f.paths.active);
  await symlink('/tmp/outside-installation', f.paths.active);
  await assert.rejects(checkUserDesktop(f.options), { code: 'INVALID_ACTIVATION' });
});

void test('JSON dry-run and absent-install check do not write user files or ask for elevation', async t => {
  const f = await fixture(t);
  const script = path.resolve('scripts/update-desktop.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
  const planned = run('--dry-run', '--json');
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).sudo, false);
  const absent = run('--check', '--json');
  assert.equal(absent.status, 1);
  assert.equal(JSON.parse(absent.stdout).code, 'NOT_INSTALLED');
  await assert.rejects(readdir(f.paths.base), { code: 'ENOENT' });
  assert.equal(run('--check', '--rollback', '--json').status, 1);
});

void test('missing runtime file and symlinked ancestors are rejected before any activation', async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, 'icudtl.dat'));
  await assert.rejects(installUserDesktop(f.options), { code: 'INVALID_PACKAGE' });
  await writeFile(path.join(f.source, 'icudtl.dat'), 'runtime');
  const otherHome = path.join(f.root, 'other-home');
  const outside = path.join(f.root, 'outside');
  await mkdir(otherHome);
  await mkdir(outside);
  await symlink(outside, path.join(otherHome, '.local'));
  await assert.rejects(installUserDesktop({ ...f.options, home: otherHome }), { code: 'INVALID_DIRECTORY' });
  assert.deepEqual(await readdir(outside), []);
});

void test('activation restores old pointer even if a launcher restore also fails', async t => {
  const f = await fixture(t);
  const first = await installUserDesktop(f.options);
  const active = await readlink(f.paths.active);
  await writeFile(path.join(f.source, 'resources/client/index.html'), 'new build');
  let writes = 0;
  await assert.rejects(installUserDesktop({ ...f.options, writeLauncher: async (file: string, content: string | Uint8Array, mode: number) => {
    writes++;
    if (writes >= 2) throw new Error('simulated full disk');
    await writeFile(file, content, { mode });
  } }), /恢复失败/);
  assert.equal(writes, 3, 'both second write and first restore were attempted');
  assert.equal(await readlink(f.paths.active), active);
  assert.equal((await checkUserDesktop(f.options)).release, first.release);
});

void test('same-path rebuilt asar metadata is read afresh by the local API', async t => {
  const f = await fixture(t);
  await installUserDesktop(f.options);
  const app = path.join(f.root, 'app');
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ version: '0.2.3', productName: '页语', main: 'electron/dist/main.js', extra: 'a longer package header' }));
  await writeFile(path.join(app, 'electron/dist/build-info.json'), JSON.stringify({ version: '0.2.3', commit: 'b'.repeat(40), dirty: false }));
  await createPackage(app, path.join(f.source, 'resources/app.asar'));
  const result = await installUserDesktop({ ...f.options, expectedVersion: '0.2.3' });
  assert.equal(result.version, '0.2.3');
  assert.equal(result.commit, 'b'.repeat(40));
});
