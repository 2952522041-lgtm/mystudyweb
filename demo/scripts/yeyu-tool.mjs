import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function parseCommand(args) {
  if (args.length === 1 && args[0] === 'state') {
    return { name: 'yeyu_get_state', arguments: {} };
  }
  if (args.length === 3 && args[0] === 'import' && args[1].trim()
    && path.isAbsolute(args[2]) && path.extname(args[2]).toLowerCase() === '.pdf') {
    return {
      name: 'yeyu_import_pdf',
      arguments: { courseName: args[1], localPath: args[2] },
    };
  }
  throw new Error('用法：node scripts/yeyu-tool.mjs state | import <课程名称> <PDF绝对路径>');
}

export function resultValue(result) {
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  if (result.isError) throw new Error(text || '页语 MCP 返回错误。');
  try { return JSON.parse(text); } catch { return text; }
}

export async function main(args) {
  const command = parseCommand(args);
  const client = new Client({ name: 'yeyu-sync-cli', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../electron/dist/yeyu-mcp.js', import.meta.url))],
    env: { ...process.env },
  });
  let timer;
  let polling = false;
  const started = Date.now();
  try {
    await client.connect(transport);
    if (command.name === 'yeyu_import_pdf') {
      // Progress queries are read-only; never retry a timed-out mutation here.
      timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const state = resultValue(await client.callTool({ name: 'yeyu_get_state', arguments: {} }, undefined, { timeout: 20000 }));
          console.error(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), progress: state.courseLibrary?.importProgress ?? null }));
        } catch {
          console.error('暂时无法读取导入进度；原导入调用仍在等待，未重复提交。');
        } finally { polling = false; }
      }, 15000);
    }
    const result = resultValue(await client.callTool(command, undefined, {
      timeout: command.name === 'yeyu_import_pdf' ? 31 * 60 * 1000 : 20000,
    }));
    console.log(JSON.stringify({ elapsedSeconds: (Date.now() - started) / 1000, result }));
  } finally {
    clearInterval(timer);
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
