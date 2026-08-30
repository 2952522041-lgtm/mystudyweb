import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'public', 'pdf.worker.min.mjs');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(workerPath, target);
console.log('pdf.js worker copied to public/pdf.worker.min.mjs');
