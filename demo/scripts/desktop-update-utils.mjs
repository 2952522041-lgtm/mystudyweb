import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

/** Only migrate this application's legacy launchers; keep user-data and display flags. */
export function updateLauncher(text, home) {
  const escaped = path
    .join(home, '.local', 'opt')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacy = new RegExp(
    `${escaped}/yeyu-[A-Za-z0-9_-]+/yeyu(?=[ \\"'\\n]|$)`,
    'g',
  );
  return text.replace(legacy, '/usr/bin/yeyu');
}

/** Compare both Electron code and the separately packaged client, not just app.asar. */
export async function installationDigest(resources) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const entries = await readdir(path.join(resources, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        hash.update(name);
        hash.update('\0');
        hash.update(await readFile(path.join(resources, name)));
      } else throw new Error('安装目录含非普通文件，无法验证。');
    }
  }
  hash.update(await readFile(path.join(resources, 'app.asar')));
  await visit('client');
  return hash.digest('hex');
}
