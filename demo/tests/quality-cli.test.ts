import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';

void test('offline quality command emits a labelled report and requires explicit local input', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/check-quality.ts', ...args],
      { cwd: root, encoding: 'utf8' },
    );
  const result = run('tests/fixtures/quality-example.json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.provenance, 'synthetic');
  assert.equal(report.manualReviewRequired, true);
  assert.equal(report.metrics.factMatches, 1);
  assert.equal(report.metrics.formulaMatches, 1);
  assert.equal(report.issues.length, 0);
  assert.match(result.stderr, /不代表语义正确/);
  assert.notEqual(run().status, 0);
  assert.notEqual(run('missing-case.json').status, 0);
});
