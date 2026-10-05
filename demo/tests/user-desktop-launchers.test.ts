import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createUserLaunchers,
  desktopExecQuote,
  shellQuote,
} from '../scripts/user-desktop-launchers.mjs';

const FORBIDDEN = ['\0', '\r', '\n'];

type LauncherInput = { home: string; executable: string; icon: string };
interface Captured {
  exe: string;
  args: string[];
}

/** Call the renderer with deliberately invalid values without tripping tsc. */
const callCreate = (input: unknown): { shell: string; desktop: string } =>
  createUserLaunchers(input as LauncherInput);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yeyu-launchers-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A CommonJS capture script; CommonJS avoids Node's ESM backslash restriction. */
function captureScript(outFile: string): string {
  return (
    `#!${process.execPath}\n` +
    `const { writeFileSync } = require('node:fs');\n` +
    `writeFileSync(${JSON.stringify(outFile)}, ` +
    `JSON.stringify({ exe: process.argv[1], args: process.argv.slice(2) }));\n`
  );
}

async function waitForCapture(
  file: string,
  timeoutMs = 6000,
): Promise<Captured | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as Captured;
      } catch {
        // The writer may not have finished flushing yet.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  return undefined;
}

/** Write an executable shell launcher and return its path. */
async function writeLauncher(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const launcher = path.join(dir, name);
  await writeFile(launcher, content);
  await chmod(launcher, 0o755);
  return launcher;
}

/*
 * Independent model of the two Desktop Entry layers, written from the
 * specification rather than from the encoder. The value layer is unescaped
 * first; the resulting text is then tokenized with Exec-level quoting and
 * finally `%%` is collapsed to a literal percent. This lets the tests decide
 * whether an encoding is correct instead of mirroring the implementation.
 */

function unescapeValueLayer(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) {
      out += ch;
    } else if (next === 's') {
      out += ' ';
      i += 1;
    } else if (next === 't') {
      out += '\t';
      i += 1;
    } else if (next === 'n') {
      out += '\n';
      i += 1;
    } else if (next === 'r') {
      out += '\r';
      i += 1;
    } else if (next === '\\') {
      out += '\\';
      i += 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

function parseExecArguments(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quoted) {
      if (ch === '\\') {
        const next = value[i + 1];
        if (next === '"' || next === '`' || next === '$' || next === '\\') {
          current += next;
          i += 1;
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      started = true;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quoted) throw new Error('unterminated Exec quote');
  if (started) args.push(current);
  return args;
}

function decodeOneExecArgument(encoded: string): string {
  const args = parseExecArguments(unescapeValueLayer(encoded));
  assert.equal(args.length, 1, `expected one Exec token from ${JSON.stringify(encoded)}`);
  return args[0].replaceAll('%%', '%');
}

function decodeExecLine(execValue: string): Array<{ field: string } | { arg: string }> {
  return parseExecArguments(unescapeValueLayer(execValue)).map((token) => {
    if (token === '%U') return { field: '%U' };
    return { arg: token.replaceAll('%%', '%') };
  });
}

/* -------------------------------------------------------------------------- */

void test('shellQuote quotes literally and rejects forbidden input', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote('with space'), "'with space'");
  assert.equal(shellQuote('tab\there'), "'tab\there'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('$HOME `id`; rm -rf /'), "'$HOME `id`; rm -rf /'");
  assert.equal(shellQuote('a\\b%c'), "'a\\b%c'");
  for (const bad of FORBIDDEN) {
    assert.throws(() => shellQuote(`a${bad}b`), /NUL, CR or LF/);
  }
  assert.throws(() => shellQuote(42 as unknown as string), /must be a string/);
  assert.throws(() => shellQuote(null as unknown as string), /must be a string/);
});

void test('desktopExecQuote emits the spec escape literals', () => {
  assert.equal(desktopExecQuote(''), '""');
  assert.equal(desktopExecQuote('plain'), '"plain"');
  assert.equal(desktopExecQuote('with space'), String.raw`"with\sspace"`);
  assert.equal(desktopExecQuote('a\tb'), String.raw`"a\tb"`);
  assert.equal(desktopExecQuote('$HOME'), String.raw`"\\$HOME"`);
  assert.equal(desktopExecQuote('a\\b'), String.raw`"a\\\\b"`);
  assert.equal(desktopExecQuote('a"b'), String.raw`"a\\"b"`);
  assert.equal(desktopExecQuote('100%'), '"100%%"');
  assert.equal(desktopExecQuote('%U'), '"%%U"');
  assert.equal(desktopExecQuote('a`b'), '"a\\\\`b"');
  for (const bad of FORBIDDEN) {
    assert.throws(() => desktopExecQuote(`a${bad}b`), /NUL, CR or LF/);
  }
  assert.throws(() => desktopExecQuote(42 as unknown as string), /must be a string/);
  assert.throws(() => desktopExecQuote(undefined as unknown as string), /must be a string/);
});

void test('desktopExecQuote round-trips through an independent decoder', () => {
  const cases: string[] = [
    '',
    'plain',
    'with space',
    "single'quote",
    'double"quote',
    'back\\slash',
    'cash$money',
    'tick`mark',
    'percent%sign',
    'field%Ucode',
    'tab\there',
    'trail ',
    ' lead',
    'mixed a b\tc\\d$e`f"g%h',
    '页语 profile 目录',
    '--user-data-dir=/x y',
    'equals=sign',
  ];
  for (const value of cases) {
    assert.equal(
      decodeOneExecArgument(desktopExecQuote(value)),
      value,
      `round-trip ${JSON.stringify(value)}`,
    );
  }
});

void test('createUserLaunchers renders the exact standard launchers', () => {
  const home = '/home/test.user';
  const executable = '/usr/bin/yeyu';
  const icon = '/usr/share/icons/hicolor/256x256/apps/yeyu.png';
  const { shell, desktop } = createUserLaunchers({ home, executable, icon });

  assert.equal(
    shell,
    '#!/bin/sh\n' +
      "resolved=$(/usr/bin/readlink -f -- '/usr/bin/yeyu')\n" +
      'if [ "$?" -ne 0 ] || [ -z "$resolved" ]; then\n' +
      "  echo 'yeyu: cannot resolve launcher executable' >&2\n" +
      '  exit 1\n' +
      'fi\n' +
      'if [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then\n' +
      "  echo 'yeyu: launcher executable is not an executable regular file' >&2\n" +
      '  exit 1\n' +
      'fi\n' +
      "exec \"$resolved\" --user-data-dir='/home/test.user/.config/页语' " +
      '--ozone-platform=x11 --disable-gpu "$@"\n',
  );

  assert.equal(
    desktop,
    [
      '[Desktop Entry]',
      'Version=1.0',
      'Type=Application',
      'Name=页语',
      'StartupWMClass=yeyu',
      'Icon=/usr/share/icons/hicolor/256x256/apps/yeyu.png',
      'Categories=Education;',
      'Terminal=false',
      'Exec=/bin/sh "/home/test.user/.local/bin/yeyu" %U',
      '',
    ].join('\n'),
  );
});

void test('createUserLaunchers preserves unusual paths including equals', () => {
  const home = "/home/a b'c\"d$e`f%g=h";
  const executable = "/opt/yeyu dir/ye=y u's$%`exe";
  const icon = '/opt/icons/my icon (1)\\2.png';
  const profile = `${home}/.config/页语`;
  const wrapper = `${home}/.local/bin/yeyu`;
  const { shell, desktop } = createUserLaunchers({ home, executable, icon });

  assert.ok(shell.startsWith('#!/bin/sh\n'));
  assert.ok(shell.endsWith(' "$@"\n'));
  assert.ok(
    shell.includes(`resolved=$(/usr/bin/readlink -f -- ${shellQuote(executable)})`),
    'shell resolves the configured executable with fixed /usr/bin/readlink',
  );
  assert.ok(shell.includes(`--user-data-dir=${shellQuote(profile)}`));
  assert.ok(shell.includes('exec "$resolved"'));
  for (const forbidden of ['sudo', '--no-sandbox', 'sh -c', 'eval']) {
    assert.equal(shell.includes(forbidden), false, `shell must not contain ${forbidden}`);
  }

  const execLine = desktop.split('\n').find((line) => line.startsWith('Exec='));
  assert.ok(execLine, 'desktop has an Exec line');
  assert.deepEqual(decodeExecLine(execLine.slice('Exec='.length)), [
    { arg: '/bin/sh' },
    { arg: wrapper },
    { field: '%U' },
  ]);
  assert.equal(
    desktop.includes(executable),
    false,
    'desktop must not reference the raw executable; the wrapper does that',
  );
  assert.equal(
    desktop.includes('--user-data-dir'),
    false,
    'profile/display flags exist only in the shell wrapper',
  );

  const iconLine = desktop.split('\n').find((line) => line.startsWith('Icon='));
  assert.ok(iconLine, 'desktop has an Icon line');
  assert.equal(iconLine, 'Icon=/opt/icons/my\\sicon\\s(1)\\\\2.png');
  assert.equal(iconLine.includes('"'), false, 'iconstring must not use Exec quoting');
});

void test('desktop Icon uses iconstring escaping and keeps literal percent', () => {
  const { desktop } = createUserLaunchers({
    home: '/home/u',
    executable: '/usr/bin/yeyu',
    icon: '/icons/a b\\c\td%e.png',
  });
  const iconLine = desktop.split('\n').find((line) => line.startsWith('Icon='));
  assert.equal(iconLine, 'Icon=/icons/a\\sb\\\\c\\td%e.png');
});

void test('desktop entry exposes the required fields in order', () => {
  const { desktop } = createUserLaunchers({
    home: '/home/u',
    executable: '/usr/bin/yeyu',
    icon: '/i.png',
  });
  const lines = desktop.split('\n');
  assert.equal(lines[0], '[Desktop Entry]');
  assert.equal(lines[1], 'Version=1.0');
  assert.equal(lines[2], 'Type=Application');
  assert.equal(lines[3], 'Name=页语');
  assert.equal(lines[4], 'StartupWMClass=yeyu');
  assert.equal(lines[5], 'Icon=/i.png');
  assert.equal(lines[6], 'Categories=Education;');
  assert.equal(lines[7], 'Terminal=false');
  assert.ok(lines[8].startsWith('Exec='));
  assert.equal(lines[9], '');
  assert.ok(desktop.endsWith('\n'));
});

void test('createUserLaunchers rejects invalid inputs and now accepts equals', () => {
  const base: LauncherInput = {
    home: '/home/u',
    executable: '/usr/bin/yeyu',
    icon: '/usr/share/icon.png',
  };
  for (const field of ['home', 'executable', 'icon'] as const) {
    assert.throws(
      () => callCreate({ ...base, [field]: '' }),
      new RegExp(`${field} must not be empty`),
    );
    assert.throws(
      () => callCreate({ ...base, [field]: 'relative/path' }),
      new RegExp(`${field} must be an absolute POSIX path`),
    );
    assert.throws(
      () => callCreate({ ...base, [field]: 7 }),
      new RegExp(`${field} must be a string`),
    );
    for (const bad of FORBIDDEN) {
      assert.throws(
        () => callCreate({ ...base, [field]: `/a${bad}b` }),
        new RegExp(`${field} must not contain NUL, CR or LF`),
      );
    }
  }
  assert.throws(() => callCreate(undefined), /home must be a string/);
  assert.throws(() => callCreate({}), /home must be a string/);

  // `=` is no longer rejected: the Desktop Exec argv[0] is the fixed /bin/sh.
  const equals = createUserLaunchers({
    home: '/home/u=x',
    executable: '/usr/bin/ye=yu',
    icon: '/i=c.png',
  });
  assert.ok(equals.shell.includes("resolved=$(/usr/bin/readlink -f -- '/usr/bin/ye=yu')"));
  assert.ok(equals.desktop.includes('Exec=/bin/sh "/home/u=x/.local/bin/yeyu" %U'));
});

void test('generated shell resolves a symlinked executable to its concrete path', async () => {
  await withTempDir(async (base) => {
    const nasty = 'sp ace\'s"$`\\%;&|()<>*?!#~=\t';
    const injection = '$(touch INJECTED)`touch INJECTED`;touch INJECTED;';

    const releaseDir = path.join(base, `release ${nasty} ${injection}`);
    await mkdir(releaseDir, { recursive: true });
    const realExecutable = path.join(releaseDir, `yeyu ${nasty} ${injection}`);
    await writeFile(
      realExecutable,
      `#!${process.execPath}\n` +
        'process.stdout.write(JSON.stringify({ exe: process.argv[1], ' +
        'args: process.argv.slice(2) }));\n',
    );
    await chmod(realExecutable, 0o755);

    const linkDir = path.join(base, `link ${nasty} ${injection}`);
    await mkdir(linkDir, { recursive: true });
    const executable = path.join(linkDir, 'yeyu');
    await symlink(realExecutable, executable);

    const home = path.join(base, `home ${nasty} ${injection}`);
    const icon = path.join(base, `icon ${nasty}.png`);

    const { shell } = createUserLaunchers({ home, executable, icon });
    assert.ok(shell.startsWith('#!/bin/sh\n'));
    assert.ok(shell.endsWith(' "$@"\n'));

    const launcher = await writeLauncher(base, 'launcher.sh', shell);

    const forwarded: string[] = [
      'plain',
      'with space',
      'tab\there',
      "single'quote",
      'double"quote',
      'back\\slash',
      '$HOME',
      '${HOME}',
      '$(touch INJECTED)',
      '`touch INJECTED`',
      ';touch INJECTED;',
      '&& touch INJECTED',
      '| touch INJECTED',
      '*',
      '?',
      '~',
      '100%',
      '页语',
      '',
    ];

    const result = spawnSync(launcher, forwarded, {
      cwd: base,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, String(result.stderr));

    const received = JSON.parse(result.stdout) as Captured;
    // The kernel execs the readlink-resolved concrete path, not the symlink.
    assert.equal(received.exe, realpathSync(realExecutable));
    assert.deepEqual(received.args, [
      `--user-data-dir=${home}/.config/页语`,
      '--ozone-platform=x11',
      '--disable-gpu',
      ...forwarded,
    ]);
    assert.equal(
      existsSync(path.join(base, 'INJECTED')),
      false,
      'argument or path expansion created a sentinel file',
    );
  });
});

void test('generated shell follows an active/current symlink from release A to B', async () => {
  await withTempDir(async (base) => {
    const home = path.join(base, 'home %= dir');
    const active = path.join(home, '.local', 'opt', 'yeyu', 'active');
    await mkdir(active, { recursive: true });
    const current = path.join(active, 'current');

    const makeRelease = async (name: string): Promise<string> => {
      const dir = path.join(base, `release-${name}`);
      await mkdir(dir, { recursive: true });
      const exe = path.join(dir, 'yeyu');
      await writeFile(exe, `#!/bin/sh\nprintf '%s' '${name}'\n`);
      await chmod(exe, 0o755);
      return dir;
    };
    const releaseA = await makeRelease('A');
    const releaseB = await makeRelease('B');

    await symlink(releaseA, current);
    const executable = path.join(current, 'yeyu');
    const { shell } = createUserLaunchers({ home, executable, icon: path.join(base, 'i.png') });
    const launcher = await writeLauncher(base, 'launcher.sh', shell);

    const first = spawnSync(launcher, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(first.error, undefined, String(first.error));
    assert.equal(first.status, 0, String(first.stderr));
    assert.equal(first.stdout, 'A');

    // Repoint `current`; the launcher must resolve it again on the next run.
    await rm(current, { force: true });
    await symlink(releaseB, current);

    const second = spawnSync(launcher, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(second.error, undefined, String(second.error));
    assert.equal(second.status, 0, String(second.stderr));
    assert.equal(second.stdout, 'B');
  });
});

void test('generated shell exits nonzero for missing, dangling or non-executable targets', async () => {
  await withTempDir(async (base) => {
    const home = path.join(base, 'home');
    const icon = path.join(base, 'i.png');
    const realDir = path.join(base, 'real');
    await mkdir(realDir, { recursive: true });
    const regular = path.join(realDir, 'yeyu');
    await writeFile(regular, '#!/bin/sh\nexit 0\n');
    await chmod(regular, 0o755);

    const missingParent = path.join(base, 'no-such-dir', 'yeyu');
    const missingFile = path.join(realDir, 'absent');
    const dangling = path.join(realDir, 'dangling');
    await symlink(path.join(realDir, 'gone'), dangling);
    const nonExecutable = path.join(realDir, 'not-exec');
    await writeFile(nonExecutable, 'data');
    await chmod(nonExecutable, 0o644);

    const cases: Array<{ name: string; executable: string; match: RegExp }> = [
      { name: 'missing-parent', executable: missingParent, match: /cannot resolve/ },
      { name: 'missing-file', executable: missingFile, match: /not an executable regular file/ },
      { name: 'dangling-symlink', executable: dangling, match: /not an executable regular file/ },
      { name: 'non-executable', executable: nonExecutable, match: /not an executable regular file/ },
    ];

    for (const item of cases) {
      const { shell } = createUserLaunchers({ home, executable: item.executable, icon });
      const launcher = await writeLauncher(base, `launcher-${item.name}.sh`, shell);
      const result = spawnSync(launcher, [], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.error, undefined, `${item.name}: ${String(result.error)}`);
      assert.notEqual(result.status, 0, `${item.name}: expected a nonzero exit`);
      assert.match(String(result.stderr), item.match, `${item.name}: stderr`);
    }

    // Control: the same launcher succeeds when the target really is executable.
    const okLauncher = await writeLauncher(
      base,
      'launcher-ok.sh',
      createUserLaunchers({ home, executable: regular, icon }).shell,
    );
    const ok = spawnSync(okLauncher, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(ok.error, undefined, String(ok.error));
    assert.equal(ok.status, 0, String(ok.stderr));
  });
});

void test('optional desktop-file-validate accepts the generated entry', async (t) => {
  await withTempDir(async (base) => {
    const home = path.join(base, "home's$%=x");
    const executable = path.join(base, "yeyu's$%=x");
    const icon = path.join(base, 'my icon.png');
    const { desktop } = createUserLaunchers({ home, executable, icon });

    const entry = path.join(base, 'yeyu.desktop');
    await writeFile(entry, desktop);
    const result = spawnSync('desktop-file-validate', [entry], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('desktop-file-validate is not available');
      return;
    }
    assert.equal(result.status, 0, String(result.stderr));
  });
});

void test('optional Gio launches the wrapper with %/=/URI paths through /bin/sh', async (t) => {
  await withTempDir(async (base) => {
    // Control gate: prove `gio launch` can actually run a captured command
    // here, so a skip below is an explicit environment skip, never a silent pass.
    const controlOut = path.join(base, 'control.json');
    const controlExecutable = path.join(base, 'control.cjs');
    await writeFile(controlExecutable, captureScript(controlOut));
    await chmod(controlExecutable, 0o755);
    const controlEntry = path.join(base, 'control.desktop');
    await writeFile(
      controlEntry,
      [
        '[Desktop Entry]',
        'Version=1.0',
        'Type=Application',
        'Name=Control',
        `Exec=${desktopExecQuote(controlExecutable)} control-arg %U`,
        'Terminal=false',
        '',
      ].join('\n'),
    );
    const control = spawnSync('gio', ['launch', controlEntry], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (control.error && (control.error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('gio is not available');
      return;
    }
    if (!(await waitForCapture(controlOut, 3000))) {
      t.skip('gio cannot launch applications in this environment');
      return;
    }

    // Literal `%` (and `=`) in BOTH the wrapper home and the real executable
    // path: this is the case a direct `Exec=<path>` cannot load in Gio.
    const nasty = 'a b\'s"$`\\\t页';
    const home = path.join(base, `home ${nasty}%=`);
    const exeDir = path.join(base, `exe ${nasty}%=`);
    await mkdir(exeDir, { recursive: true });
    const executable = path.join(exeDir, `yeyu ${nasty}%=.cjs`);
    const out = path.join(base, 'gio.json');
    await writeFile(executable, captureScript(out));
    await chmod(executable, 0o755);

    const wrapper = path.join(home, '.local', 'bin', 'yeyu');
    await mkdir(path.dirname(wrapper), { recursive: true });
    const icon = path.join(base, `icon ${nasty}%=.png`);
    const { shell, desktop } = createUserLaunchers({ home, executable, icon });
    assert.ok(shell.includes(shellQuote(executable)), 'wrapper resolves the real executable');
    assert.equal(
      desktop.includes(executable),
      false,
      'desktop references the wrapper, not the raw executable',
    );
    await writeFile(wrapper, shell);
    await chmod(wrapper, 0o755);

    const entry = path.join(base, 'yeyu.desktop');
    await writeFile(entry, desktop);

    // Forward a URI argument; Gio turns file:///.../a%20b.pdf into a local path.
    const target = path.join(base, 'a b.pdf');
    await writeFile(target, 'x');
    const uri = pathToFileURL(target).href;
    const launch = spawnSync('gio', ['launch', entry, uri], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(launch.error, undefined, String(launch.error));

    const captured = await waitForCapture(out);
    assert.ok(captured, 'Gio did not run the generated entry');
    assert.equal(captured.exe, realpathSync(executable));
    assert.deepEqual(captured.args, [
      `--user-data-dir=${home}/.config/页语`,
      '--ozone-platform=x11',
      '--disable-gpu',
      target,
    ]);
  });
});
