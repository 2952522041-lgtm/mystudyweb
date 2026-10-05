import { readFile } from 'node:fs/promises';

export interface DesktopBuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
  dirty: boolean;
  packaged: boolean;
}

export async function readBuildInfo(
  file: string,
  version: string,
  packaged: boolean,
): Promise<DesktopBuildInfo> {
  const fallback: DesktopBuildInfo = {
    version,
    commit: null,
    builtAt: null,
    dirty: false,
    packaged,
  };
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return {
      ...fallback,
      version:
        typeof raw.version === 'string' &&
        /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(raw.version)
          ? raw.version
          : version,
      commit:
        typeof raw.commit === 'string' && /^[a-f0-9]{7,40}$/.test(raw.commit)
          ? raw.commit
          : null,
      builtAt:
        typeof raw.builtAt === 'string' &&
        Number.isFinite(Date.parse(raw.builtAt))
          ? raw.builtAt
          : null,
      dirty: raw.dirty === true,
    };
  } catch {
    return fallback;
  }
}
