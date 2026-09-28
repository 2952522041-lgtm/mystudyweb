import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { verifySandboxHelper } from '../scripts/check-linux-sandbox.mjs';

const bundledPath = '/opt/yeyu/chrome-sandbox.bundled';
const helperPath = '/usr/lib/yeyu/chrome-sandbox';
const bundledBytes = Buffer.from('chromium sandbox helper\n');

type Kind = 'file' | 'directory' | 'symlink';

type FixtureStat = {
  kind: Kind;
  uid: number;
  gid: number;
  mode: number;
};

type Fixture = {
  stats: Map<string, FixtureStat>;
  contents: Map<string, Uint8Array>;
  fsstat: (targetPath: string) => Promise<FixtureStat>;
  read: (targetPath: string) => AsyncGenerator<Uint8Array>;
};

function fixture(
  overrides: Record<string, Partial<FixtureStat>> = {},
): Fixture {
  const defaultDirectory: FixtureStat = {
    kind: 'directory',
    uid: 0,
    gid: 0,
    mode: 0o755,
  };
  const stats = new Map<string, FixtureStat>([
    [bundledPath, { kind: 'file', uid: 1000, gid: 1000, mode: 0o755 }],
    [helperPath, { kind: 'file', uid: 0, gid: 0, mode: 0o4755 }],
    ['/usr/lib/yeyu', { kind: 'directory', uid: 0, gid: 0, mode: 0o775 }],
  ]);
  for (const [targetPath, patch] of Object.entries(overrides)) {
    stats.set(targetPath, {
      ...(stats.get(targetPath) ?? defaultDirectory),
      ...patch,
    });
  }

  const contents = new Map<string, Uint8Array>([
    [bundledPath, bundledBytes],
    [helperPath, bundledBytes],
  ]);
  return {
    stats,
    contents,
    fsstat: async (targetPath) => stats.get(targetPath) ?? defaultDirectory,
    read: async function* (targetPath: string) {
      const bytes = contents.get(targetPath);
      assert.ok(bytes, `fixture content missing for ${targetPath}`);
      yield bytes.subarray(0, 7);
      yield bytes.subarray(7);
    },
  };
}

async function assertCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (cause: unknown) => {
    return cause instanceof Error && 'code' in cause && cause.code === code;
  });
}

void test('validates a root-owned 4755 helper and matching streamed hash', async () => {
  const fs = fixture();
  const result = await verifySandboxHelper({
    bundledPath,
    helperPath,
    fsstat: fs.fsstat,
    read: fs.read,
  });

  assert.deepEqual(result, {
    ok: true,
    helperPath,
    sha256: createHash('sha256').update(bundledBytes).digest('hex'),
  });
});

void test('rejects helpers whose content hash differs', async () => {
  const fs = fixture();
  fs.contents.set(helperPath, Buffer.from('different helper'));
  await assertCode(
    verifySandboxHelper({
      bundledPath,
      helperPath,
      fsstat: fs.fsstat,
      read: fs.read,
    }),
    'ERR_SANDBOX_HASH_MISMATCH',
  );
});

void test('rejects a helper that is not owned by root:root', async () => {
  const fs = fixture({ [helperPath]: { uid: 1000 } });
  await assertCode(
    verifySandboxHelper({
      bundledPath,
      helperPath,
      fsstat: fs.fsstat,
      read: fs.read,
    }),
    'ERR_SANDBOX_OWNER',
  );
});

void test('rejects a helper whose mode is not exactly 4755', async () => {
  const fs = fixture({ [helperPath]: { mode: 0o755 } });
  await assertCode(
    verifySandboxHelper({
      bundledPath,
      helperPath,
      fsstat: fs.fsstat,
      read: fs.read,
    }),
    'ERR_SANDBOX_MODE',
  );
});

void test('rejects an other-writable helper parent', async () => {
  const fs = fixture({ ['/usr/lib/yeyu']: { mode: 0o777 } });
  await assertCode(
    verifySandboxHelper({
      bundledPath,
      helperPath,
      fsstat: fs.fsstat,
      read: fs.read,
    }),
    'ERR_SANDBOX_PARENT_OTHER_WRITABLE',
  );
});

void test('rejects a helper parent that is not root:root', async () => {
  const fs = fixture({ ['/usr/lib/yeyu']: { gid: 1000 } });
  await assertCode(
    verifySandboxHelper({
      bundledPath,
      helperPath,
      fsstat: fs.fsstat,
      read: fs.read,
    }),
    'ERR_SANDBOX_PARENT_OWNER',
  );
});

void test('rejects a symlink in either the leaf or parent path', async (context) => {
  await context.test('leaf', async () => {
    const fs = fixture({ [helperPath]: { kind: 'symlink' } });
    await assertCode(
      verifySandboxHelper({
        bundledPath,
        helperPath,
        fsstat: fs.fsstat,
        read: fs.read,
      }),
      'ERR_SANDBOX_PATH_SYMLINK',
    );
  });

  await context.test('parent', async () => {
    const fs = fixture({ ['/usr/lib']: { kind: 'symlink' } });
    await assertCode(
      verifySandboxHelper({
        bundledPath,
        helperPath,
        fsstat: fs.fsstat,
        read: fs.read,
      }),
      'ERR_SANDBOX_PATH_SYMLINK',
    );
  });
});

void test('rejects a non-regular helper file', async () => {
  const fs = fixture({ [helperPath]: { kind: 'directory' } });
  await assertCode(
    verifySandboxHelper({
      bundledPath,
      helperPath,
      fsstat: fs.fsstat,
      read: fs.read,
    }),
    'ERR_SANDBOX_NOT_REGULAR',
  );
});
