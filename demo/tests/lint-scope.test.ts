import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  scripts: { lint: string; test: string };
};

void test('the standard test command limits file concurrency before its file arguments', () => {
  const args = packageJson.scripts.test.split(/\s+/);
  assert.ok(args.indexOf('--test-concurrency=1') > 0);
  assert.ok(args.indexOf('--test-concurrency=1') < args.indexOf('tests/*.test.ts'));
});

void test('lint scans components, keeps errors blocking and limits legacy warnings to named files and rules', async () => {
  const [command, ...scopes] = packageJson.scripts.lint.split(/\s+/);
  assert.equal(command, 'oxlint');
  assert.deepEqual(new Set(scopes), new Set(['app', 'components', 'lib', 'tests', 'electron']));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeyu-lint-scope-'));
  type Diagnostic = { code: string; severity: string; filename: string };
  const lint = () => new Promise<{ code: number; diagnostics: Diagnostic[] }>((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'node_modules/oxlint/bin/oxlint'), ...scopes, '--format', 'json'],
      { cwd: directory, timeout: 30000 }, (error, stdout, stderr) => {
        if (error && error.code !== 1) { reject(error); return; }
        try {
          assert.equal(stderr, '');
          resolve({ code: error ? 1 : 0, diagnostics: JSON.parse(stdout).diagnostics });
        } catch (parseError) { reject(parseError); }
      });
  });
  try {
    await copyFile(path.join(root, '.oxlintrc.json'), path.join(directory, '.oxlintrc.json'));
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: ['react'],
    } }));
    for (const scope of scopes) {
      await mkdir(path.join(directory, scope));
      await writeFile(path.join(directory, scope, 'empty.ts'), 'export {};\n');
    }
    const fresh = path.join(directory, 'components', 'new-component.tsx');
    const legacy = path.join(directory, 'components', 'course-library.tsx');
    const status = 'export const Status = () => <div role="status">Ready</div>;\n';
    const unsafeType = 'export const value: any = 1;\n';
    await writeFile(fresh, status + unsafeType);
    const newFile = await lint();
    assert.equal(newFile.code, 1);
    assert.ok(newFile.diagnostics.some((item) => item.code === 'jsx-a11y(prefer-tag-over-role)' && item.severity === 'error'));
    assert.ok(newFile.diagnostics.some((item) => item.code === 'typescript(no-explicit-any)' && item.severity === 'error'));

    await rename(fresh, legacy);
    const existingFile = await lint();
    assert.equal(existingFile.code, 1, 'an unrelated error must still block a file with legacy warnings');
    assert.ok(existingFile.diagnostics.some((item) => item.code === 'jsx-a11y(prefer-tag-over-role)' && item.severity === 'warning'));
    assert.ok(existingFile.diagnostics.some((item) => item.code === 'typescript(no-explicit-any)' && item.severity === 'error'));

    await writeFile(legacy, status);
    const warningOnly = await lint();
    assert.equal(warningOnly.code, 0);
    assert.equal(warningOnly.diagnostics.length, 1);
    assert.equal(warningOnly.diagnostics[0].severity, 'warning', 'legacy diagnostics must remain visible');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
