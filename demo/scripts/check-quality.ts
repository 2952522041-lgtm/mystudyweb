import { open } from 'node:fs/promises';
import { evaluateQualityCase } from '../lib/quality-evaluation.ts';

// Explicit local input only: this command never discovers documents or calls AI.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error('用法：pnpm quality:check <人工标注的案例.json>');
  const file = await open(args[0], 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error('案例必须是 8 MiB 以内的 JSON 文件。');
    const report = evaluateQualityCase(JSON.parse(await file.readFile('utf8')));
    console.log(JSON.stringify(report, null, 2));
    console.error(
      '已生成字面覆盖与格式诊断；关键词命中不代表语义正确，仍需对照原页人工核验。',
    );
  } finally {
    await file.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : '无法检查质量案例。');
  process.exitCode = 1;
});
