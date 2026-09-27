import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { YeyuMcpCommandName } from './api.ts';

export const MCP_CONTROL_FILE_NAME = 'mcp-control.json';
const MAX_BODY_BYTES = 64 * 1024;

export interface McpControlDescriptor {
  version: 1;
  port: number;
  token: string;
  pid: number;
  updatedAt: string;
}

export interface McpControlRequest {
  name: YeyuMcpCommandName;
  args: Record<string, unknown>;
}

export type McpCommandDispatcher = (
  request: McpControlRequest,
) => Promise<unknown>;

export interface McpControlServerOptions {
  settingsRoot: string;
  dispatch: McpCommandDispatcher;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('请求内容过大。');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parseRequest(value: unknown): McpControlRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('命令必须是 JSON 对象。');
  }
  const candidate = value as { name?: unknown; args?: unknown };
  if (typeof candidate.name !== 'string' || !candidate.name) {
    throw new Error('命令名称不合法。');
  }
  if (
    candidate.args === null ||
    typeof candidate.args !== 'object' ||
    Array.isArray(candidate.args)
  ) {
    throw new Error('命令参数必须是 JSON 对象。');
  }
  return {
    name: candidate.name as YeyuMcpCommandName,
    args: candidate.args as Record<string, unknown>,
  };
}

/**
 * Electron 内部的短生命周期 HTTP 控制端点。它只绑定 127.0.0.1，并用每次
 * 启动随机生成的 bearer token 鉴权；token 仅写入工作区 Settings 下的
 * 0600 描述文件，renderer 永远看不到它。
 */
export class McpControlServer {
  readonly descriptorPath: string;

  #server: http.Server | null = null;
  #descriptor: McpControlDescriptor | null = null;
  #dispatch: McpCommandDispatcher;

  constructor(options: McpControlServerOptions) {
    this.descriptorPath = path.join(
      options.settingsRoot,
      MCP_CONTROL_FILE_NAME,
    );
    this.#dispatch = options.dispatch;
  }

  async start(): Promise<McpControlDescriptor> {
    if (this.#descriptor) return this.#descriptor;
    const token = randomBytes(32).toString('base64url');
    const server = http.createServer((request, response) => {
      void this.#handle(request, response, token);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('无法确定 MCP 控制端口。');
    }

    const descriptor: McpControlDescriptor = {
      version: 1,
      port: address.port,
      token,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    const temporaryPath = `${this.descriptorPath}.tmp-${process.pid}`;
    try {
      await fs.mkdir(path.dirname(this.descriptorPath), { recursive: true });
      await fs.writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.descriptorPath);
      await fs.chmod(this.descriptorPath, 0o600).catch(() => undefined);
    } catch (error) {
      server.close();
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    this.#server = server;
    this.#descriptor = descriptor;
    return descriptor;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    const descriptor = this.#descriptor;
    this.#server = null;
    this.#descriptor = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!descriptor) return;
    const stored = await fs
      .readFile(this.descriptorPath, 'utf8')
      .catch(() => '');
    try {
      const parsed = JSON.parse(stored) as Partial<McpControlDescriptor>;
      if (parsed.token === descriptor.token) {
        await fs.rm(this.descriptorPath, { force: true });
      }
    } catch {
      // A damaged or already replaced descriptor does not belong to this server.
    }
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/command') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (bearerToken(request) !== token) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const command = parseRequest(await readJsonBody(request));
      const result = await this.#dispatch(command);
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
