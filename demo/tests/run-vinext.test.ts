import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_COMPLETE_MARKER,
  hasBuildArtifacts,
  shouldTolerateExit,
} from '../scripts/run-vinext.mjs';

void test('empty or missing dist/client is not a successful build', async () => {
  const missing = path.join(tmpdir(), `yeyu-no-dist-${Date.now()}`);
  assert.equal(await hasBuildArtifacts(missing), false);
  const empty = await mkdtemp(path.join(tmpdir(), 'yeyu-empty-dist-'));
  try {
    assert.equal(await hasBuildArtifacts(empty), false);
    await writeFile(path.join(empty, 'index.html'), '<html></html>');
    assert.equal(await hasBuildArtifacts(empty), true);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

void test('only a post-success exit crash with real artifacts is tolerated', async () => {
  const clientDir = await mkdtemp(path.join(tmpdir(), 'yeyu-tolerate-'));
  try {
    await mkdir(clientDir, { recursive: true });
    // 没有产物：即使日志说构建完成也不容忍。
    assert.equal(
      await shouldTolerateExit(3221226505, BUILD_COMPLETE_MARKER, clientDir),
      false,
    );
    await writeFile(path.join(clientDir, 'index.html'), '<html></html>');
    // 有产物 + 成功标志：容忍已知的 win32 libuv 退出崩溃。
    assert.equal(
      await shouldTolerateExit(3221226505, 'xxx\nBuild complete. Run `vinext start`\n', clientDir),
      true,
    );
    // 没有成功标志：真实失败，必须透传。
    assert.equal(
      await shouldTolerateExit(1, 'Error: build failed', clientDir),
      false,
    );
    // 退出码 0/null 本来就是正常流程，不进入容忍逻辑。
    assert.equal(await shouldTolerateExit(0, BUILD_COMPLETE_MARKER, clientDir), false);
    assert.equal(await shouldTolerateExit(null, BUILD_COMPLETE_MARKER, clientDir), false);
  } finally {
    await rm(clientDir, { recursive: true, force: true });
  }
});
