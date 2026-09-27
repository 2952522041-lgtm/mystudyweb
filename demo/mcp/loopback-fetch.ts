import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

const LOOPBACK_HOST = '127.0.0.1';

/** Leave a little headroom over Electron's 30-minute import command timeout. */
export const LOOPBACK_REQUEST_TIMEOUT_MS = 31 * 60 * 1_000;

function assertLoopbackUrl(input: string | URL): URL {
  const url = typeof input === 'string' ? new URL(input) : input;
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOOPBACK_HOST ||
    url.username ||
    url.password
  ) {
    throw new TypeError('页语 MCP 控制桥只允许访问 127.0.0.1。');
  }
  return url;
}

async function encodeRequestBody(
  body: BodyInit | null | undefined,
): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new TypeError('页语 MCP 控制桥不支持此请求体类型。');
}

function requestHeaders(
  initHeaders: HeadersInit | undefined,
  bodyLength: number,
): Record<string, string> {
  const headers = new Headers(initHeaders);
  if (bodyLength > 0 && !headers.has('content-length')) {
    headers.set('content-length', String(bodyLength));
  }
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

function responseHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function abortError(): Error {
  const error = new Error('页语 MCP 请求已取消。');
  error.name = 'AbortError';
  return error;
}

function timeoutError(): Error {
  return new Error('页语 MCP 控制桥请求超过 31 分钟。');
}

/**
 * Minimal fetch-compatible client for the authenticated local bridge.
 * The URL is validated before constructing the request, and no proxy or
 * external host can be reached through this implementation.
 */
export async function loopbackFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = assertLoopbackUrl(input);
  const body = await encodeRequestBody(init.body);
  const headers = requestHeaders(init.headers, body.length);
  const signal = init.signal;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const state: {
      request?: ReturnType<typeof httpRequest>;
      timer?: ReturnType<typeof setTimeout>;
    } = {};
    let abortListener: (() => void) | undefined;

    const cleanup = () => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const rejectRequest = (error: unknown) => {
      settle(() => reject(error));
    };
    const abortRequest = () => {
      const error = abortError();
      state.request?.destroy(error);
      rejectRequest(error);
    };

    if (signal?.aborted) {
      rejectRequest(abortError());
      return;
    }

    state.timer = setTimeout(() => {
      const error = timeoutError();
      state.request?.destroy(error);
      rejectRequest(error);
    }, LOOPBACK_REQUEST_TIMEOUT_MS);

    try {
      const request = httpRequest(
        {
          hostname: LOOPBACK_HOST,
          port: url.port ? Number(url.port) : 80,
          path: `${url.pathname || '/'}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('aborted', () => {
            rejectRequest(new Error('页语 MCP 控制桥连接被中断。'));
          });
          response.on('error', rejectRequest);
          response.on('end', () => {
            try {
              const status = response.statusCode ?? 502;
              const result = new Response(
                status === 204 || status === 205 || status === 304
                  ? null
                  : Buffer.concat(chunks),
                {
                  status,
                  statusText: response.statusMessage,
                  headers: responseHeaders(response.headers),
                },
              );
              settle(() => resolve(result));
            } catch (error) {
              rejectRequest(error);
            }
          });
        },
      );
      state.request = request;
      request.on('error', rejectRequest);
      request.setTimeout(LOOPBACK_REQUEST_TIMEOUT_MS, () => {
        const error = timeoutError();
        state.request?.destroy(error);
        rejectRequest(error);
      });

      if (signal) {
        abortListener = abortRequest;
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          abortRequest();
          return;
        }
      }

      if (body.length > 0) request.write(body);
      request.end();
    } catch (error) {
      state.request?.destroy();
      rejectRequest(error);
    }
  });
}
