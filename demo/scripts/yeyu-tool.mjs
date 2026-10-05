import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const IMPORT_CALL_TIMEOUT_MS = 31 * 60 * 1000;
export const IMPORT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
export const STATE_CALL_TIMEOUT_MS = 20 * 1000;
export const IMPORT_POLL_INTERVAL_MS = 15 * 1000;
export const PDF_IMPORT_FAILED_MESSAGE = 'PDF已保存，后台整理失败';

const USAGE =
  '用法：node scripts/yeyu-tool.mjs state | import [--wait] <课程名称> <PDF绝对路径>';

function isAbsoluteLocalPath(value) {
  // Keep the CLI compatible with a Windows path passed to a client running on
  // another platform, just like the MCP server's input schema.
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\/]+[\\/]/.test(value)
  );
}

function usageError() {
  throw new Error(USAGE);
}

export function parseCommand(args) {
  if (!Array.isArray(args)) usageError();
  if (args.length === 1 && args[0] === 'state') {
    return { name: 'yeyu_get_state', arguments: {} };
  }

  const waitFlags = args.filter((arg) => arg === '--wait').length;
  if (waitFlags > 1) usageError();
  const positional = args.filter((arg) => arg !== '--wait');
  if (
    positional.length === 3 &&
    positional[0] === 'import' &&
    typeof positional[1] === 'string' &&
    positional[1].trim() &&
    typeof positional[2] === 'string' &&
    isAbsoluteLocalPath(positional[2]) &&
    path.extname(positional[2]).toLowerCase() === '.pdf'
  ) {
    const command = {
      name: 'yeyu_import_pdf',
      arguments: { courseName: positional[1], localPath: positional[2] },
    };
    if (waitFlags === 1) command.wait = true;
    return command;
  }
  usageError();
}

export function resultValue(result) {
  const text =
    result.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n') ?? '';
  if (result.isError) throw new Error(text || '页语 MCP 返回错误。');
  if (!text && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function processingStatus(processing) {
  const value = record(processing);
  if (!value) return undefined;
  return nonEmptyString(value.status);
}

export function inspectProcessing(processing) {
  if (processing === undefined || processing === null) {
    return { kind: 'none' };
  }
  const value = record(processing);
  if (!value) {
    throw new Error('页语返回的 processing 状态格式无效。');
  }
  const status = processingStatus(value);
  if (status === 'queued' || status === 'running') {
    return { kind: 'active', status, processing: value };
  }
  if (status === 'paused' || status === 'cancelled' || status === 'review') {
    return { kind: status, status, processing: value };
  }
  if (status === 'failed') {
    return {
      kind: 'failed',
      status,
      error: nonEmptyString(value.error),
      processing: value,
    };
  }
  throw new Error('页语返回了未知的 processing 状态。');
}

function stateCourseLibrary(state) {
  const root = record(state);
  if (!root) return null;
  const nested = record(root.courseLibrary);
  return nested ?? root;
}

function courseIdOf(course) {
  const value = record(course);
  return nonEmptyString(value?.id) ?? nonEmptyString(value?.courseId);
}

function courseNameOf(course) {
  const value = record(course);
  return nonEmptyString(value?.name) ?? nonEmptyString(value?.courseName);
}

function documentIdOf(document) {
  const value = record(document);
  return nonEmptyString(value?.id) ?? nonEmptyString(value?.documentId);
}

function documentFileNameOf(document) {
  const value = record(document);
  return nonEmptyString(value?.fileName) ?? nonEmptyString(value?.name);
}

function sameCourse(course, details) {
  const id = courseIdOf(course);
  const name = courseNameOf(course);
  if (details.courseId && id !== details.courseId) return false;
  if (details.courseName && name !== details.courseName) return false;
  return Boolean(id || name);
}

function sameDocument(document, details) {
  const id = documentIdOf(document);
  const fileName = documentFileNameOf(document);
  if (details.documentId) return id === details.documentId;
  return Boolean(details.fileName && fileName === details.fileName);
}

/** Locate the document returned by import_pdf in a get_state response. */
export function findImportDocument(state, details) {
  const library = stateCourseLibrary(state);
  const courses = Array.isArray(library?.courses) ? library.courses : [];
  const course = courses.find((candidate) => sameCourse(candidate, details));
  if (!course) return undefined;
  const documents = Array.isArray(course.documents) ? course.documents : [];
  return documents.find((candidate) => sameDocument(candidate, details));
}

function importDetails(importResult) {
  const value = record(importResult);
  if (!value) {
    throw new Error('页语返回的导入结果格式无效。');
  }
  const details = {
    courseId: nonEmptyString(value.courseId),
    courseName: nonEmptyString(value.courseName),
    fileName: nonEmptyString(value.fileName),
    documentId: nonEmptyString(value.documentId),
    processing: value.processing,
  };
  if (!details.courseId && !details.courseName) {
    throw new Error('页语导入结果缺少 courseId/courseName。');
  }
  if (!details.fileName) {
    throw new Error('页语导入结果缺少 fileName。');
  }
  return details;
}

export function importResultProcessing(importResult) {
  return inspectProcessing(importDetails(importResult).processing);
}

function importFailureError(error) {
  return nonEmptyString(error) ?? PDF_IMPORT_FAILED_MESSAGE;
}

function interruptedImportMessage(status) {
  if (status === 'review') return 'PDF 和候选成果已保存，课程更新等待审阅；请在页语课程页接受更新或保留原成果。';
  if (status === 'paused')
    return 'PDF已保存，后台整理已暂停；已完成成果保留，可在页语「后台任务」中继续。';
  if (status === 'cancelled')
    return 'PDF已保存，后台整理已取消；已完成成果保留，可在页语「后台任务」中重试。';
  return undefined;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Poll only read-only get_state calls after an import has been accepted. This
 * helper never calls import_pdf, so a state read failure or timeout cannot
 * accidentally submit the same PDF twice.
 */
export async function waitForImportCompletion({
  importResult,
  getState,
  timeoutMs = IMPORT_WAIT_TIMEOUT_MS,
  intervalMs = IMPORT_POLL_INTERVAL_MS,
  now = Date.now,
  sleep = delay,
  onProgress,
}) {
  const details = importDetails(importResult);
  const initial = inspectProcessing(details.processing);
  if (initial.kind === 'none') {
    return { status: 'completed', source: 'import-result' };
  }
  if (initial.kind === 'paused' || initial.kind === 'cancelled' || initial.kind === 'review') {
    return { status: initial.status, source: 'import-result' };
  }
  if (initial.kind === 'failed') {
    return {
      status: 'failed',
      error: importFailureError(initial.error),
      source: 'import-result',
    };
  }
  if (!details.documentId) {
    throw new Error('导入已排队但缺少 documentId；原导入已提交，未重复导入。');
  }
  if (typeof getState !== 'function') {
    throw new Error('缺少 get_state 轮询函数；原导入已提交，未重复导入。');
  }

  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  while (true) {
    let state;
    try {
      state = await getState();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法读取后台整理状态：${detail}；原导入已提交，未重复导入。`,
        { cause: error },
      );
    }

    let document;
    let current;
    try {
      document = findImportDocument(state, details);
      if (!document) {
        throw new Error('get_state 中找不到已导入的 documentId。');
      }
      current = inspectProcessing(record(document).processing);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}；原导入已提交，未重复导入。`, {
        cause: error,
      });
    }
    if (current.kind === 'none') {
      return { status: 'completed', source: 'state', state, document };
    }
    if (current.kind === 'paused' || current.kind === 'cancelled' || current.kind === 'review') {
      return { status: current.status, source: 'state', state, document };
    }
    if (current.kind === 'failed') {
      return {
        status: 'failed',
        error: importFailureError(current.error),
        source: 'state',
        state,
        document,
      };
    }
    onProgress?.(current, document, state);
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error('等待后台整理超时；原导入已提交，未重复导入。');
    }
    await sleep(Math.min(Math.max(0, intervalMs), remaining));
  }
}

function defaultImportMessage(importResult) {
  const processing = importResultProcessing(importResult);
  if (processing.kind === 'active') {
    return 'PDF已保存，后台整理已排队；本次返回仅表示已入队，不表示 AI 总结、脑图或课程合并已完成。';
  }
  if (processing.kind === 'failed') return PDF_IMPORT_FAILED_MESSAGE;
  const interrupted = interruptedImportMessage(processing.status);
  if (interrupted) return interrupted;
  return 'PDF已保存，当前没有后台整理任务；成果状态请查看文档标记。';
}

function createClient() {
  return new Client({ name: 'yeyu-sync-cli', version: '1.0.0' });
}

function createTransport() {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../electron/dist/yeyu-mcp.js', import.meta.url)),
    ],
    env: { ...process.env },
  });
}

export async function main(args, dependencies = {}) {
  const command = parseCommand(args);
  const client = dependencies.createClient?.() ?? createClient();
  const transport = dependencies.createTransport?.() ?? createTransport();
  const log = dependencies.log ?? console.log;
  const errorLog = dependencies.errorLog ?? console.error;
  const started = Date.now();
  try {
    await client.connect(transport);
    // `--wait` is a CLI-only control flag; never forward it as an MCP
    // request property or alter the tool's established argument contract.
    const request = { name: command.name, arguments: command.arguments };
    const result = resultValue(
      await client.callTool(request, undefined, {
        timeout:
          command.name === 'yeyu_import_pdf'
            ? IMPORT_CALL_TIMEOUT_MS
            : STATE_CALL_TIMEOUT_MS,
      }),
    );
    let completion;

    if (command.name === 'yeyu_import_pdf') {
      const processing = importResultProcessing(result);
      if (processing.kind === 'failed') {
        errorLog(PDF_IMPORT_FAILED_MESSAGE);
        throw new Error(importFailureError(processing.error));
      }
      if (command.wait) {
        completion = await waitForImportCompletion({
          importResult: result,
          getState: async () =>
            resultValue(
              await client.callTool(
                { name: 'yeyu_get_state', arguments: {} },
                undefined,
                { timeout: STATE_CALL_TIMEOUT_MS },
              ),
            ),
          onProgress: undefined,
          ...dependencies.waitOptions,
        });
        if (completion.status === 'failed') {
          errorLog(PDF_IMPORT_FAILED_MESSAGE);
          throw new Error(importFailureError(completion.error));
        }
        if (completion.status === 'completed') {
          errorLog(
            completion.source === 'state'
              ? 'PDF已保存，后台整理已完成。'
              : 'PDF已保存，当前没有后台整理任务；成果状态请查看文档标记。',
          );
        }
      } else {
        errorLog(defaultImportMessage(result));
      }
    }

    const output = {
      elapsedSeconds: (Date.now() - started) / 1000,
      result,
      ...(completion
        ? {
            completion: {
              status: completion.status,
              ...(completion.document ? { document: completion.document } : {}),
            },
          }
        : {}),
    };
    log(JSON.stringify(output));
    // Keep the machine-readable stopped status, then let the CLI entry point
    // report it on stderr and exit nonzero. Never resume or reimport here.
    const interrupted = interruptedImportMessage(completion?.status);
    if (interrupted) throw new Error(interrupted);
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
