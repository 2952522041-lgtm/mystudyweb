import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  errors,
  preparePdf,
} from '../scripts/blackboard/files.mjs';

type RunnerOptions = {
  shell?: boolean;
  [key: string]: unknown;
};

type RunnerResult = {
  stdout?: string | Uint8Array;
  exitCode?: number;
};

type Runner = (
  command: string,
  args: string[],
  options: RunnerOptions,
) => Promise<RunnerResult>;

function makePdf(pageCount = 1) {
  const pageObjects = Array.from({ length: pageCount }, (_, index) => `${3 + index} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () =>
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>'),
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text, 'latin1'));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(text, 'latin1');
  text += `xref\n0 ${objects.length + 1}\n`;
  text += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

function fileHash(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'blackboard-files-test-'));
}

async function assertError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  });
}

void test('valid PDF is parsed without rendering, cached by content hash, and never replaced', async () => {
  const root = await temporaryDirectory();
  try {
    const sourcePath = path.join(root, 'lecture.pdf');
    const cacheDirectory = path.join(root, 'cache');
    const source = makePdf();
    await writeFile(sourcePath, source);

    const first = await preparePdf(sourcePath, cacheDirectory);
    assert.equal(first.originalPath, path.join(cacheDirectory, fileHash(source), 'lecture.pdf'));
    assert.equal(first.pageCount, 1);
    assert.equal(first.converted, false);
    assert.equal(first.sourceSha256, fileHash(source));
    assert.equal(first.pdfSha256, fileHash(source));
    assert.equal(first.pdfPath, first.originalPath);
    assert.deepEqual(await readFile(sourcePath), source);

    const second = await preparePdf(sourcePath, cacheDirectory);
    assert.deepEqual(second, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('HTML saved with a supported extension is rejected before conversion', async () => {
  const root = await temporaryDirectory();
  try {
    const sourcePath = path.join(root, 'login.pdf');
    await writeFile(sourcePath, '<!doctype html><html><body>login</body></html>');
    await assertError(preparePdf(sourcePath, path.join(root, 'cache')), errors.INVALID_FILE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('PPTX conversion uses an isolated no-shell runner, checks slide count, and reuses the cache', async () => {
  const root = await temporaryDirectory();
  try {
    const sourcePath = path.join(root, 'download-without-extension');
    const cacheDirectory = path.join(root, 'cache');
    const sofficePath = '/bundled/libreoffice/soffice';
    const source = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fixture-v1')]);
    await writeFile(sourcePath, source);
    let conversions = 0;
    let unzipCalls = 0;
    const runner: Runner = async (command, args, runnerOptions) => {
      assert.equal(runnerOptions.shell, false);
      if (command === 'unzip') {
        unzipCalls += 1;
        assert.equal(args[0], '-p');
        assert.ok(args[1]);
        assert.match(args[1], /Lecture 1\.pptx$/);
        return { stdout: '<p:sldIdLst><p:sldId id="1"/><p:sldId id="2"/></p:sldIdLst>', exitCode: 0 };
      }
      assert.equal(command, sofficePath);
      conversions += 1;
      const outputDirectory = args[args.indexOf('--outdir') + 1];
      assert.ok(outputDirectory);
      const profileArgument = args.find((argument) => argument.startsWith('-env:UserInstallation='));
      assert.ok(profileArgument);
      assert.match(profileArgument, /^-env:UserInstallation=file:\/\//);
      await writeFile(path.join(outputDirectory, 'slides.pdf'), makePdf(2));
      return { exitCode: 0 };
    };

    const first = await preparePdf(sourcePath, cacheDirectory, {
      fileName: 'Lecture 1.pptx',
      sofficePath,
      runner,
    });
    assert.equal(first.pageCount, 2);
    assert.equal(first.converted, true);
    assert.match(first.originalPath, /Lecture 1\.pptx$/);
    assert.match(first.pdfPath, /Lecture 1\.pdf$/);
    assert.equal(first.sourceSlideCount, 2);
    assert.equal(first.visualReviewRequired, true);
    assert.equal(first.conversionValidation, 'pdf-and-slide-count');
    assert.equal(conversions, 1);
    assert.equal(unzipCalls, 1);

    const second = await preparePdf(sourcePath, cacheDirectory, {
      fileName: 'Lecture 1.pptx',
      sofficePath,
      runner,
    });
    assert.deepEqual(second, first);
    assert.equal(conversions, 1);
    assert.equal(unzipCalls, 1);

    await unlink(path.join(cacheDirectory, first.sourceSha256, 'metadata.json'));
    const rebuilt = await preparePdf(sourcePath, cacheDirectory, {
      fileName: 'Lecture 1.pptx',
      sofficePath,
      runner,
    });
    assert.equal(rebuilt.converted, true);
    assert.equal(conversions, 2);

    await writeFile(sourcePath, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fixture-v2')]));
    const changed = await preparePdf(sourcePath, cacheDirectory, {
      fileName: 'Lecture 1.pptx',
      sofficePath,
      runner,
    });
    assert.equal(changed.converted, true);
    assert.notEqual(changed.sourceSha256, first.sourceSha256);
    assert.equal(conversions, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('legacy PPT reports the PDF-only conversion limitation and requires an explicit converter path', async () => {
  const root = await temporaryDirectory();
  try {
    const sourcePath = path.join(root, 'legacy-download');
    await writeFile(sourcePath, Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('fixture'),
    ]));
    await assertError(preparePdf(sourcePath, path.join(root, 'missing-cache'), { fileName: 'legacy.ppt' }), errors.CONVERTER_UNAVAILABLE);

    const runner: Runner = async (command, args) => {
      assert.equal(command, '/bundled/libreoffice/soffice');
      await writeFile(path.join(args[args.indexOf('--outdir') + 1], 'legacy.pdf'), makePdf());
      return { exitCode: 0 };
    };
    const result = await preparePdf(sourcePath, path.join(root, 'cache'), {
      fileName: 'legacy.ppt',
      sofficePath: '/bundled/libreoffice/soffice',
      runner,
    });
    assert.equal(result.visualReviewRequired, true);
    assert.equal(result.conversionValidation, 'pdf-only');
    assert.ok(result.conversionValidationNote);
    assert.match(result.conversionValidationNote, /仅校验 PDF 合法性/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('PPTX page-count mismatch is a conversion failure and does not publish a cache', async () => {
  const root = await temporaryDirectory();
  try {
    const sourcePath = path.join(root, 'mismatch-download');
    const cacheDirectory = path.join(root, 'cache');
    await writeFile(sourcePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
    const runner: Runner = async (_command, args) => {
      const outputDirectory = args[args.indexOf('--outdir') + 1];
      assert.ok(outputDirectory);
      await writeFile(path.join(outputDirectory, 'mismatch.pdf'), makePdf());
      return { exitCode: 0 };
    };
    await assertError(preparePdf(sourcePath, cacheDirectory, {
      fileName: 'mismatch.pptx',
      sofficePath: '/bundled/libreoffice/soffice',
      runner,
      inspectSlides: () => 2,
    }), errors.CONVERSION_FAILED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
