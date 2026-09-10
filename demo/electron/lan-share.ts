import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { LanShareStatus } from './api.ts';
import { readCourseFile, scanCourses } from './workspace.ts';
import type { DesktopCourseManifest, DesktopCourseSummary } from './api.ts';
import {
  assertSafeRelativeSegments,
  WorkspacePathError,
  type WorkspaceLayout,
} from './workspace-paths.ts';

export const DEFAULT_LAN_SHARE_PORT = 37891;
export const LAN_SHARE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_BODY_BYTES = 4096;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_BLOCK_MS = 30 * 1000;
const MAX_LOGIN_FAILURES = 5;
const SESSION_COOKIE = 'yeyu_share_session';

interface LoginAttempt {
  failures: number;
  resetAt: number;
  blockedUntil: number;
}

interface ShareSession {
  expiresAt: number;
}

interface LanShareOptions {
  sessionTtlMs?: number;
  now?: () => number;
  /** Tests can use loopback; production leaves this at the LAN-facing default. */
  host?: string;
}

interface ShareDocument {
  id: string;
  fileName: string;
  storedFileName: string;
  pageCount: number;
  status: string;
  includedInCourse: boolean;
  hasSummary: boolean;
  hasMindmap: boolean;
  importedAt: string;
  updatedAt: string;
}

interface ShareCourse {
  directoryName: string;
  manifest: DesktopCourseManifest;
  documents: ShareDocument[];
}

function jsonHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.statusCode = statusCode;
  for (const [name, valueForHeader] of Object.entries(jsonHeaders())) {
    response.setHeader(name, valueForHeader);
  }
  for (const [name, valueForHeader] of Object.entries(extraHeaders)) {
    response.setHeader(name, valueForHeader);
  }
  response.end(JSON.stringify(value));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  response.statusCode = statusCode;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(message);
}

function sendEmpty(
  response: ServerResponse,
  statusCode: number,
  extraHeaders: Record<string, string> = {},
): void {
  response.statusCode = statusCode;
  for (const [name, valueForHeader] of Object.entries(extraHeaders)) {
    response.setHeader(name, valueForHeader);
  }
  response.end();
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function decodePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes('/') && !decoded.includes('\\')
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; HttpOnly; SameSite=Strict`;
}

/** 只返回实际由 IPv4 监听器覆盖的非回环地址。 */
export function getLanShareAddresses(
  port: number,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4') continue;
      const url = `http://${entry.address}:${port}/share?yeyu-share=1`;
      if (!addresses.includes(url)) addresses.push(url);
    }
  }
  return addresses.sort((a, b) => a.localeCompare(b));
}

function safeHeaderFileName(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integerValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : fallback;
}

function publicSources(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source) => {
    if (!isRecord(source)) return [];
    const type = source.type === 'conversation' ? 'conversation' : 'pdf';
    const result: Record<string, unknown> = {
      documentId: stringValue(source.documentId),
      fileName: stringValue(source.fileName),
      pageStart: integerValue(source.pageStart, 1),
      type,
    };
    if (Number.isInteger(source.pageEnd)) result.pageEnd = source.pageEnd;
    return [result];
  });
}

function publicDigest(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const sections = Array.isArray(value.sections)
    ? value.sections.flatMap((section) => {
        if (!isRecord(section)) return [];
        return [
          {
            id: stringValue(section.id),
            title: stringValue(section.title),
            summary: stringValue(section.summary),
            pageStart: integerValue(section.pageStart, 1),
            pageEnd: integerValue(section.pageEnd, 1),
          },
        ];
      })
    : [];
  const concepts = Array.isArray(value.concepts)
    ? value.concepts.flatMap((concept) => {
        if (!isRecord(concept)) return [];
        return [
          {
            id: stringValue(concept.id),
            label: stringValue(concept.label),
            description: stringValue(concept.description),
            sources: publicSources(concept.sources),
          },
        ];
      })
    : [];
  const relations = Array.isArray(value.relations)
    ? value.relations.flatMap((relation) => {
        if (!isRecord(relation)) return [];
        return [
          {
            from: stringValue(relation.from),
            to: stringValue(relation.to),
            label: stringValue(relation.label),
          },
        ];
      })
    : [];
  return {
    schemaVersion: value.schemaVersion === 1 ? 1 : 2,
    documentId: stringValue(value.documentId),
    fingerprint: stringValue(value.fingerprint),
    title: stringValue(value.title),
    overview: stringValue(value.overview),
    sections,
    concepts,
    relations,
    unresolvedQuestions: Array.isArray(value.unresolvedQuestions)
      ? value.unresolvedQuestions.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    sourcePages: Array.isArray(value.sourcePages)
      ? value.sourcePages.filter((item): item is number =>
          Number.isInteger(item),
        )
      : [],
    promptVersion: stringValue(value.promptVersion),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    updatedAt: stringValue(value.updatedAt),
  };
}

function publicKnowledge(
  value: unknown,
  manifest: DesktopCourseManifest,
): Record<string, unknown> {
  if (!isRecord(value)) return defaultKnowledge(manifest);
  const kinds = new Set(['course', 'concept', 'insight', 'question']);
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.flatMap((node) => {
        if (!isRecord(node)) return [];
        return [
          {
            id: stringValue(node.id),
            label: stringValue(node.label),
            description: stringValue(node.description),
            kind: kinds.has(String(node.kind)) ? node.kind : 'concept',
            ownership: node.ownership === 'user' ? 'user' : 'generated',
            sources: publicSources(node.sources),
          },
        ];
      })
    : [];
  const relations = Array.isArray(value.relations)
    ? value.relations.flatMap((relation) => {
        if (!isRecord(relation)) return [];
        return [
          {
            from: stringValue(relation.from),
            to: stringValue(relation.to),
            label: stringValue(relation.label),
          },
        ];
      })
    : [];
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts.flatMap((conflict) => {
        if (!isRecord(conflict)) return [];
        return [
          {
            id: stringValue(conflict.id),
            nodeId: stringValue(conflict.nodeId),
            descriptions: Array.isArray(conflict.descriptions)
              ? conflict.descriptions.filter(
                  (item): item is string => typeof item === 'string',
                )
              : [],
            sources: publicSources(conflict.sources),
          },
        ];
      })
    : [];
  return {
    schemaVersion: value.schemaVersion === 1 ? 1 : 2,
    courseId: stringValue(value.courseId, manifest.id),
    version: integerValue(value.version),
    nodes,
    relations,
    conflicts,
    unresolvedQuestions: Array.isArray(value.unresolvedQuestions)
      ? value.unresolvedQuestions.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    updatedAt: stringValue(value.updatedAt, manifest.updatedAt),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.promptVersion === 'string'
      ? { promptVersion: value.promptVersion }
      : {}),
  };
}

function isShareDocument(value: unknown): value is ShareDocument {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.storedFileName === 'string' &&
    typeof value.pageCount === 'number' &&
    typeof value.status === 'string' &&
    typeof value.includedInCourse === 'boolean' &&
    typeof value.hasSummary === 'boolean' &&
    typeof value.hasMindmap === 'boolean' &&
    typeof value.importedAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function defaultKnowledge(
  manifest: DesktopCourseManifest,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    courseId: manifest.id,
    version: 0,
    nodes: [
      {
        id: `course:${manifest.id}`,
        label: manifest.name,
        description: '课程尚未纳入可展示的资料成果。',
        kind: 'course',
        ownership: 'generated',
        sources: [],
      },
    ],
    relations: [],
    conflicts: [],
    unresolvedQuestions: [],
    updatedAt: manifest.updatedAt,
  };
}

/**
 * Read a bundled client asset only when every path component is a real entry.
 * This protects both direct file links and a linked directory inside the
 * static output; lexical path checks alone would still follow either link.
 */
async function readStaticFile(
  rootDirectory: string,
  relativeSegments: string[],
): Promise<Buffer> {
  let segments: string[];
  try {
    segments = assertSafeRelativeSegments(relativeSegments);
  } catch (error) {
    throw error instanceof WorkspacePathError
      ? error
      : new WorkspacePathError('PATH_ESCAPE', '禁止访问。');
  }
  const rootStat = await fs.lstat(rootDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkspacePathError('PATH_ESCAPE', '共享页面资源目录不合法。');
  }
  let current = rootDirectory;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new WorkspacePathError(
        'PATH_ESCAPE',
        '共享页面资源包含符号链接，已拒绝访问。',
      );
    }
  }
  const targetStat = await fs.lstat(current);
  if (!targetStat.isFile()) {
    throw new WorkspacePathError('COURSE_NOT_FOUND', '页面资源不存在。');
  }
  return fs.readFile(current);
}

async function readJson(
  layout: WorkspaceLayout,
  directoryName: string,
  relativePath: string[],
): Promise<unknown> {
  const data = await readCourseFile(
    layout.coursesRoot,
    directoryName,
    relativePath,
  );
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

function publicManifest(
  manifest: DesktopCourseManifest,
  documents: ShareDocument[],
): DesktopCourseManifest {
  // Only the existing course manifest fields are returned. No settings, cache,
  // browser storage, conversation records, or credentials enter this object.
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    revision: manifest.revision,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    activeKnowledgeVersion: manifest.activeKnowledgeVersion,
    documents,
  };
}

export class LanShareServer {
  private readonly layout: WorkspaceLayout;
  private readonly clientDirectory: string;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly host: string;
  private server: http.Server | null = null;
  private passwordHash: Buffer | null = null;
  private passwordSalt: Buffer | null = null;
  private port: number | null = null;
  private sessions = new Map<string, ShareSession>();
  private loginAttempts = new Map<string, LoginAttempt>();

  constructor(
    layout: WorkspaceLayout,
    clientDirectory: string,
    options: LanShareOptions = {},
  ) {
    this.layout = layout;
    this.clientDirectory = path.resolve(clientDirectory);
    this.sessionTtlMs = options.sessionTtlMs ?? LAN_SHARE_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.host = options.host ?? '0.0.0.0';
  }

  getStatus(): LanShareStatus {
    if (!this.server || this.port === null) {
      return { running: false, port: null, addresses: [] };
    }
    return {
      running: true,
      port: this.port,
      addresses: getLanShareAddresses(this.port),
    };
  }

  async start(
    password: string,
    requestedPort = DEFAULT_LAN_SHARE_PORT,
  ): Promise<LanShareStatus> {
    if (this.server) throw new Error('局域网共享已经开启。');
    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('访问密码至少需要 6 个字符，不能无密码开放资料。');
    }
    if (
      !Number.isInteger(requestedPort) ||
      requestedPort < 0 ||
      requestedPort > 65535 ||
      (requestedPort > 0 && requestedPort < 1024)
    ) {
      throw new Error('端口必须是 1024–65535 之间的整数。');
    }
    const clientIndex = await fs
      .stat(path.join(this.clientDirectory, 'index.html'))
      .catch(() => null);
    if (!clientIndex?.isFile()) {
      throw new Error('共享页面资源不可用，请先完成桌面端构建。');
    }

    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    const server = http.createServer((request, response) => {
      applySecurityHeaders(response);
      void this.handleRequest(request, response).catch(() => {
        if (!response.headersSent)
          sendText(response, 500, '共享服务暂时无法处理请求。');
        else response.destroy();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requestedPort, this.host);
      });
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(`端口 ${requestedPort} 已被占用，请换一个端口后重试。`);
      }
      throw new Error(
        `局域网共享启动失败：${error instanceof Error ? error.message : '无法绑定端口'}。`,
      );
    }

    const address = server.address();
    const actualPort =
      typeof address === 'object' && address ? address.port : requestedPort;
    this.server = server;
    this.passwordSalt = salt;
    this.passwordHash = hash;
    this.port = actualPort;
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    this.loginAttempts.clear();
    this.passwordHash = null;
    this.passwordSalt = null;
    this.port = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private isAuthenticated(request: IncomingMessage): boolean {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private clientAddress(request: IncomingMessage): string {
    return request.socket.remoteAddress ?? 'unknown';
  }

  private loginBlocked(address: string): number {
    const now = this.now();
    const attempt = this.loginAttempts.get(address);
    if (!attempt) return 0;
    if (attempt.resetAt <= now) {
      this.loginAttempts.delete(address);
      return 0;
    }
    return Math.max(0, attempt.blockedUntil - now);
  }

  private registerLoginFailure(address: string): number {
    const now = this.now();
    const existing = this.loginAttempts.get(address);
    const attempt =
      !existing || existing.resetAt <= now
        ? { failures: 0, resetAt: now + LOGIN_WINDOW_MS, blockedUntil: 0 }
        : existing;
    attempt.failures += 1;
    if (attempt.failures >= MAX_LOGIN_FAILURES) {
      attempt.blockedUntil = now + LOGIN_BLOCK_MS;
    }
    this.loginAttempts.set(address, attempt);
    return Math.max(0, attempt.blockedUntil - now);
  }

  private passwordMatches(password: string): boolean {
    if (!this.passwordHash || !this.passwordSalt) return false;
    const candidate = scryptSync(
      password,
      this.passwordSalt,
      this.passwordHash.byteLength,
    );
    return timingSafeEqual(candidate, this.passwordHash);
  }

  private async requestBody(request: IncomingMessage): Promise<Buffer> {
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (contentLength > MAX_LOGIN_BODY_BYTES) throw new Error('请求内容过大。');
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      request.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_LOGIN_BODY_BYTES) {
          reject(new Error('请求内容过大。'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }

  private async handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      sendText(response, 405, '只支持 POST。');
      return;
    }
    const address = this.clientAddress(request);
    const blockedMs = this.loginBlocked(address);
    if (blockedMs > 0) {
      sendJson(
        response,
        429,
        { error: '尝试次数过多，请稍后再试。' },
        {
          'Retry-After': String(Math.ceil(blockedMs / 1000)),
        },
      );
      return;
    }
    let password: unknown;
    try {
      password = (
        JSON.parse((await this.requestBody(request)).toString('utf8')) as {
          password?: unknown;
        }
      ).password;
    } catch {
      sendJson(response, 400, { error: '登录请求格式不正确。' });
      return;
    }
    if (typeof password !== 'string' || !this.passwordMatches(password)) {
      const retryMs = this.registerLoginFailure(address);
      if (retryMs > 0) {
        sendJson(
          response,
          429,
          { error: '尝试次数过多，请稍后再试。' },
          {
            'Retry-After': String(Math.ceil(retryMs / 1000)),
          },
        );
      } else {
        sendJson(response, 401, { error: '访问密码错误。' });
      }
      return;
    }
    this.loginAttempts.delete(address);
    const token = randomBytes(32).toString('hex');
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(token, { expiresAt });
    sendJson(
      response,
      200,
      { authenticated: true, expiresAt },
      {
        'Set-Cookie': sessionCookie(token, this.sessionTtlMs / 1000),
      },
    );
  }

  private handleLogout(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (request.method !== 'POST') {
      sendText(response, 405, '只支持 POST。');
      return;
    }
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) this.sessions.delete(token);
    sendEmpty(response, 204, { 'Set-Cookie': sessionCookie('', 0) });
  }

  private requireAuth(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    if (this.isAuthenticated(request)) return true;
    sendJson(response, 401, { error: '请先登录局域网共享。' });
    return false;
  }

  private async findCourse(courseId: string): Promise<ShareCourse | null> {
    const courses = await scanCourses(this.layout.coursesRoot);
    const matched = courses.find((course) => course.manifest.id === courseId);
    if (!matched) return null;
    const documents = matched.manifest.documents.filter(isShareDocument);
    return {
      directoryName: matched.directoryName,
      manifest: publicManifest(matched.manifest, documents),
      documents,
    };
  }

  private async readKnowledge(course: ShareCourse): Promise<unknown> {
    const activePath = [
      'Knowledge',
      `knowledge-v${course.manifest.activeKnowledgeVersion}.json`,
    ];
    try {
      return publicKnowledge(
        await readJson(this.layout, course.directoryName, activePath),
        course.manifest,
      );
    } catch {
      try {
        return publicKnowledge(
          await readJson(this.layout, course.directoryName, ['课程脑图.json']),
          course.manifest,
        );
      } catch {
        return defaultKnowledge(course.manifest);
      }
    }
  }

  private async readDigest(
    course: ShareCourse,
    document: ShareDocument,
  ): Promise<unknown> {
    if (!document.hasSummary && !document.hasMindmap) return null;
    try {
      return publicDigest(
        await readJson(this.layout, course.directoryName, [
          'Documents',
          document.id,
          'document.json',
        ]),
      );
    } catch {
      return null;
    }
  }

  private async handleCourseApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method !== 'GET') {
      sendText(response, 405, '只支持 GET。');
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(3);
    const courseId = decodePathSegment(parts[0]);
    if (!courseId) {
      sendJson(response, 404, { error: '课程不存在，可能已被删除。' });
      return;
    }
    if (parts.length === 1) {
      const course = await this.findCourse(courseId);
      if (!course) {
        sendJson(response, 404, { error: '课程不存在，可能已被删除。' });
        return;
      }
      const digests: Record<string, unknown> = {};
      for (const document of course.documents) {
        const digest = await this.readDigest(course, document);
        if (digest !== null) digests[document.id] = digest;
      }
      sendJson(response, 200, {
        manifest: course.manifest,
        knowledge: await this.readKnowledge(course),
        digests,
      });
      return;
    }

    if (
      parts[1] === 'artifacts' &&
      (parts[2] === 'course-summary' || parts[2] === 'course-mindmap')
    ) {
      const course = await this.findCourse(courseId);
      if (!course) {
        sendJson(response, 404, { error: '课程不存在，可能已被删除。' });
        return;
      }
      sendJson(response, 200, { knowledge: await this.readKnowledge(course) });
      return;
    }

    if (parts[1] !== 'documents' || !parts[2]) {
      sendJson(response, 404, { error: '资料接口不存在。' });
      return;
    }
    const course = await this.findCourse(courseId);
    if (!course) {
      sendJson(response, 404, { error: '课程不存在，可能已被删除。' });
      return;
    }
    const documentId = decodePathSegment(parts[2]);
    if (!documentId) {
      sendJson(response, 404, { error: '这份 PDF 不存在，可能已被删除。' });
      return;
    }
    const document = course.documents.find((item) => item.id === documentId);
    if (!document) {
      sendJson(response, 404, { error: '这份 PDF 不存在，可能已被删除。' });
      return;
    }
    if (parts[3] === 'file') {
      try {
        const data = await readCourseFile(
          this.layout.coursesRoot,
          course.directoryName,
          ['PDFs', document.storedFileName],
        );
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/pdf');
        response.setHeader('Content-Length', String(data.byteLength));
        response.setHeader(
          'Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(safeHeaderFileName(document.fileName))}`,
        );
        response.end(data);
      } catch {
        sendJson(response, 404, {
          error: 'PDF 文件暂时不存在或正在更新，请刷新后重试。',
        });
      }
      return;
    }
    if (
      parts[3] === 'artifacts' &&
      (parts[4] === 'summary' || parts[4] === 'mindmap')
    ) {
      const digest = await this.readDigest(course, document);
      const wantsSummary = parts[4] === 'summary';
      if (
        !digest ||
        (wantsSummary ? !document.hasSummary : !document.hasMindmap)
      ) {
        sendJson(response, 404, { error: '这份 PDF 尚未生成该成果。' });
        return;
      }
      sendJson(
        response,
        200,
        wantsSummary
          ? { digest }
          : isRecord(digest)
            ? {
                nodes: digest.concepts ?? [],
                relations: digest.relations ?? [],
              }
            : { nodes: [], relations: [] },
      );
      return;
    }
    sendJson(response, 404, { error: '资料接口不存在。' });
  }

  private async serveClient(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, '只支持 GET。');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendText(response, 403, '禁止访问。');
      return;
    }
    const relativeSegments =
      decoded === '/' || decoded === '/share' || decoded === '/share/'
        ? ['index.html']
        : decoded.replace(/^\/+/, '').split('/');
    let filePath: string;
    try {
      // Keep the lexical boundary check in assertSafeRelativeSegments and the
      // lstat walk in readStaticFile: neither pathname normalization nor
      // fs.stat alone prevents a linked asset from escaping the bundle.
      assertSafeRelativeSegments(relativeSegments);
      filePath = path.resolve(this.clientDirectory, ...relativeSegments);
      if (
        filePath === this.clientDirectory ||
        !filePath.startsWith(this.clientDirectory + path.sep)
      ) {
        sendText(response, 403, '禁止访问。');
        return;
      }
    } catch {
      sendText(response, 403, '禁止访问。');
      return;
    }
    let data: Buffer;
    try {
      data = await readStaticFile(this.clientDirectory, relativeSegments);
    } catch (error) {
      if (error instanceof WorkspacePathError && error.code === 'PATH_ESCAPE') {
        sendText(response, 403, '禁止访问。');
      } else {
        sendText(response, 404, '页面不存在。');
      }
      return;
    }
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader(
      'Content-Type',
      {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
        '.woff2': 'font/woff2',
        '.png': 'image/png',
      }[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    );
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(data);
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/share/login') {
      await this.handleLogin(request, response);
      return;
    }
    if (url.pathname === '/api/share/logout') {
      this.handleLogout(request, response);
      return;
    }
    if (url.pathname === '/api/share/session') {
      if (!this.requireAuth(request, response)) return;
      const token = parseCookie(request.headers.cookie, SESSION_COOKIE)!;
      const session = this.sessions.get(token)!;
      sendJson(response, 200, {
        authenticated: true,
        expiresAt: session.expiresAt,
      });
      return;
    }
    if (url.pathname.startsWith('/api/share/courses')) {
      if (!this.requireAuth(request, response)) return;
      if (url.pathname === '/api/share/courses') {
        if (request.method !== 'GET') {
          sendText(response, 405, '只支持 GET。');
          return;
        }
        const courses = await scanCourses(this.layout.coursesRoot);
        sendJson(response, 200, {
          courses: courses.map((course: DesktopCourseSummary) => ({
            id: course.manifest.id,
            name: course.manifest.name,
            updatedAt: course.manifest.updatedAt,
            documentCount: Array.isArray(course.manifest.documents)
              ? course.manifest.documents.length
              : 0,
          })),
        });
        return;
      }
      await this.handleCourseApi(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: '接口不存在。' });
      return;
    }
    await this.serveClient(request, response, url.pathname);
  }
}
