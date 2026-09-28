import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Error raised when a Chromium Linux sandbox helper does not satisfy the
 * ownership, mode, path, or content checks required by the desktop launcher.
 *
 * The error deliberately contains a stable machine-readable code and a safe
 * diagnostic. It never includes file contents or environment credentials.
 */
export class SandboxHelperError extends Error {
  constructor(code, message, targetPath) {
    super(message);
    this.name = 'SandboxHelperError';
    this.code = code;
    if (targetPath !== undefined) this.path = targetPath;
  }
}

const SANDBOX_MODE = 0o4755;
const DIRECTORY_OTHER_WRITE = 0o0002;

function error(code, message, targetPath) {
  return new SandboxHelperError(code, message, targetPath);
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw error('ERR_SANDBOX_ARGUMENT', `${label} must be a non-empty path.`);
  }
  if (!path.isAbsolute(value)) {
    throw error(
      'ERR_SANDBOX_PATH_NOT_ABSOLUTE',
      `${label} must be an absolute path: ${value}`,
      value,
    );
  }
  return path.resolve(value);
}

function pathParts(filePath) {
  const parts = [];
  let current = path.resolve(filePath);
  while (true) {
    parts.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return parts.reverse();
}

function kindFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;

  const value = metadata;
  const explicit = value.kind ?? value.type;
  if (typeof explicit === 'string') {
    const kind = explicit.toLowerCase();
    if (kind === 'file' || kind === 'regular' || kind === 'regularfile') {
      return 'file';
    }
    if (kind === 'directory' || kind === 'dir') return 'directory';
    if (kind === 'symlink' || kind === 'symboliclink') return 'symlink';
    return kind;
  }

  if (typeof value.isSymbolicLink === 'function' && value.isSymbolicLink()) {
    return 'symlink';
  }
  if (typeof value.isFile === 'function' && value.isFile()) return 'file';
  if (typeof value.isDirectory === 'function' && value.isDirectory()) {
    return 'directory';
  }

  if (typeof value.mode === 'number') {
    const fileType = value.mode & 0o170000;
    if (fileType === 0o100000) return 'file';
    if (fileType === 0o040000) return 'directory';
    if (fileType === 0o120000) return 'symlink';
  }
  return undefined;
}

function metadataFor(value, targetPath) {
  const kind = kindFromMetadata(value);
  const uid = Number(value?.uid);
  const gid = Number(value?.gid);
  const mode = Number(value?.mode);
  if (
    !kind ||
    !Number.isInteger(uid) ||
    uid < 0 ||
    !Number.isInteger(gid) ||
    gid < 0 ||
    !Number.isInteger(mode) ||
    mode < 0
  ) {
    throw error(
      'ERR_SANDBOX_STAT',
      `Could not read complete file metadata for ${targetPath}.`,
      targetPath,
    );
  }
  return { kind, uid, gid, mode };
}

async function statOne(fsstat, targetPath) {
  let value;
  try {
    value = await fsstat(targetPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw error(
      'ERR_SANDBOX_STAT',
      `Could not inspect ${targetPath}: ${detail}`,
      targetPath,
    );
  }
  return metadataFor(value, targetPath);
}

function checkNoSymlink(kind, targetPath) {
  if (kind === 'symlink') {
    throw error(
      'ERR_SANDBOX_PATH_SYMLINK',
      `Sandbox path contains a symbolic link: ${targetPath}`,
      targetPath,
    );
  }
}

async function checkPathComponents(targetPath, fsstat) {
  const components = pathParts(targetPath);
  for (const component of components) {
    const metadata = await statOne(fsstat, component);
    checkNoSymlink(metadata.kind, component);
  }
}

async function checkRealPath(targetPath, resolvePath) {
  let resolved;
  try {
    resolved = await resolvePath(targetPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw error(
      'ERR_SANDBOX_REALPATH',
      `Could not resolve sandbox path ${targetPath}: ${detail}`,
      targetPath,
    );
  }
  if (path.resolve(resolved) !== path.resolve(targetPath)) {
    throw error(
      'ERR_SANDBOX_PATH_SYMLINK',
      `Sandbox path must resolve to itself: ${targetPath} -> ${resolved}`,
      targetPath,
    );
  }
}

function checkRegularFile(metadata, targetPath) {
  if (metadata.kind !== 'file') {
    throw error(
      'ERR_SANDBOX_NOT_REGULAR',
      `Sandbox helper must be a regular file: ${targetPath}`,
      targetPath,
    );
  }
}

function checkHelperFile(metadata, targetPath) {
  checkRegularFile(metadata, targetPath);
  if (metadata.uid !== 0 || metadata.gid !== 0) {
    throw error(
      'ERR_SANDBOX_OWNER',
      `Sandbox helper must be owned by root:root (uid=${metadata.uid}, gid=${metadata.gid}): ${targetPath}`,
      targetPath,
    );
  }
  if ((metadata.mode & 0o7777) !== SANDBOX_MODE) {
    const actualMode = (metadata.mode & 0o7777).toString(8).padStart(4, '0');
    throw error(
      'ERR_SANDBOX_MODE',
      `Sandbox helper must have mode 4755 (actual ${actualMode}): ${targetPath}`,
      targetPath,
    );
  }
}

function checkParentDirectory(metadata, targetPath) {
  if (metadata.kind !== 'directory') {
    throw error(
      'ERR_SANDBOX_PARENT_NOT_DIRECTORY',
      `Sandbox helper parent must be a directory: ${targetPath}`,
      targetPath,
    );
  }
  if (metadata.uid !== 0 || metadata.gid !== 0) {
    throw error(
      'ERR_SANDBOX_PARENT_OWNER',
      `Sandbox helper parent must be owned by root:root (uid=${metadata.uid}, gid=${metadata.gid}): ${targetPath}`,
      targetPath,
    );
  }
  if ((metadata.mode & DIRECTORY_OTHER_WRITE) !== 0) {
    throw error(
      'ERR_SANDBOX_PARENT_OTHER_WRITABLE',
      `Sandbox helper parent must not be writable by other users: ${targetPath}`,
      targetPath,
    );
  }
}

async function checkHelperMetadata(helperPath, fsstat) {
  const components = pathParts(helperPath);
  const metadata = [];
  for (const component of components) {
    const item = await statOne(fsstat, component);
    checkNoSymlink(item.kind, component);
    metadata.push({ path: component, metadata: item });
  }

  const leaf = metadata.at(-1);
  checkHelperFile(leaf.metadata, helperPath);
  for (const entry of metadata.slice(0, -1)) {
    checkParentDirectory(entry.metadata, entry.path);
  }
}

function isBytes(value) {
  return (
    typeof value === 'string' ||
    value instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  );
}

async function hashFromReadResult(result, targetPath) {
  const hash = createHash('sha256');
  if (isBytes(result)) {
    hash.update(result);
    return hash.digest('hex');
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    for await (const chunk of result) {
      if (!isBytes(chunk)) {
        throw error(
          'ERR_SANDBOX_READ',
          `Sandbox helper reader returned a non-byte chunk for ${targetPath}.`,
          targetPath,
        );
      }
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  if (result && typeof result[Symbol.iterator] === 'function') {
    for (const chunk of result) {
      if (!isBytes(chunk)) {
        throw error(
          'ERR_SANDBOX_READ',
          `Sandbox helper reader returned a non-byte chunk for ${targetPath}.`,
          targetPath,
        );
      }
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  throw error(
    'ERR_SANDBOX_READ',
    `Sandbox helper reader did not return a byte stream for ${targetPath}.`,
    targetPath,
  );
}

async function hashFile(targetPath, read) {
  let result;
  try {
    result = await read(targetPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw error(
      'ERR_SANDBOX_READ',
      `Could not read sandbox helper ${targetPath}: ${detail}`,
      targetPath,
    );
  }
  try {
    return await hashFromReadResult(result, targetPath);
  } catch (cause) {
    if (cause instanceof SandboxHelperError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw error(
      'ERR_SANDBOX_READ',
      `Could not read sandbox helper ${targetPath}: ${detail}`,
      targetPath,
    );
  }
}

/**
 * Verify that a bundled Chromium helper can safely reuse an existing Linux
 * setuid helper. This function is strictly read-only: it never copies,
 * chmods, chowns, or otherwise mutates either path.
 *
 * `fsstat` is an optional async callback receiving an absolute path and
 * returning an `fs.lstat`-compatible object (or a `{kind, uid, gid, mode}`
 * record). `read` is an optional callback returning bytes, an iterable of
 * byte chunks, or an async iterable such as a ReadStream. They are intended
 * for deterministic tests. In production, lstat and a streaming ReadStream
 * are used. When the default lstat implementation is used, realpath is also
 * checked for both leaves; injected metadata still catches symlinks in every
 * path component without requiring privileged files on the host.
 */
export async function verifySandboxHelper({
  bundledPath,
  helperPath,
  fsstat: injectedFsstat,
  read: injectedRead,
  realpath: injectedRealpath,
} = {}) {
  const bundled = absolutePath(bundledPath, 'bundledPath');
  const helper = absolutePath(helperPath, 'helperPath');
  const fsstat = injectedFsstat ?? ((targetPath) => lstat(targetPath));
  const read = injectedRead ?? ((targetPath) => createReadStream(targetPath));

  await checkPathComponents(bundled, fsstat);
  await checkPathComponents(helper, fsstat);

  // The realpath check is intentionally kept on the default filesystem path;
  // tests that inject metadata can represent nonexistent absolute fixtures.
  // Component-by-component lstat above is equivalent for injected fixtures
  // and also rejects a leaf or parent symlink before any content is read.
  const resolvePath =
    injectedRealpath ?? (injectedFsstat ? undefined : realpath);
  if (resolvePath) {
    await checkRealPath(bundled, resolvePath);
    await checkRealPath(helper, resolvePath);
  }

  await checkHelperMetadata(helper, fsstat);
  const bundledMetadata = await statOne(fsstat, bundled);
  checkRegularFile(bundledMetadata, bundled);

  const bundledSha256 = await hashFile(bundled, read);
  const helperSha256 = await hashFile(helper, read);
  if (bundledSha256 !== helperSha256) {
    throw error(
      'ERR_SANDBOX_HASH_MISMATCH',
      `Bundled helper hash ${bundledSha256} does not match ${helper} hash ${helperSha256}.`,
      helper,
    );
  }

  return { ok: true, helperPath: helper, sha256: helperSha256 };
}

function cliErrorPayload(cause) {
  if (cause instanceof SandboxHelperError) {
    return {
      ok: false,
      code: cause.code,
      error: cause.message,
      ...(cause.path ? { path: cause.path } : {}),
    };
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, code: 'ERR_SANDBOX_CHECK_FAILED', error: detail };
}

async function main(argv) {
  if (argv.length !== 2) {
    throw error(
      'ERR_SANDBOX_ARGUMENT',
      'Usage: node scripts/check-linux-sandbox.mjs <bundledPath> <helperPath>',
    );
  }
  const result = await verifySandboxHelper({
    bundledPath: argv[0],
    helperPath: argv[1],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${JSON.stringify(cliErrorPayload(cause))}\n`);
    process.exitCode = 1;
  }
}
