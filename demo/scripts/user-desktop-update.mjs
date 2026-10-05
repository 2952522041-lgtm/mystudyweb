import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, uncache } from '@electron/asar';
import { verifySandboxHelper } from './check-linux-sandbox.mjs';
import { createUserLaunchers } from './user-desktop-launchers.mjs';

const SYSTEM_HELPER = '/usr/lib/yeyu/chrome-sandbox';
const MANIFEST = '.yeyu-release.json';
const RELEASE_ID = /^[a-zA-Z0-9.-]+-[a-f0-9]{24}$/;
const ACTIVATION_ID = /^[a-f0-9-]{36}$/;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function userDesktopPaths(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || ['\0', '\r', '\n'].some(character => home.includes(character))) fail('INVALID_HOME', '用户目录必须是有效绝对路径。');
  const base = path.join(home, '.local/opt/yeyu');
  return { base, releases: path.join(base, 'releases'), activations: path.join(base, 'activations'), active: path.join(base, 'active'), lock: path.join(base, '.update-lock'), shell: path.join(home, '.local/bin/yeyu'), desktop: path.join(home, '.local/share/applications/yeyu.desktop'), executable: path.join(base, 'active/current/yeyu'), icon: path.join(base, 'active/current/.yeyu-icon.png') };
}

async function plainDirectory(directory) {
  for (const current of directoryParts(directory)) {
    if (!(await optionalStat(current))) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(current)).isDirectory()) fail('INVALID_DIRECTORY', `安装目录不能是链接或文件：${current}`);
  }
}
function directoryParts(directory) {
  const parts = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    parts.unshift(current);
    if (current === path.dirname(current)) return parts;
  }
}
async function checkDirectoryAncestors(directory) {
  for (const current of directoryParts(directory)) {
    const stat = await optionalStat(current);
    if (!stat) return;
    if (!stat.isDirectory()) fail('INVALID_DIRECTORY', `安装目录不能是链接或文件：${current}`);
  }
}
async function optionalStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Hash the entire runtime and executable bits, without following arbitrary links. */
export async function desktopTreeDigest(directory, { installed = false } = {}) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.posix.join(relative, entry.name);
      if (installed && name === MANIFEST) continue;
      const file = path.join(directory, name);
      const metadata = await lstat(file);
      hash.update(JSON.stringify([name, metadata.mode & 0o777]));
      if (metadata.isDirectory()) { hash.update('directory'); await visit(name); }
      else if (metadata.isFile()) {
        hash.update(`file:${metadata.size}:`);
        for await (const chunk of createReadStream(file)) hash.update(chunk);
      } else if (installed && name === 'chrome-sandbox' && metadata.isSymbolicLink() && await readlink(file) === SYSTEM_HELPER) {
        hash.update(`sandbox:${SYSTEM_HELPER}`);
      } else fail('INVALID_PACKAGE_ENTRY', `安装包含不支持的文件或链接：${name}`);
    }
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory()) fail('INVALID_PACKAGE', '安装源必须是普通目录。');
  await visit('');
  return hash.digest('hex');
}

function readPackageInfo(source) {
  const archive = path.join(source, 'resources/app.asar');
  uncache(archive);
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString());
  const build = JSON.parse(extractFile(archive, 'electron/dist/build-info.json').toString());
  if (pkg.productName !== '页语' || pkg.main !== 'electron/dist/main.js' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version) || build.version !== pkg.version) fail('INVALID_PACKAGE', '安装包不是有效的页语桌面构建。');
  for (const entry of ['main.js', 'preload.js', 'dsh-worker.mjs', 'yeyu-mcp.js']) if (!extractFile(archive, `electron/dist/${entry}`).length) fail('INVALID_PACKAGE', `安装包缺少入口：${entry}`);
  return { version: pkg.version, commit: typeof build.commit === 'string' ? build.commit : null, dirty: build.dirty === true, builtAt: build.builtAt ?? null };
}

async function checkRuntime(source) {
  await checkDirectoryAncestors(source);
  for (const entry of ['yeyu', 'chrome-sandbox', 'chrome_crashpad_handler', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'libffmpeg.so', 'resources/app.asar', 'resources/client/index.html']) {
    const stat = await optionalStat(path.join(source, entry));
    if (!stat?.isFile() || !stat.size) fail('INVALID_PACKAGE', `安装包缺少必要文件：${entry}`);
  }
  const locales = path.join(source, 'locales');
  if (!(await optionalStat(locales))?.isDirectory() || !(await readdir(locales)).some(name => name.endsWith('.pak'))) fail('INVALID_PACKAGE', '安装包缺少语言资源。');
  await access(path.join(source, 'yeyu'), 1);
  await access(path.join(source, 'chrome_crashpad_handler'), 1);
}

async function readActivation(paths) {
  await checkDirectoryAncestors(paths.activations);
  await checkDirectoryAncestors(paths.releases);
  const stat = await optionalStat(paths.active);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) fail('INVALID_ACTIVATION', '当前版本入口不是更新器管理的链接。');
  const target = await readlink(paths.active);
  const id = target.slice('activations/'.length);
  if (target !== `activations/${id}` || !ACTIVATION_ID.test(id)) fail('INVALID_ACTIVATION', '当前版本入口超出安装目录。');
  const dir = path.join(paths.activations, id);
  if (!(await lstat(dir)).isDirectory()) fail('INVALID_ACTIVATION', '版本记录目录不合法。');
  const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  if (!RELEASE_ID.test(state.current) || (state.previous !== null && !RELEASE_ID.test(state.previous))) fail('INVALID_ACTIVATION', '版本记录不合法。');
  if (await readlink(path.join(dir, 'current')) !== `../../releases/${state.current}`) fail('INVALID_ACTIVATION', '版本链接与记录不一致。');
  return { ...state, target };
}

async function verifyRelease(paths, id, verifyHelper) {
  if (!RELEASE_ID.test(id)) fail('INVALID_RELEASE', '版本标识不合法。');
  const directory = path.join(paths.releases, id);
  if (!(await lstat(directory)).isDirectory()) fail('INVALID_RELEASE', '版本目录不能是链接。');
  const metadata = JSON.parse(await readFile(path.join(directory, MANIFEST), 'utf8'));
  if (metadata.id !== id || !/^[a-f0-9]{64}$/.test(metadata.installedDigest)) fail('INVALID_RELEASE', '版本校验记录不合法。');
  if (await desktopTreeDigest(directory, { installed: true }) !== metadata.installedDigest) fail('CORRUPT_RELEASE', '已安装程序校验失败，当前入口未切换。');
  await verifyHelper({ bundledPath: path.join(directory, 'chrome-sandbox.bundled'), helperPath: SYSTEM_HELPER });
  return { ...metadata, directory };
}

async function withLock(home, action) {
  const paths = userDesktopPaths(home);
  await plainDirectory(paths.base);
  let lock;
  try { lock = await open(paths.lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('UPDATE_BUSY', `已有更新或回滚正在进行。若上次进程异常退出，请确认没有更新进程后删除 ${paths.lock}。`); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await plainDirectory(paths.releases);
    await plainDirectory(paths.activations);
    return await action(paths);
  } finally { await lock.close(); await rm(paths.lock, { force: true }); }
}

async function atomicFile(file, bytes, mode) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try { await writeFile(temporary, bytes, { mode, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
async function swapActive(paths, target) {
  if (!target) { await rm(paths.active, { force: true }); return; }
  const temporary = path.join(paths.base, `.active-${randomUUID()}`);
  try { await symlink(target, temporary); await rename(temporary, paths.active); }
  finally { await rm(temporary, { force: true }); }
}

async function activate(paths, home, current, previous, old, writeLauncher = atomicFile) {
  const launchers = createUserLaunchers({ home, executable: paths.executable, icon: paths.icon });
  const originals = [];
  for (const [file, text, mode] of [[paths.shell, launchers.shell, 0o755], [paths.desktop, launchers.desktop, 0o644]]) {
    await plainDirectory(path.dirname(file));
    const stat = await optionalStat(file);
    if (stat && !stat.isFile()) fail('INVALID_LAUNCHER', `启动入口必须为普通文件：${file}`);
    originals.push({ file, text, mode, before: stat ? await readFile(file) : null, beforeMode: stat ? stat.mode & 0o777 : mode });
  }
  const id = randomUUID();
  const directory = path.join(paths.activations, id);
  await mkdir(directory, { mode: 0o700 });
  await symlink(`../../releases/${current}`, path.join(directory, 'current'));
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ current, previous }), { mode: 0o600 });
  // Original launchers remain available for recovery, including the initial system entry.
  for (const [index, item] of originals.entries()) if (item.before) await writeFile(path.join(directory, `launcher-${index}.backup`), item.before, { mode: 0o600 });
  const changed = [];
  try {
    await swapActive(paths, `activations/${id}`);
    for (const item of originals) {
      await writeLauncher(item.file, item.text, item.mode);
      changed.push(item);
    }
  } catch (error) {
    const recovery = [];
    for (const item of changed.reverse()) {
      try {
        if (item.before) await writeLauncher(item.file, item.before, item.beforeMode);
        else await rm(item.file, { force: true });
      } catch (restoreError) { recovery.push(restoreError); }
    }
    try { await swapActive(paths, old?.target); } catch (restoreError) { recovery.push(restoreError); }
    if (recovery.length) throw new AggregateError([error, ...recovery], `更新失败，部分启动入口恢复失败，请检查用户安装目录：${paths.base}`, { cause: error });
    throw error;
  }
}

function result(status, release, previous) {
  return { ok: true, status, version: release.version, commit: release.commit, dirty: release.dirty, release: release.id, directory: release.directory, previous: previous ?? null, requiresRestart: status !== 'verified' };
}

/**
 * Local, current-user API. No HTTP listener, credentials, elevation or user-data writes.
 * @param {{home:string, source:string, icon:string, expectedVersion?:string, prepare?:()=>Promise<unknown>, verifyHelper?:typeof verifySandboxHelper, copy?:typeof cp, writeLauncher?:(file:string,bytes:string|Uint8Array,mode:number)=>Promise<void>}} options
 */
export async function installUserDesktop({ home, source, icon, expectedVersion, prepare, verifyHelper = verifySandboxHelper, copy = cp, writeLauncher }) {
  return withLock(home, async paths => {
    // The same lock covers builds as well as activation, avoiding concurrent shared out/ writes.
    if (prepare) await prepare();
    await checkRuntime(source);
    for (const reserved of [MANIFEST, 'chrome-sandbox.bundled', '.yeyu-icon.png']) if (await optionalStat(path.join(source, reserved))) fail('INVALID_PACKAGE', '安装源含更新器保留文件，请重新构建。');
    const build = readPackageInfo(source);
    if (expectedVersion && expectedVersion !== build.version) fail('STALE_PACKAGE', '打包版本与项目版本不同，请先重新构建。');
    await verifyHelper({ bundledPath: path.join(source, 'chrome-sandbox'), helperPath: SYSTEM_HELPER });
    const sourceDigest = await desktopTreeDigest(source);
    const iconBytes = await readFile(icon);
    const identity = createHash('sha256').update(sourceDigest).update(iconBytes).digest('hex');
    const id = `${build.version}-${identity.slice(0, 24)}`;
    const target = path.join(paths.releases, id);
    if (!(await optionalStat(target))) {
      const staging = path.join(paths.releases, `.staging-${randomUUID()}`);
      try {
        await copy(source, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
        if (await desktopTreeDigest(staging) !== sourceDigest) fail('COPY_MISMATCH', '复制后校验不一致，保留原版本。');
        await rename(path.join(staging, 'chrome-sandbox'), path.join(staging, 'chrome-sandbox.bundled'));
        await symlink(SYSTEM_HELPER, path.join(staging, 'chrome-sandbox'));
        await writeFile(path.join(staging, '.yeyu-icon.png'), iconBytes, { mode: 0o644 });
        const metadata = { id, ...build, sourceDigest, installedDigest: await desktopTreeDigest(staging, { installed: true }) };
        await writeFile(path.join(staging, MANIFEST), JSON.stringify(metadata, null, 2), { mode: 0o600 });
        await rename(staging, target);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    const release = await verifyRelease(paths, id, verifyHelper);
    if (release.sourceDigest !== sourceDigest) fail('RELEASE_CONFLICT', '版本标识冲突，保留原版本。');
    const old = await readActivation(paths);
    const previous = old?.current === id ? old.previous : old?.current ?? null;
    await activate(paths, home, id, previous, old, writeLauncher);
    return result(old?.current === id ? 'unchanged' : 'installed', release, previous);
  });
}

export async function checkUserDesktop({ home, verifyHelper = verifySandboxHelper }) {
  const paths = userDesktopPaths(home);
  const state = await readActivation(paths);
  if (!state) fail('NOT_INSTALLED', '尚未安装用户目录版本，请运行 pnpm desktop:update。');
  const release = await verifyRelease(paths, state.current, verifyHelper);
  const launchers = createUserLaunchers({ home, executable: paths.executable, icon: paths.icon });
  for (const [file, expected] of [[paths.shell, launchers.shell], [paths.desktop, launchers.desktop]]) {
    if (await readFile(file, 'utf8') !== expected) fail('LAUNCHER_MISMATCH', '启动入口与用户安装不一致，请重新执行更新。');
  }
  await access(paths.shell, 1);
  return result('verified', release, state.previous);
}

export async function rollbackUserDesktop({ home, verifyHelper = verifySandboxHelper }) {
  return withLock(home, async paths => {
    const old = await readActivation(paths);
    if (!old?.previous) fail('NO_PREVIOUS_RELEASE', '没有可回滚的上一个用户版本；原系统安装仍保留。');
    const release = await verifyRelease(paths, old.previous, verifyHelper);
    await activate(paths, home, old.previous, old.current, old);
    return result('rolled-back', release, old.current);
  });
}
