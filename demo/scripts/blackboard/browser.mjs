import { contentUrl, planPage, validateConfig } from './rules.mjs';

// This module uses only the documented CUA tab API. No HTTP, cookies, browser
// profile access, executable page code, or persisted credentials are needed.
export async function readPage(tab) {
  const url = await tab.url();
  const title = await tab.title();
  const dom = await tab.playwright.evaluate(() => {
    const root = document.querySelector('#content_listContainer');
    return {
      contentFound: Boolean(root),
      text: (root || document.body).innerText.slice(0, 30000),
      links: root
        ? Array.from(root.querySelectorAll('a[href]')).map((a) => ({
            href: a.href,
            text: (a.innerText || a.textContent || '').trim(),
            context:
              (
                a.closest('li.liItem') ||
                a.closest('li') ||
                a.parentElement
              )?.innerText?.slice(0, 4000) || '',
          }))
        : [],
    };
  });
  return { url, title, ...dom };
}

export async function scanBlackboard(tab, config, options = {}) {
  validateConfig(config);
  const result = {
    schemaVersion: 1,
    semester: config.semester,
    scannedAt: new Date().toISOString(),
    complete: false,
    pages: [],
    attachments: [],
    excluded: [],
  };
  const seenFiles = new Set();
  // Fail closed on any missing course/page; never publish a partial scan as a
  // successful no-change check. Caller can persist the thrown error separately.
  for (const course of config.courses.filter((c) => c.enabled)) {
    const queue = course.roots.map((root) => ({
      url: contentUrl(config, course, root.contentId),
      trail: [root.label],
    }));
    const seen = new Set();
    while (queue.length) {
      const item = queue.shift();
      const identity = new URL(item.url).searchParams.get('content_id');
      if (seen.has(identity)) continue;
      if (seen.size >= (options.maxPagesPerCourse ?? 80))
        throw Object.assign(
          new Error('课程目录超过安全上限，需检查目录结构。'),
          { code: 'SOURCE_LIMIT' },
        );
      seen.add(identity);
      if ((await tab.url()) !== item.url) await tab.goto(item.url);
      const page = await readPage(tab);
      const plan = planPage(config, course, page, item.trail);
      result.pages.push({
        course: course.code,
        url: page.url,
        trail: item.trail,
      });
      for (const attachment of plan.attachments) {
        const key = `${course.code}:${attachment.sourceUrl}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        result.attachments.push({
          ...attachment,
          course: course.code,
          pageUrl: page.url,
        });
      }
      result.excluded.push(
        ...plan.excluded.map((entry) => ({
          ...entry,
          course: course.code,
          pageUrl: page.url,
        })),
      );
      for (const folder of plan.folders)
        queue.push({ url: folder.url, trail: [...item.trail, folder.label] });
      await options.onPage?.({
        course: course.code,
        pages: seen.size,
        attachments: result.attachments.length,
      });
    }
  }
  result.complete = true;
  return result;
}

/** The CUA download API reports the local path in its tool notification, not
 * its return value. The executor pairs that exact path with this attachment;
 * the importer then checks scope, bytes, PDF validity and destination hash.
 * Never infer a path from a filename or inspect unrelated browser downloads.
 */
export async function downloadAttachment(tab, config, attachment) {
  const course = config.courses.find(
    (c) => c.code === attachment.course && c.enabled,
  );
  if (!course)
    throw Object.assign(new Error('课程未启用。'), { code: 'COURSE_DISABLED' });
  if ((await tab.url()) !== attachment.pageUrl)
    await tab.goto(attachment.pageUrl);
  const page = await readPage(tab);
  const plan = planPage(config, course, page, attachment.trail);
  const observed = plan.attachments.find(
    (a) =>
      a.sourceUrl === attachment.sourceUrl &&
      a.fileName === attachment.fileName,
  );
  if (!observed)
    throw Object.assign(new Error('附件已变化，必须重新扫描。'), {
      code: 'SOURCE_CHANGED',
    });
  const selector = `a[href=${JSON.stringify(observed.sourceUrl)}]`;
  // Blackboard often uses relative hrefs; identify the observed raw attribute
  // through DOM reading, then call the normal browser download interface.
  const rawHrefs = await tab.playwright.evaluate(
    (url) =>
      Array.from(document.querySelectorAll('#content_listContainer a[href]'))
        .filter((a) => a.href === url)
        .map((a) => a.getAttribute('href')),
    observed.sourceUrl,
  );
  const raw = rawHrefs[0];
  if (!raw)
    throw Object.assign(new Error('附件链接不可用。'), {
      code: 'SOURCE_CHANGED',
    });
  await tab.playwright
    .locator(
      raw === observed.sourceUrl
        ? selector
        : `#content_listContainer a[href=${JSON.stringify(raw)}]`,
    )
    .first()
    .downloadMedia({ timeoutMs: 60000 });
  return {
    course: course.code,
    sourceUrl: observed.sourceUrl,
    fileName: observed.fileName,
    needsDownloadPath: true,
  };
}
