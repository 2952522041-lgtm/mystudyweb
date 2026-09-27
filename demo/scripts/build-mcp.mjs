import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const demoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputDirectory = path.join(demoRoot, 'electron', 'dist');
const outputPath = path.join(outputDirectory, 'yeyu-mcp.js');

await mkdir(outputDirectory, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(demoRoot, 'mcp', 'server.ts')],
  outfile: outputPath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'silent',
});
await chmod(outputPath, 0o755);
console.error(`build:mcp wrote ${outputPath}`);
