import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resultValue } from '../yeyu-tool.mjs';
import { contentUrl, planPage, validateConfig } from './rules.mjs';
import { preparePdf } from './files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (code, message) => Object.assign(new Error(message), { code });
export const defaultPaths = () => {
  const documents =
    process.env.YEYU_DOCUMENTS_ROOT || path.join(os.homedir(), '文档');
  const root =
    process.env.YEYU_BLACKBOARD_ROOT ||
    path.join(documents, 'Blackboard同步', '2610UG', 'automation');
  return {
    root,
    workspace:
      process.env.YEYU_WORKSPACE_ROOT || path.join(documents, '页语工作区'),
    sofficePath:
      process.env.YEYU_BUNDLED_SOFFICE ||
      path.join(
        os.homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice',
      ),
  };
};
export async function loadConfig() {
  return validateConfig(
    JSON.parse(await fs.readFile(path.join(here, 'config.json'), 'utf8')),
  );
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function withLock(root, operation) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'run.lock');
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Fail closed for empty/malformed locks; do not guess which process owns it.
    const owner = await json(lock).catch(() => null);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1)
      throw fail('SYNC_BUSY', '同步锁需要检查，未启动重复任务。');
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      dead = e.code === 'ESRCH';
    }
    if (!dead) throw fail('SYNC_BUSY', '已有同步任务运行，未启动重复任务。');
    // Serialize stale recovery so two recovering processes cannot rename a new
    // owner's live lock. A crash during recovery fails closed for inspection.
    const recovery = path.join(root, 'recovery.lock');
    let guard;
    try {
      guard = await fs.open(recovery, 'wx', 0o600);
    } catch {
      throw fail('SYNC_BUSY', '另一任务正在恢复同步锁。');
    }
    try {
      const current = await json(lock);
      if (current.pid !== owner.pid || current.startedAt !== owner.startedAt)
        throw fail('SYNC_BUSY', '同步锁已由其他任务接管。');
      await fs.rename(lock, path.join(root, `stale-lock-${randomUUID()}.json`));
      handle = await fs.open(lock, 'wx', 0o600);
    } finally {
      await guard.close();
      await fs.unlink(recovery);
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
export async function readLedger(root) {
  try {
    const value = await json(path.join(root, 'ledger.json'));
    if (value.schemaVersion !== 1 || !Array.isArray(value.items))
      throw fail('STATE_INVALID', '同步台账格式错误，未覆盖。');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, items: [] };
    throw error;
  }
}
// Follow neither course symlinks nor artifact symlinks outside the workspace.
async function safeFile(directory, ...segments) {
  let current = await fs.realpath(directory);
  for (const segment of segments) {
    if (
      typeof segment !== 'string' ||
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0') ||
      /[\\/]/.test(segment)
    )
      throw fail('UNSAFE_PATH', '课程清单包含不安全路径。');
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw fail('UNSAFE_PATH', '课程文件不能通过符号链接越出工作区。');
  }
  return current;
}
export async function findCourse(workspace, name) {
  const root = path.join(workspace, 'Courses');
  const matches = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = await safeFile(root, entry.name);
    let manifest;
    try {
      manifest = await json(await safeFile(directory, 'course.json'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.name?.toLowerCase() === name.toLowerCase())
      matches.push({ directory, manifest });
  }
  if (matches.length !== 1)
    throw fail('COURSE_UNAVAILABLE', `页语课程 ${name} 不存在或名称不唯一。`);
  return matches[0];
}
export async function verifyDocument(course, fingerprint, expectedPages) {
  const matches = course.manifest.documents.filter(
    (doc) => doc.fingerprint === fingerprint,
  );
  if (!matches.length) return { status: 'missing' };
  if (matches.length !== 1)
    throw fail('DESTINATION_INVALID', '页语中存在多个相同指纹记录。');
  const doc = matches[0];
  if (
    hash(
      await fs.readFile(
        await safeFile(course.directory, 'PDFs', doc.storedFileName),
      ),
    ) !== fingerprint ||
    doc.pageCount !== expectedPages
  )
    throw fail('DESTINATION_INVALID', '页语 PDF 哈希或页数不一致。');
  if (doc.processing?.status === 'failed')
    return {
      status: 'failed',
      documentId: doc.id,
      phase: doc.processing.phase,
      code: 'AI_FAILED',
    };
  if (['queued', 'running'].includes(doc.processing?.status))
    return {
      status: 'pending',
      documentId: doc.id,
      phase: doc.processing.phase,
    };
  if (doc.processing) throw fail('DESTINATION_INVALID', '未知后台任务状态。');
  if (!(doc.hasSummary && doc.hasMindmap && doc.includedInCourse))
    return {
      status: 'needs_attention',
      documentId: doc.id,
      code: 'ARTIFACTS_INCOMPLETE',
    };
  const digest = await json(
    await safeFile(course.directory, 'Documents', doc.id, 'document.json'),
  );
  if (digest.fingerprint !== fingerprint || digest.documentId !== doc.id)
    throw fail('DESTINATION_INVALID', '单篇成果与 PDF 不匹配。');
  for (const filename of ['PDF总结.md', 'PDF脑图.json', 'PDF脑图.svg']) {
    const bytes = await fs.readFile(
      await safeFile(course.directory, 'Documents', doc.id, filename),
    );
    if (!bytes.length) throw fail('DESTINATION_INVALID', '单篇成果为空。');
    if (filename.endsWith('.json')) JSON.parse(bytes.toString());
  }
  const knowledge = await json(
    await safeFile(
      course.directory,
      'Knowledge',
      `knowledge-v${course.manifest.activeKnowledgeVersion}.json`,
    ),
  );
  if (
    knowledge.courseId !== course.manifest.id ||
    knowledge.version !== course.manifest.activeKnowledgeVersion
  )
    throw fail('DESTINATION_INVALID', '课程汇总版本不匹配。');
  return { status: 'complete', documentId: doc.id };
}
export function validateBatch(config, batch, now = Date.now()) {
  validateConfig(config);
  if (
    batch?.schemaVersion !== 1 ||
    batch.semester !== config.semester ||
    batch.complete !== true ||
    !Array.isArray(batch.pages) ||
    !Array.isArray(batch.attachments)
  )
    throw fail(
      'SCAN_INCOMPLETE',
      '必须提供本轮完整扫描清单，不能仅凭本地旧文件认定同步完成。',
    );
  const when = Date.parse(batch.scannedAt);
  if (
    !Number.isFinite(when) ||
    when > now + 60000 ||
    now - when > 24 * 60 * 60 * 1000
  )
    throw fail('SCAN_EXPIRED', '扫描清单已过期，请重新检查 Blackboard。');
  const active = config.courses.filter((c) => c.enabled);
  for (const page of batch.pages) {
    const course = active.find((c) => c.code === page.course);
    if (!course) throw fail('COURSE_DISABLED', '扫描包含未启用课程。');
    planPage(
      config,
      course,
      {
        url: page.url,
        title: 'Content',
        text: '',
        contentFound: true,
        links: [],
      },
      page.trail,
    );
  }
  for (const course of active)
    for (const root of course.roots) {
      if (
        !batch.pages.some(
          (p) =>
            p.course === course.code &&
            new URL(p.url).searchParams.get('content_id') === root.contentId,
        )
      )
        throw fail('SCAN_INCOMPLETE', `缺少 ${course.code} 根目录扫描。`);
    }
  const keys = new Set();
  for (const item of batch.attachments) {
    const course = active.find((c) => c.code === item.course);
    if (!course) throw fail('COURSE_DISABLED', '清单包含未启用课程。');
    if (
      !batch.pages.some(
        (p) => p.course === item.course && p.url === item.pageUrl,
      )
    )
      throw fail('SCAN_INCOMPLETE', '附件没有来源页面。');
    if (!path.isAbsolute(item.localPath || ''))
      throw fail('DOWNLOAD_REQUIRED', '附件缺少浏览器返回的本地下载路径。');
    const page = {
      url: item.pageUrl,
      title: 'Content',
      text: '',
      contentFound: true,
      links: [
        {
          href: item.sourceUrl,
          text: item.fileName,
          context: item.title || '',
        },
      ],
    };
    const plan = planPage(config, course, page, item.trail);
    if (
      !plan.attachments.some(
        (a) => a.sourceUrl === item.sourceUrl && a.fileName === item.fileName,
      )
    )
      throw fail('OUT_OF_SCOPE', '附件未通过课程/讲义/preview 规则。');
    const key = `${course.code}:${item.sourceUrl}`;
    if (keys.has(key)) throw fail('DUPLICATE_SOURCE', '扫描清单含重复附件。');
    keys.add(key);
  }
  return batch;
}
export async function connectYeyu() {
  const client = new Client({ name: 'blackboard-sync', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(here, '../../electron/dist/yeyu-mcp.js')],
        env: { ...process.env },
      }),
    );
  } catch {
    await client.close().catch(() => {});
    throw fail('APP_UNAVAILABLE', '页语 MCP 不可用，请启动已安装新版页语。');
  }
  return {
    async call(name, args = {}) {
      return resultValue(
        await client.callTool({ name, arguments: args }, undefined, {
          timeout: name === 'yeyu_import_pdf' ? 120000 : 20000,
        }),
      );
    },
    close: () => client.close(),
  };
}
export async function saveReport(root, report, fileName = 'last-report.json') {
  const previous = await json(path.join(root, fileName)).catch(() => null);
  const stableItems = report.items?.map(
    ({ newlyImported: _newlyImported, ...item }) => item,
  );
  const signature = hash(
    JSON.stringify({
      status: report.status,
      items: stableItems,
      code: report.code,
      excluded: report.excluded,
    }),
  );
  report.notify =
    signature !== previous?.signature &&
    !['unchanged', 'not_scanned'].includes(report.status);
  report.signature = signature;
  await atomicJson(path.join(root, fileName), report);
  return report;
}
export async function importBatch(
  config,
  batch,
  paths = defaultPaths(),
  dependencies = {},
) {
  validateBatch(config, batch);
  return withLock(paths.root, async () => {
    const ledger = await readLedger(paths.root);
    const client = await (dependencies.connectYeyu || connectYeyu)();
    const report = {
      checkedAt: new Date().toISOString(),
      status: 'unchanged',
      items: [],
      excluded: batch.excluded || [],
    };
    try {
      const state = await client.call('yeyu_get_state');
      if (state.courseLibrary?.loading !== false)
        throw fail('APP_UNAVAILABLE', '页语课程库尚未就绪。');
      for (const item of batch.attachments) {
        const courseConfig = config.courses.find((c) => c.code === item.course);
        const outcome = {
          course: item.course,
          fileName: item.fileName,
          sourceUrl: item.sourceUrl,
        };
        try {
          const prepared = await (dependencies.preparePdf || preparePdf)(
            item.localPath,
            path.join(paths.root, 'files'),
            { sofficePath: paths.sofficePath, fileName: item.fileName },
          );
          outcome.pdfSha256 = prepared.pdfSha256;
          let course = await findCourse(paths.workspace, courseConfig.yeyuName);
          let verification = await verifyDocument(
            course,
            prepared.pdfSha256,
            prepared.pageCount,
          );
          const key = `${item.course}:${item.sourceUrl}:${prepared.sourceSha256}`;
          let record = ledger.items.find((r) => r.key === key);
          if (!record) {
            record = {
              key,
              ...outcome,
              ...prepared,
              firstSeenAt: new Date().toISOString(),
            };
            ledger.items.push(record);
          }
          // Checkpoint BEFORE importing. A crash/timeout is reconciled against the
          // real course hash next time, never blindly treated as not imported.
          Object.assign(record, verification, {
            lastCheckedAt: new Date().toISOString(),
          });
          await atomicJson(path.join(paths.root, 'ledger.json'), ledger);
          if (verification.status === 'missing') {
            if (
              prepared.visualReviewRequired &&
              item.visualReviewConfirmed !== true
            ) {
              verification = {
                status: 'needs_attention',
                code: 'CONVERSION_REVIEW_REQUIRED',
              };
            } else {
              await client.call('yeyu_import_pdf', {
                courseId: course.manifest.id,
                localPath: prepared.pdfPath,
                generateSummary: true,
                generateMindmap: true,
                mergeIntoCourse: true,
                includeConversationInsights: true,
              });
              course = await findCourse(paths.workspace, courseConfig.yeyuName);
              verification = await verifyDocument(
                course,
                prepared.pdfSha256,
                prepared.pageCount,
              );
              if (verification.status === 'missing')
                throw fail(
                  'SAVE_UNVERIFIED',
                  'MCP 返回后未发现对应 PDF，保存未确认。',
                );
              outcome.newlyImported = true;
            }
          }
          Object.assign(record, verification);
          Object.assign(outcome, verification);
          await atomicJson(path.join(paths.root, 'ledger.json'), ledger);
        } catch (error) {
          Object.assign(outcome, {
            status: 'failed',
            code: error.code || 'IMPORT_ERROR',
          });
        }
        report.items.push(outcome);
      }
    } finally {
      await client.close();
    }
    if (
      report.items.some((i) => ['failed', 'needs_attention'].includes(i.status))
    )
      report.status = 'needs_attention';
    else if (report.items.some((i) => i.status === 'pending'))
      report.status = 'pending';
    else if (report.items.some((i) => i.newlyImported))
      report.status = 'complete';
    if (report.excluded.some((i) => i.reason === 'needs_review'))
      report.status = 'needs_attention';
    report.scannedAt = batch.scannedAt;
    return saveReport(paths.root, report);
  });
}
export async function status(config, paths = defaultPaths()) {
  return withLock(paths.root, async () => {
    const ledger = await readLedger(paths.root);
    const items = [];
    for (const record of ledger.items) {
      const course = config.courses.find(
        (c) => c.enabled && c.code === record.course,
      );
      if (!course) continue;
      let result;
      try {
        result = await verifyDocument(
          await findCourse(paths.workspace, course.yeyuName),
          record.pdfSha256,
          record.pageCount,
        );
      } catch (error) {
        result = { status: 'failed', code: error.code || 'VERIFY_ERROR' };
      }
      Object.assign(record, result, {
        lastCheckedAt: new Date().toISOString(),
      });
      items.push({
        course: record.course,
        fileName: record.fileName,
        ...result,
      });
    }
    await atomicJson(path.join(paths.root, 'ledger.json'), ledger);
    // This only checks saved jobs, not the website. Never call this a fresh scan.
    const report = {
      checkedAt: new Date().toISOString(),
      sourceChecked: false,
      status: items.some((i) =>
        ['failed', 'missing', 'needs_attention'].includes(i.status),
      )
        ? 'needs_attention'
        : items.some((i) => i.status === 'pending')
          ? 'pending'
          : items.length
            ? 'complete'
            : 'not_scanned',
      items,
    };
    return saveReport(paths.root, report, 'last-status.json');
  });
}
export async function waitForJobs(
  config,
  paths = defaultPaths(),
  options = {},
) {
  const poll = options.poll || (() => status(config, paths));
  const sleep =
    options.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const deadline = now() + (options.timeoutMs ?? 30 * 60 * 1000);
  const interval = options.intervalMs ?? 30000;
  while (true) {
    const report = await poll();
    if (report.status !== 'pending') return report;
    if (now() >= deadline)
      return { ...report, timedOut: true, code: 'AI_PENDING_TIMEOUT' };
    await sleep(Math.min(interval, deadline - now()));
  }
}

export async function main(args) {
  const config = await loadConfig(),
    paths = defaultPaths();
  let report;
  if (args.length === 1 && args[0] === 'plan')
    report = {
      config,
      paths,
      roots: config.courses
        .filter((c) => c.enabled)
        .flatMap((c) =>
          c.roots.map((r) => ({
            course: c.code,
            url: contentUrl(config, c, r.contentId),
          })),
        ),
    };
  else if (args.length === 1 && args[0] === 'status')
    report = await status(config, paths);
  else if (args.length === 1 && args[0] === 'wait')
    report = await waitForJobs(config, paths);
  else if (args.length === 2 && args[0] === 'import')
    report = await importBatch(
      config,
      await json(path.resolve(args[1])),
      paths,
    );
  else if (
    args.length === 2 &&
    args[0] === 'blocked' &&
    [
      'AUTH_REQUIRED',
      'SOURCE_LAYOUT_CHANGED',
      'DOWNLOAD_REQUIRED',
      'BROWSER_UNAVAILABLE',
    ].includes(args[1])
  )
    report = await withLock(paths.root, () =>
      saveReport(paths.root, {
        checkedAt: new Date().toISOString(),
        status: 'blocked',
        code: args[1],
        sourceChecked: false,
        items: [],
      }),
    );
  else
    throw fail(
      'USAGE',
      '用法：node scripts/blackboard/sync.mjs plan | import <本轮下载清单.json> | status | wait | blocked <错误码>',
    );
  console.log(JSON.stringify(report));
  if (['blocked', 'needs_attention'].includes(report.status))
    process.exitCode = 2;
  if (report.timedOut) process.exitCode = 3;
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      JSON.stringify({
        status: 'failed',
        code: error.code || 'SYNC_ERROR',
        message: error.code
          ? error.message
          : '同步未完成；请检查应用状态、下载清单和本地文件。',
      }),
    );
    process.exitCode = 1;
  });
