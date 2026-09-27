import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { YeyuMcpCommandName } from './api.ts';

export const MCP_MAX_PDF_BYTES = 128 * 1024 * 1024;

/**
 * Resolve the one intentionally writable MCP operation. Only a real, regular
 * PDF file is read; arbitrary file bytes and the source path are never exposed
 * through the general renderer bridge.
 */
export async function prepareMcpRendererArgs(
  name: YeyuMcpCommandName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name !== 'import_pdf') return args;
  const localPath = args.localPath;
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
    throw new Error('localPath 必须是 PDF 的绝对路径。');
  }
  if (path.extname(localPath).toLowerCase() !== '.pdf') {
    throw new Error('只能通过 MCP 导入 .pdf 文件。');
  }
  const stat = await fs.lstat(localPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error('localPath 不存在、不是普通文件或是符号链接。');
  }
  if (stat.size > MCP_MAX_PDF_BYTES) {
    throw new Error('PDF 超过 128 MiB，拒绝通过 MCP 载入。');
  }
  const data = await fs.readFile(localPath);
  if (data.subarray(0, 1024).indexOf('%PDF-') < 0) {
    throw new Error('文件内容不是有效的 PDF。');
  }
  const safeArgs = { ...args };
  delete safeArgs.localPath;
  return {
    ...safeArgs,
    fileName: path.basename(localPath),
    fileLastModified: Math.trunc(stat.mtimeMs),
    fileData: new Uint8Array(data),
  };
}
