import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_CONVERSION_TIMEOUT_MS = 120_000;

export const errors = Object.freeze({
  CONVERTER_UNAVAILABLE: 'CONVERTER_UNAVAILABLE',
  INVALID_FILE: 'INVALID_FILE',
  CONVERSION_FAILED: 'CONVERSION_FAILED',
  CACHE_ERROR: 'CACHE_ERROR',
});

/**
 * Errors from this module intentionally contain a short, non-sensitive
 * message.  In particular, converter stderr is never copied into an error
 * shown to a Blackboard user because it can contain environment details.
 */
export class PreparePdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreparePdfError';
    this.code = code;
  }
}

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const OLE_MAGIC = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const CACHE_METADATA_NAME = 'metadata.json';
const DEFAULT_COMMAND_TIMEOUT_MS = MAX_CONVERSION_TIMEOUT_MS;
const MAX_XML_OUTPUT_BYTES = 16 * 1024 * 1024;
const KNOWN_ERROR_CODES = new Set(Object.values(errors));

function fail(code, message) {
  throw new PreparePdfError(code, message);
}

function isKnownCode(code) {
  return typeof code === 'string' && KNOWN_ERROR_CODES.has(code);
}

function asAbsolutePath(value, code = errors.INVALID_FILE) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(code, '文件路径不可用。');
  }
  return path.resolve(value);
}

function extensionKind(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.ppt') return 'ppt';
  if (extension === '.pptx') return 'pptx';
  fail(errors.INVALID_FILE, '仅支持 PDF、PPT 和 PPTX 文件。');
}

function safeOriginalName(sourcePath, fileName) {
  const value = fileName === undefined ? path.basename(sourcePath) : fileName;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    fail(errors.INVALID_FILE, '附件文件名不可用。');
  }
  // The name is used as a leaf in the content-hash directory.  Rejecting
  // control characters avoids ambiguous names in logs and on Windows.
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    fail(errors.INVALID_FILE, '附件文件名不可用。');
  }
  return value;
}

function pdfNameFor(originalName, kind) {
  if (kind === 'pdf') return originalName;
  return `${originalName.slice(0, -path.extname(originalName).length)}.pdf`;
}

function startsWithAny(buffer, signatures) {
  return signatures.some((signature) => buffer.subarray(0, signature.length).equals(signature));
}

function looksLikeHtml(buffer) {
  const text = buffer.toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return (
    text.startsWith('<!doctype html') ||
    text.startsWith('<html') ||
    text.startsWith('<head') ||
    text.startsWith('<body') ||
    text.startsWith('<script') ||
    text.startsWith('<?xml') && text.includes('<html')
  );
}

async function readMagic(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    fail(errors.INVALID_FILE, '无法读取附件。');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateMagic(kind, magic) {
  if (looksLikeHtml(magic)) {
    fail(errors.INVALID_FILE, '附件内容不是受支持的文件格式。');
  }
  if (kind === 'pdf') {
    const offset = magic.indexOf(PDF_MAGIC);
    if (offset < 0 || offset > 1024) {
      fail(errors.INVALID_FILE, 'PDF 文件头无效。');
    }
    return;
  }
  if (kind === 'pptx' && !startsWithAny(magic, ZIP_MAGIC)) {
    fail(errors.INVALID_FILE, 'PPTX 文件头无效。');
  }
  if (kind === 'ppt' && !magic.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) {
    fail(errors.INVALID_FILE, 'PPT 文件头无效。');
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(filePath, {
      highWaterMark: 1024 * 1024,
    })) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) {
        fail(errors.INVALID_FILE, '附件超过 200 MB 限制。');
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof PreparePdfError) throw error;
    fail(errors.INVALID_FILE, '无法读取附件。');
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function inspectPdfWithPdfJs(pdfPath) {
  let data;
  try {
    data = await readFile(pdfPath);
  } catch {
    fail(errors.INVALID_FILE, '无法读取 PDF。');
  }

  try {
    // The legacy build works in Node without a worker.  No page is rendered;
    // loading the document is sufficient to validate its structure and count.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false,
      verbosity: 0,
    });
    try {
      const document = await loadingTask.promise;
      const pageCount = document?.numPages;
      if (!Number.isInteger(pageCount) || pageCount <= 0) {
        fail(errors.INVALID_FILE, 'PDF 页数无效。');
      }
      await document.cleanup?.();
      return { pageCount };
    } finally {
      await loadingTask.destroy().catch(() => {});
    }
  } catch (error) {
    if (error instanceof PreparePdfError) throw error;
    fail(errors.INVALID_FILE, 'PDF 解析失败。');
  }
}

/** Default PDF inspector, exported so callers can use the same validator. */
export const inspectPdf = inspectPdfWithPdfJs;

function normalizePageCount(value) {
  const candidate =
    typeof value === 'number'
      ? value
      : value && typeof value === 'object'
        ? value.pageCount ?? value.numPages
        : undefined;
  if (!Number.isInteger(candidate) || candidate <= 0) {
    fail(errors.INVALID_FILE, 'PDF 页数无效。');
  }
  return candidate;
}

async function validatePdf(pdfPath, inspector) {
  const magic = await readMagic(pdfPath);
  validateMagic('pdf', magic);
  let inspected;
  try {
    inspected = await inspector(pdfPath);
  } catch (error) {
    if (error instanceof PreparePdfError) throw error;
    if (isKnownCode(error?.code)) {
      fail(error.code, error.code === errors.CONVERTER_UNAVAILABLE
        ? 'PDF 校验器不可用。'
        : 'PDF 校验失败。');
    }
    fail(errors.INVALID_FILE, 'PDF 解析失败。');
  }
  return { pageCount: normalizePageCount(inspected) };
}

function boundedTimeout(value) {
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.min(Math.floor(number), MAX_CONVERSION_TIMEOUT_MS);
}

function normalizeCommandResult(result) {
  if (result === undefined || result === null) {
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  }
  if (Buffer.isBuffer(result) || typeof result === 'string') {
    return { stdout: Buffer.from(result), stderr: Buffer.alloc(0), exitCode: 0 };
  }
  if (typeof result !== 'object') {
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  }
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? '');
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.from(result.stderr ?? '');
  const exitCode =
    result.exitCode ?? result.code ?? result.status ?? 0;
  return { stdout, stderr, exitCode };
}

function defaultRunner(command, args, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const maxOutputBytes = options.maxOutputBytes ?? MAX_XML_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('command output too large'));
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('command timed out'));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? 1,
      });
    });
  });
}

/** A command runner is exported for tests and for callers that need a wrapper. */
export const runCommand = defaultRunner;

async function callRunner(runner, command, args, options) {
  const callable =
    typeof runner === 'function'
      ? runner
      : runner && typeof runner.run === 'function'
        ? runner.run.bind(runner)
        : defaultRunner;
  const result = await callable(command, args, {
    ...options,
    shell: false,
  });
  return normalizeCommandResult(result);
}

function commandFailed(result) {
  return result.exitCode !== 0;
}

function xmlSlideCount(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml ?? '');
  const matches = text.match(/<(?:[A-Za-z_][\w.-]*:)?sldId(?:\s|\/|>)/g);
  const count = matches?.length ?? 0;
  if (!Number.isInteger(count) || count <= 0) {
    fail(errors.INVALID_FILE, 'PPTX 演示文稿页数无效。');
  }
  return count;
}

async function readPptxSlideCount(sourcePath, options, timeoutMs) {
  const injected =
    options.slideCount ?? options.inspectSlides ?? options.readSlideCount;
  if (typeof injected === 'number') return normalizePageCount(injected);
  if (typeof injected === 'function') {
    try {
      return normalizePageCount(await injected(sourcePath));
    } catch (error) {
      if (error instanceof PreparePdfError) throw error;
      fail(errors.INVALID_FILE, 'PPTX 演示文稿页数无效。');
    }
  }

  const result = await callRunner(
    options.unzipRunner ?? options.runner,
    options.unzipPath ?? 'unzip',
    ['-p', sourcePath, 'ppt/presentation.xml'],
    { timeoutMs, maxOutputBytes: MAX_XML_OUTPUT_BYTES },
  ).catch(() => {
    fail(errors.CONVERSION_FAILED, '无法读取 PPTX 演示文稿结构。');
  });
  if (commandFailed(result)) {
    fail(errors.INVALID_FILE, 'PPTX 演示文稿结构无效。');
  }
  try {
    return xmlSlideCount(result.stdout);
  } catch (error) {
    if (error instanceof PreparePdfError) throw error;
    fail(errors.INVALID_FILE, 'PPTX 演示文稿结构无效。');
  }
}

function converterPath(options) {
  const value = options.sofficePath;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    fail(errors.CONVERTER_UNAVAILABLE, 'LibreOffice 转换器不可用。');
  }
  return value;
}

async function ensureDefaultConverterAvailable(sofficePath, hasInjectedRunner) {
  if (hasInjectedRunner) return;
  try {
    await access(sofficePath, fsConstants.X_OK);
  } catch {
    fail(errors.CONVERTER_UNAVAILABLE, 'LibreOffice 转换器不可用。');
  }
}

async function listPdfOutputs(outputDirectory) {
  let entries;
  try {
    entries = await readdir(outputDirectory, { withFileTypes: true });
  } catch {
    fail(errors.CONVERSION_FAILED, 'LibreOffice 未生成 PDF。');
  }
  const outputs = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
    const candidate = path.join(outputDirectory, entry.name);
    try {
      if ((await stat(candidate)).isFile()) outputs.push(candidate);
    } catch {
      // A concurrent cleanup can remove a candidate. It is not an output.
    }
  }
  if (outputs.length !== 1) {
    fail(errors.CONVERSION_FAILED, outputs.length === 0
      ? 'LibreOffice 未生成 PDF。'
      : 'LibreOffice 生成了无法确定的 PDF 输出。');
  }
  return outputs[0];
}

async function convertWithLibreOffice(sourcePath, options, timeoutMs) {
  const sofficePath = converterPath(options);
  const runnerIsInjected = Boolean(options.runner);
  await ensureDefaultConverterAvailable(sofficePath, runnerIsInjected);

  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'blackboard-pdf-'));
    const profileDirectory = path.join(temporaryDirectory, 'profile');
    const outputDirectory = path.join(temporaryDirectory, 'output');
    await mkdir(profileDirectory);
    await mkdir(outputDirectory);
    const args = [
      '--headless',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outputDirectory,
      sourcePath,
    ];
    let result;
    try {
      result = await callRunner(options.runner, sofficePath, args, {
        timeoutMs,
        cwd: outputDirectory,
        outputDirectory,
        profileDirectory,
      });
    } catch (error) {
      if (!runnerIsInjected && error?.code === 'ENOENT') {
        fail(errors.CONVERTER_UNAVAILABLE, 'LibreOffice 转换器不可用。');
      }
      fail(errors.CONVERSION_FAILED, 'LibreOffice 转换失败。');
    }
    if (commandFailed(result)) {
      fail(errors.CONVERSION_FAILED, 'LibreOffice 转换失败。');
    }
    // The caller validates and copies this file before cleanup. Returning a
    // path from a function that removes its parent in `finally` would leave
    // a dangling path and make validation race with cleanup.
    return {
      pdfPath: await listPdfOutputs(outputDirectory),
      temporaryDirectory,
    };
  } catch (error) {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function installCacheFile(sourcePath, targetPath) {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) return;
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await copyFile(sourcePath, temporaryPath);
    await rename(temporaryPath, targetPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => {});
    fail(errors.CACHE_ERROR, '无法写入 PDF 缓存。');
  }
}

async function verifyOriginalCacheHash(originalCachePath, expectedSha256) {
  const cachedHash = await hashFile(originalCachePath);
  if (cachedHash.sha256 !== expectedSha256) {
    fail(errors.INVALID_FILE, '附件在读取期间发生变化。');
  }
}

async function readMetadata(metadataPath) {
  try {
    const raw = await readFile(metadataPath, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function writeMetadata(metadataPath, metadata) {
  const temporaryPath = `${metadataPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, metadataPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => {});
    fail(errors.CACHE_ERROR, '无法写入 PDF 缓存记录。');
  }
}

/**
 * @typedef {Object} PreparedPdf
 * @property {string} originalPath
 * @property {string} pdfPath
 * @property {string} sourceSha256
 * @property {string} pdfSha256
 * @property {number} pageCount
 * @property {boolean} converted
 * @property {boolean} [visualReviewRequired]
 * @property {'pdf-only'|'pdf-and-slide-count'} [conversionValidation]
 * @property {string} [conversionValidationNote]
 * @property {number} [sourceSlideCount]
 */

/** @param {{sourcePath:string,pdfPath:string,sourceSha256:string,pdfSha256:string,pageCount:number,converted:boolean,kind:string,sourceSlideCount?:number}} input */
function resultFor({ sourcePath, pdfPath, sourceSha256, pdfSha256, pageCount, converted, kind, sourceSlideCount }) {
  const result = {
    originalPath: sourcePath,
    pdfPath,
    sourceSha256,
    pdfSha256,
    pageCount,
    converted,
  };
  if (kind !== 'pdf') {
    result.visualReviewRequired = true;
    result.conversionValidation = kind === 'pptx' ? 'pdf-and-slide-count' : 'pdf-only';
    result.conversionValidationNote = kind === 'pptx'
      ? 'PDF 合法性和页数已校验；未执行视觉排版复核。'
      : '旧版 PPT 仅校验 PDF 合法性；未独立校验页数，也未执行视觉排版复核。';
    if (sourceSlideCount !== undefined) result.sourceSlideCount = sourceSlideCount;
  }
  return result;
}

async function tryCache({
  sourcePath,
  originalName,
  sourceSha256,
  originalCachePath,
  pdfCachePath,
  metadataPath,
  kind,
  inspector,
  options,
  timeoutMs,
}) {
  let originalStat;
  try {
    originalStat = await stat(originalCachePath);
  } catch {
    return null;
  }
  if (!originalStat.isFile()) return null;

  // A hit is only valid when the preserved original still represents the
  // exact source content. This prevents a hash-directory entry from being
  // reused after a partial or interrupted copy.
  const originalHash = await hashFile(originalCachePath).catch(() => null);
  if (!originalHash || originalHash.sha256 !== sourceSha256) return null;

  const metadata = await readMetadata(metadataPath);
  if (
    !metadata ||
    metadata.sourceSha256 !== sourceSha256 ||
    metadata.pdfSha256 === undefined ||
    metadata.sourceKind !== kind ||
    metadata.sourceName !== originalName
  ) return null;

  let pdfInfo;
  try {
    pdfInfo = await validatePdf(pdfCachePath, inspector);
  } catch {
    return null;
  }
  const pdfHash = await hashFile(pdfCachePath).catch(() => null);
  if (!pdfHash) return null;
  if (metadata.pdfSha256 !== pdfHash.sha256) return null;
  if (metadata?.pageCount !== undefined && metadata.pageCount !== pdfInfo.pageCount) return null;

  let sourceSlideCount = metadata?.sourceSlideCount;
  if (kind === 'pptx') {
    if (!Number.isInteger(sourceSlideCount) || sourceSlideCount <= 0) {
      try {
        sourceSlideCount = await readPptxSlideCount(sourcePath, options, timeoutMs);
      } catch {
        return null;
      }
    }
    if (sourceSlideCount !== pdfInfo.pageCount) return null;
  }
  return resultFor({
    sourcePath: originalCachePath,
    pdfPath: pdfCachePath,
    sourceSha256,
    pdfSha256: pdfHash.sha256,
    pageCount: pdfInfo.pageCount,
    converted: kind !== 'pdf',
    kind,
    sourceSlideCount,
  });
}

/**
 * @typedef {Object} PreparePdfOptions
 * @property {string} [fileName] Original Blackboard file name when the
 * downloaded temporary path has no extension.
 * @property {string} [sofficePath] Absolute bundled LibreOffice executable.
 * @property {number} [timeoutMs] Conversion timeout, capped at 120 seconds.
 * @property {(pdfPath:string)=>Promise<number|{pageCount:number}>|number|{pageCount:number}} [inspectPdf]
 * @property {(command:string,args:string[],options:Record<string,unknown>)=>Promise<object>|object} [runner]
 * @property {(command:string,args:string[],options:Record<string,unknown>)=>Promise<object>|object} [unzipRunner]
 * @property {string} [unzipPath]
 * @property {number|((sourcePath:string)=>Promise<number|{pageCount:number}>|number|{pageCount:number})} [slideCount]
 * @property {number|((sourcePath:string)=>Promise<number|{pageCount:number}>|number|{pageCount:number})} [inspectSlides]
 * @property {number|((sourcePath:string)=>Promise<number|{pageCount:number}>|number|{pageCount:number})} [readSlideCount]
 */

/**
 * Validate and prepare one Blackboard attachment for deterministic import.
 *
 * `options.inspectPdf` receives a PDF path and returns either a positive page
 * count or `{ pageCount }`. `options.runner` receives `(command, args,
 * runnerOptions)` and must not use a shell. It is intended for tests and for
 * the host's controlled process wrapper. PPT conversion requires an explicit,
 * absolute `options.sofficePath`; this function never searches PATH.
 *
 * @param {string} sourcePath
 * @param {string} cacheDirectory
 * @param {PreparePdfOptions} [options]
 * @returns {Promise<PreparedPdf>}
 */
export async function preparePdf(sourcePath, cacheDirectory, options = {}) {
  const sourceFilePath = asAbsolutePath(sourcePath);
  const cacheRoot = asAbsolutePath(cacheDirectory, errors.CACHE_ERROR);
  const originalName = safeOriginalName(sourceFilePath, options.fileName);
  const kind = extensionKind(originalName);
  const inspector = typeof options.inspectPdf === 'function' ? options.inspectPdf : inspectPdf;

  let sourceStat;
  try {
    sourceStat = await stat(sourceFilePath);
  } catch {
    fail(errors.INVALID_FILE, '附件不存在或无法读取。');
  }
  if (!sourceStat.isFile()) fail(errors.INVALID_FILE, '附件不是普通文件。');
  if (sourceStat.size > MAX_FILE_BYTES) fail(errors.INVALID_FILE, '附件超过 200 MB 限制。');

  // Magic validation happens before hashing or conversion, so an HTML login
  // page saved with a PDF/PPT extension cannot reach LibreOffice.
  validateMagic(kind, await readMagic(sourceFilePath));
  const sourceHash = await hashFile(sourceFilePath);
  if (sourceHash.bytes !== sourceStat.size) {
    fail(errors.INVALID_FILE, '附件在读取期间发生变化。');
  }
  const finalStat = await stat(sourceFilePath).catch(() => null);
  if (!finalStat || !finalStat.isFile() || finalStat.size !== sourceStat.size) {
    fail(errors.INVALID_FILE, '附件在读取期间发生变化。');
  }

  const hashDirectory = path.join(cacheRoot, sourceHash.sha256);
  const originalCachePath = path.join(hashDirectory, originalName);
  const pdfCachePath = path.join(hashDirectory, pdfNameFor(originalName, kind));
  const metadataPath = path.join(hashDirectory, CACHE_METADATA_NAME);
  try {
    await mkdir(hashDirectory, { recursive: true });
  } catch {
    fail(errors.CACHE_ERROR, '无法创建 PDF 缓存目录。');
  }
  const timeoutMs = boundedTimeout(options.timeoutMs);

  const hit = await tryCache({
    sourcePath: originalCachePath,
    originalName,
    sourceSha256: sourceHash.sha256,
    originalCachePath,
    pdfCachePath,
    metadataPath,
    kind,
    inspector,
    options,
    timeoutMs,
  });
  if (hit) return hit;

  if (kind === 'pdf') {
    const pdfInfo = await validatePdf(sourceFilePath, inspector);
    await installCacheFile(sourceFilePath, originalCachePath);
    await verifyOriginalCacheHash(originalCachePath, sourceHash.sha256);
    const cachedInfo = await validatePdf(originalCachePath, inspector);
    const pdfHash = await hashFile(originalCachePath);
    if (cachedInfo.pageCount !== pdfInfo.pageCount) {
      fail(errors.CACHE_ERROR, 'PDF 缓存校验失败。');
    }
    const result = resultFor({
      sourcePath: originalCachePath,
      pdfPath: originalCachePath,
      sourceSha256: sourceHash.sha256,
      pdfSha256: pdfHash.sha256,
      pageCount: cachedInfo.pageCount,
      converted: false,
      kind,
    });
    await writeMetadata(metadataPath, {
      schemaVersion: 1,
      sourceSha256: sourceHash.sha256,
      sourceName: originalName,
      sourceKind: kind,
      pdfSha256: pdfHash.sha256,
      pageCount: cachedInfo.pageCount,
      converted: false,
    });
    return result;
  }

  // Fail with the stable converter error before attempting PPTX metadata
  // inspection when the host did not provide its bundled executable.
  const sofficePath = converterPath(options);
  await ensureDefaultConverterAvailable(sofficePath, Boolean(options.runner));

  // Keep a named copy with the original extension. LibreOffice uses that
  // extension to select its input filter when the browser download path has
  // no extension at all.
  await installCacheFile(sourceFilePath, originalCachePath);
  await verifyOriginalCacheHash(originalCachePath, sourceHash.sha256);
  const sourceSlideCount = kind === 'pptx'
    ? await readPptxSlideCount(originalCachePath, options, timeoutMs)
    : undefined;
  const convertedOutput = await convertWithLibreOffice(originalCachePath, options, timeoutMs);
  try {
    const convertedInfo = await validatePdf(convertedOutput.pdfPath, inspector);
    if (sourceSlideCount !== undefined && convertedInfo.pageCount !== sourceSlideCount) {
      fail(errors.CONVERSION_FAILED, 'PPTX 页数与转换结果不一致。');
    }

    await installCacheFile(convertedOutput.pdfPath, pdfCachePath);
    const cachedInfo = await validatePdf(pdfCachePath, inspector);
    const pdfHash = await hashFile(pdfCachePath);
    if (sourceSlideCount !== undefined && cachedInfo.pageCount !== sourceSlideCount) {
      fail(errors.CONVERSION_FAILED, 'PPTX 页数与缓存结果不一致。');
    }
    const result = resultFor({
      sourcePath: originalCachePath,
      pdfPath: pdfCachePath,
      sourceSha256: sourceHash.sha256,
      pdfSha256: pdfHash.sha256,
      pageCount: cachedInfo.pageCount,
      converted: true,
      kind,
      sourceSlideCount,
    });
    await writeMetadata(metadataPath, {
      schemaVersion: 1,
      sourceSha256: sourceHash.sha256,
      sourceName: originalName,
      sourceKind: kind,
      pdfSha256: pdfHash.sha256,
      pageCount: cachedInfo.pageCount,
      converted: true,
      ...(sourceSlideCount === undefined ? {} : { sourceSlideCount }),
    });
    return result;
  } finally {
    await rm(convertedOutput.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
