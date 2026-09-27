import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loopbackFetch } from './loopback-fetch.ts';

const CONTROL_FILE_ENV = 'YEYU_MCP_CONTROL_FILE';
const WORKSPACE_ROOT_ENV = 'YEYU_WORKSPACE_ROOT';
const XDG_CONFIG_HOME_ENV = 'XDG_CONFIG_HOME';
const MAX_ERROR_BODY_LENGTH = 300;

export const YEYU_MCP_SERVER_INFO = {
  name: 'yeyu-mcp',
  version: '0.1.0',
} as const;

export interface McpControlDescriptor {
  version: 1;
  port: number;
  token: string;
  pid: number;
  updatedAt: string;
}

export interface CommandRequest {
  name: string;
  args: Record<string, unknown>;
}

export class YeyuMcpBridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'YeyuMcpBridgeError';
  }
}

export interface ResolveControlPathOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

function trailingXdgCommentIsValid(value: string): boolean {
  return /^\s*(?:#.*)?$/.test(value);
}

/** Parse one user-dirs.dirs value without evaluating shell syntax. */
function parseXdgValue(rawValue: string): string | undefined {
  const raw = rawValue.trim();
  if (!raw) return undefined;

  if (raw.startsWith('"')) {
    let value = '';
    let escaped = false;
    let closingQuote = -1;
    for (let index = 1; index < raw.length; index += 1) {
      const character = raw[index];
      if (escaped) {
        if (character !== '"' && character !== '\\') return undefined;
        value += character;
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        closingQuote = index;
        break;
      } else {
        value += character;
      }
    }
    if (closingQuote < 0 || escaped) return undefined;
    return trailingXdgCommentIsValid(raw.slice(closingQuote + 1))
      ? value
      : undefined;
  }

  if (raw.startsWith("'")) {
    const closingQuote = raw.indexOf("'", 1);
    if (
      closingQuote < 0 ||
      !trailingXdgCommentIsValid(raw.slice(closingQuote + 1))
    ) {
      return undefined;
    }
    return raw.slice(1, closingQuote);
  }

  const unquoted = raw.match(/^[^\s#]+/u)?.[0];
  if (!unquoted || !trailingXdgCommentIsValid(raw.slice(unquoted.length))) {
    return undefined;
  }
  return unquoted;
}

function expandXdgHome(
  value: string,
  homeDirectory: string,
): string | undefined {
  let expanded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$') {
      expanded += value[index];
      continue;
    }
    if (value.startsWith('${HOME}', index)) {
      expanded += homeDirectory;
      index += '${HOME}'.length - 1;
      continue;
    }
    if (value.startsWith('$HOME', index)) {
      expanded += homeDirectory;
      index += '$HOME'.length - 1;
      continue;
    }
    return undefined;
  }
  return expanded;
}

function parseXdgDocumentsDirectory(
  contents: string,
  homeDirectory: string,
): string | undefined {
  for (const line of contents.split(/\r?\n/u)) {
    const assignment = line.match(/^\s*XDG_DOCUMENTS_DIR\s*=\s*(.*)$/u);
    if (!assignment) continue;
    const parsed = parseXdgValue(assignment[1]);
    if (parsed === undefined) return undefined;
    const expanded = expandXdgHome(parsed, homeDirectory);
    if (
      expanded === undefined ||
      expanded.length === 0 ||
      !path.isAbsolute(expanded) ||
      Array.from(expanded).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
      })
    ) {
      return undefined;
    }
    return path.normalize(expanded);
  }
  return undefined;
}

function resolveLinuxDocumentsDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string {
  const configuredPath = environment[XDG_CONFIG_HOME_ENV]?.trim();
  const configDirectory =
    configuredPath && path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(homeDirectory, '.config');
  const configPath = path.join(configDirectory, 'user-dirs.dirs');

  let contents: string;
  try {
    contents = readFileSync(configPath, 'utf8');
  } catch {
    return path.join(homeDirectory, 'Documents');
  }
  return (
    parseXdgDocumentsDirectory(contents, homeDirectory) ??
    path.join(homeDirectory, 'Documents')
  );
}

/** Resolve the descriptor in the same precedence order as the desktop app. */
export function resolveControlFilePath({
  environment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
}: ResolveControlPathOptions = {}): string {
  const explicitPath = environment[CONTROL_FILE_ENV]?.trim();
  if (explicitPath) return path.resolve(explicitPath);

  const workspaceRoot = environment[WORKSPACE_ROOT_ENV]?.trim();
  if (workspaceRoot) {
    return path.resolve(workspaceRoot, 'Settings', 'mcp-control.json');
  }

  const documentsDirectory =
    platform === 'linux'
      ? resolveLinuxDocumentsDirectory(environment, homeDirectory)
      : path.join(homeDirectory, 'Documents');
  return path.join(
    documentsDirectory,
    '页语工作区',
    'Settings',
    'mcp-control.json',
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseControlDescriptor(
  value: unknown,
  descriptorPath: string,
): McpControlDescriptor {
  const schema = z
    .object({
      version: z.literal(1),
      port: z.number().int().min(1).max(65_535),
      token: z.string().min(1),
      pid: z.number().int().min(0),
      updatedAt: z.string().min(1),
    })
    .strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new YeyuMcpBridgeError(
      `页语 MCP 控制文件格式无效：${descriptorPath}。请重新启动页语桌面端。`,
    );
  }
  return parsed.data;
}

export async function readControlDescriptor(
  descriptorPath = resolveControlFilePath(),
): Promise<McpControlDescriptor> {
  let raw: string;
  try {
    raw = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    throw new YeyuMcpBridgeError(
      `无法读取页语 MCP 控制文件：${descriptorPath}。请确认页语桌面端正在运行。`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new YeyuMcpBridgeError(
      `页语 MCP 控制文件不是有效 JSON：${descriptorPath}。请重新启动页语桌面端。`,
      { cause: error },
    );
  }

  return parseControlDescriptor(parsed, descriptorPath);
}

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface InvokeCommandOptions extends ResolveControlPathOptions {
  controlFilePath?: string;
  fetchImplementation?: FetchImplementation;
}

function responseBodyPreview(body: string): string {
  const compact = body.trim().replace(/\s+/g, ' ');
  if (!compact) return '';
  return compact.slice(0, MAX_ERROR_BODY_LENGTH);
}

function isSuccessfulResponse(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

function unwrapCommandResult(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'result')
  ) {
    return (value as { result: unknown }).result;
  }
  return value;
}

/** Send one authenticated command to the Electron loopback control endpoint. */
export async function invokeElectronCommand(
  name: string,
  args: Record<string, unknown>,
  options: InvokeCommandOptions = {},
): Promise<unknown> {
  if (!name.trim()) {
    throw new YeyuMcpBridgeError('页语 MCP 命令名称不能为空。');
  }

  const descriptorPath =
    options.controlFilePath ?? resolveControlFilePath(options);
  const descriptor = await readControlDescriptor(descriptorPath);
  const fetchImplementation = options.fetchImplementation ?? loopbackFetch;
  const url = `http://127.0.0.1:${descriptor.port}/command`;
  const request: CommandRequest = { name, args };

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw new YeyuMcpBridgeError(
      `无法连接页语控制桥：${describeError(error)}。请确认页语桌面端正在运行。`,
      { cause: error },
    );
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new YeyuMcpBridgeError(
      `无法读取页语控制桥的响应（HTTP ${response.status}）。`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    const status = response.status ? `（HTTP ${response.status}）` : '';
    throw new YeyuMcpBridgeError(
      `页语控制桥返回了无效 JSON${status}。请重试；若持续失败，请重新启动页语桌面端。`,
      { cause: error },
    );
  }

  if (!isSuccessfulResponse(response)) {
    const detail =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { error?: unknown }).error
        : responseBodyPreview(body);
    const detailText =
      typeof detail === 'string' ? detail : JSON.stringify(detail);
    const suffix = detailText ? `：${detailText}` : '';
    throw new YeyuMcpBridgeError(
      `页语控制桥请求失败（HTTP ${response.status}）${suffix}`,
    );
  }

  return unwrapCommandResult(parsed);
}

const emptyArgsSchema = z.object({}).strict();

function locatorTextSchema() {
  return z.string().trim().min(1);
}

function hasCourseLocator(value: {
  courseId?: string;
  courseName?: string;
}): boolean {
  return Boolean(value.courseId || value.courseName);
}

function hasDocumentLocator(value: {
  documentId?: string;
  fileName?: string;
}): boolean {
  return Boolean(value.documentId || value.fileName);
}

export const yeyuGetStateArgsSchema = emptyArgsSchema;
export const yeyuShowCoursesArgsSchema = emptyArgsSchema;

export const yeyuOpenCourseArgsSchema = z
  .object({
    courseId: locatorTextSchema().optional(),
    courseName: locatorTextSchema().optional(),
  })
  .strict()
  .refine(hasCourseLocator, {
    message: '请提供 courseId 或 courseName。',
  });

export const yeyuOpenDocumentArgsSchema = z
  .object({
    courseId: locatorTextSchema().optional(),
    courseName: locatorTextSchema().optional(),
    documentId: locatorTextSchema().optional(),
    fileName: locatorTextSchema().optional(),
    page: z.number().int().positive().optional(),
  })
  .strict()
  .refine(hasCourseLocator, {
    message: '请提供 courseId 或 courseName。',
  })
  .refine(hasDocumentLocator, {
    message: '请提供 documentId 或 fileName。',
  });

export const yeyuGoToPageArgsSchema = z
  .object({
    page: z.number().int().positive(),
  })
  .strict();

export const yeyuSetReaderPanelArgsSchema = z
  .object({
    panel: z.enum(['translation', 'chat', 'summary', 'mindmap']),
  })
  .strict();

export function isAbsoluteLocalPath(value: string): boolean {
  // Keep validation portable for descriptors produced on Windows while still
  // accepting POSIX paths when the MCP server runs on Linux/macOS.
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\/]+[\\/]/.test(value)
  );
}

export const yeyuImportPdfArgsSchema = z
  .object({
    localPath: locatorTextSchema().refine(isAbsoluteLocalPath, {
      message: 'localPath 必须是本机 PDF 的绝对路径。',
    }),
    courseId: locatorTextSchema().optional(),
    courseName: locatorTextSchema().optional(),
    generateSummary: z.boolean().default(true),
    generateMindmap: z.boolean().default(true),
    mergeIntoCourse: z.boolean().default(true),
  })
  .strict()
  .refine(hasCourseLocator, {
    message: '请提供 courseId 或 courseName。',
  });

export const YEYU_TOOL_COMMANDS = {
  yeyu_get_state: 'get_state',
  yeyu_show_courses: 'show_courses',
  yeyu_open_course: 'open_course',
  yeyu_open_document: 'open_document',
  yeyu_go_to_page: 'go_to_page',
  yeyu_set_reader_panel: 'set_reader_panel',
  yeyu_import_pdf: 'import_pdf',
} as const;

export type YeyuToolName = keyof typeof YEYU_TOOL_COMMANDS;
export type CommandInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface CreateServerOptions extends InvokeCommandOptions {
  invokeCommand?: CommandInvoker;
}

type ToolCallResult = {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
};

// Refinements are intentionally kept in the exported validation schemas above.
// The SDK cannot render a top-level ZodEffects schema into JSON Schema, so the
// advertised schemas use the equivalent structural shape and the handler runs
// the refined schema once more before dispatching.
const openCourseInputSchema = z
  .object({
    courseId: z.string().min(1).optional(),
    courseName: z.string().min(1).optional(),
  })
  .strict();
const openDocumentInputSchema = z
  .object({
    courseId: z.string().min(1).optional(),
    courseName: z.string().min(1).optional(),
    documentId: z.string().min(1).optional(),
    fileName: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
  })
  .strict();
const importPdfInputSchema = z
  .object({
    localPath: z.string().min(1).describe('本机 PDF 的绝对路径。'),
    courseId: z.string().min(1).optional(),
    courseName: z.string().min(1).optional(),
    generateSummary: z.boolean().default(true),
    generateMindmap: z.boolean().default(true),
    mergeIntoCourse: z.boolean().default(true),
  })
  .strict();

function jsonToolResult(value: unknown): ToolCallResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value) ?? 'null',
      },
    ],
  };
}

function errorToolResult(error: unknown): ToolCallResult {
  const message =
    error instanceof YeyuMcpBridgeError
      ? error.message
      : `页语控制桥调用失败：${describeError(error)}`;
  console.error(`[yeyu-mcp] ${message}`, error);
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function registerCommandTool(
  server: McpServer,
  toolName: string,
  commandName: string,
  description: string,
  inputSchema: z.ZodTypeAny,
  validationSchema: z.ZodTypeAny,
  invokeCommand: CommandInvoker,
): void {
  server.registerTool(
    toolName,
    { description, inputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const parsed = validationSchema.safeParse(args);
        if (!parsed.success) {
          const details = parsed.error.issues
            .map((issue) => issue.message)
            .join('；');
          return errorToolResult(
            new YeyuMcpBridgeError(`页语工具参数无效：${details}`),
          );
        }
        return jsonToolResult(
          await invokeCommand(
            commandName,
            parsed.data as Record<string, unknown>,
          ),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );
}

export function createYeyuMcpServer(
  options: CreateServerOptions = {},
): McpServer {
  const invokeCommand =
    options.invokeCommand ??
    ((name: string, args: Record<string, unknown>) =>
      invokeElectronCommand(name, args, options));
  const server = new McpServer(YEYU_MCP_SERVER_INFO, {
    instructions:
      '页语本地课程阅读器控制工具。命令会通过本机已认证的页语桌面端执行。',
  });

  registerCommandTool(
    server,
    'yeyu_get_state',
    YEYU_TOOL_COMMANDS.yeyu_get_state,
    '获取页语当前课程、文档、阅读页码和右侧阅读面板状态。',
    yeyuGetStateArgsSchema,
    yeyuGetStateArgsSchema,
    invokeCommand,
  );
  registerCommandTool(
    server,
    'yeyu_show_courses',
    YEYU_TOOL_COMMANDS.yeyu_show_courses,
    '在页语窗口中显示课程库。',
    yeyuShowCoursesArgsSchema,
    yeyuShowCoursesArgsSchema,
    invokeCommand,
  );
  registerCommandTool(
    server,
    'yeyu_open_course',
    YEYU_TOOL_COMMANDS.yeyu_open_course,
    '打开页语中的一门课程；必须提供 courseId 或 courseName。',
    openCourseInputSchema,
    yeyuOpenCourseArgsSchema,
    invokeCommand,
  );
  registerCommandTool(
    server,
    'yeyu_open_document',
    YEYU_TOOL_COMMANDS.yeyu_open_document,
    '打开课程中的 PDF 文档；课程必须用 courseId/courseName 之一定位，文档必须用 documentId/fileName 之一定位，可选 page 为正整数。',
    openDocumentInputSchema,
    yeyuOpenDocumentArgsSchema,
    invokeCommand,
  );
  registerCommandTool(
    server,
    'yeyu_go_to_page',
    YEYU_TOOL_COMMANDS.yeyu_go_to_page,
    '在当前 PDF 阅读器跳转到指定页码；page 必须是正整数。',
    yeyuGoToPageArgsSchema,
    yeyuGoToPageArgsSchema,
    invokeCommand,
  );
  registerCommandTool(
    server,
    'yeyu_set_reader_panel',
    YEYU_TOOL_COMMANDS.yeyu_set_reader_panel,
    '切换页语阅读器右侧面板：translation、chat、summary 或 mindmap。',
    yeyuSetReaderPanelArgsSchema,
    yeyuSetReaderPanelArgsSchema,
    invokeCommand,
  );
  registerCommandTool(
    server,
    'yeyu_import_pdf',
    YEYU_TOOL_COMMANDS.yeyu_import_pdf,
    '读取本机 PDF 并写入页语课程，课程必须用 courseId 或 courseName 定位。每份新 PDF 都会调用已配置的知识库 AI 建立内部摘要，扫描件还可能调用 OCR，因此可能产生费用；默认另行生成可见总结和脑图并合并课程。',
    importPdfInputSchema,
    yeyuImportPdfArgsSchema,
    invokeCommand,
  );

  return server;
}

export interface StartServerOptions {
  server?: McpServer;
  stdin?: Readable;
  stdout?: Writable;
}

export async function startYeyuMcpServer({
  server = createYeyuMcpServer(),
  stdin = process.stdin,
  stdout = process.stdout,
}: StartServerOptions = {}): Promise<void> {
  const transport = new StdioServerTransport(stdin, stdout);
  transport.onerror = (error) => {
    console.error('[yeyu-mcp] stdio 传输错误：', error);
  };
  await server.connect(transport);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  const currentModulePath =
    typeof __filename === 'string'
      ? __filename
      : fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === path.resolve(currentModulePath);
}

if (isDirectExecution()) {
  void startYeyuMcpServer().catch((error: unknown) => {
    console.error('[yeyu-mcp] 启动失败：', error);
    process.exitCode = 1;
  });
}
