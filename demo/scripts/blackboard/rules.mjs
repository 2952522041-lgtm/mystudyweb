/*
 * Pure, fail-closed rules for the Blackboard collector.
 *
 * This module deliberately knows nothing about a browser, cookies, downloads,
 * or the filesystem.  A browser adapter gives it the small DOM snapshot
 * described by planPage(), and the result is safe to queue for a later step.
 */

export const BLACKBOARD_SITE = 'https://bb.cuhk.edu.cn';
export const BLACKBOARD_CONTENT_PATH =
  '/webapps/blackboard/content/listContent.jsp';

const CONTENT_ID_PATTERN = /^_\d+_\d+$/;
const COURSE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const SEMESTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const YEYU_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DOCUMENT_PATTERN = /\.(?:pdf|pptx?)$/i;

const EMPTY_DIRECTORY_PATTERNS = [
  /\bthere\s+are\s+no\s+(?:items?|files?|content)\b/i,
  /\bno\s+(?:items?|files?|content)\b/i,
  /\b(?:empty|blank)\s+(?:folder|directory)\b/i,
  /\bnothing\s+to\s+(?:display|show)\b/i,
  /暂无内容|没有内容|无内容|暂无项目|没有项目|无项目|文件夹为空|目录为空|当前目录为空/,
];

const NEGATIVE_PREVIEW_PATTERN = /preview|preivew|预习/i;
const NEGATIVE_OUT_OF_SCOPE_PATTERN = /syllabus|课程大纲|textbook|教材/i;

const MODIFICATION_PATH_PATTERN =
  /(?:^|[/_-])(?:add|create|delete|edit|manage|modify|remove|save|submit|update|upload)(?:[a-z]|[/_.-]|$)/i;
const MODIFICATION_QUERY_PATTERN =
  /(?:^|[?&])(?:action|cmd|command|method|mode)=(?:add|create|delete|edit|manage|modify|remove|save|submit|update|upload)(?:&|$)/i;
const UNSAFE_SCHEME_PATTERN = /^(?:javascript|data|blob|file|mailto|tel):/i;

/** Error thrown by a rule that cannot safely produce a plan. */
export class BlackboardRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BlackboardRuleError';
    this.code = code;
    Object.assign(this, details);
  }
}

function invalidConfig(path, message) {
  return { code: 'INVALID_CONFIG', path, message };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasControlCharacter(value) {
  if (typeof value !== 'string') return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f))
      return true;
  }
  return false;
}

function hasUnsafeFileNameCharacter(value) {
  return (
    typeof value === 'string' &&
    (value.includes('/') || value.includes('\\') || hasControlCharacter(value))
  );
}

function validLabel(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !hasControlCharacter(value)
  );
}

/**
 * Validate a collector configuration without changing it.
 *
 * The successful return value is the exact input object.  Invalid input is
 * reported as a small code-bearing exception so the CLI can print a useful
 * configuration error before it starts a browser.
 */
export function validateConfig(config) {
  const fail = (path, message) => {
    const result = invalidConfig(path, message);
    throw new BlackboardRuleError(result.code, result.message, {
      path: result.path,
    });
  };
  if (!isRecord(config)) fail('config', 'config must be an object');
  if (config.schemaVersion !== 1)
    fail('schemaVersion', 'schemaVersion must be 1');
  if (config.site !== BLACKBOARD_SITE)
    fail('site', `site must be exactly ${BLACKBOARD_SITE}`);
  if (
    typeof config.semester !== 'string' ||
    !SEMESTER_PATTERN.test(config.semester)
  )
    fail('semester', 'semester contains an unsafe value');
  if (!Array.isArray(config.courses) || config.courses.length === 0)
    fail('courses', 'courses must be a non-empty array');

  const codes = new Set();
  const blackboardIds = new Set();
  for (let index = 0; index < config.courses.length; index += 1) {
    const course = config.courses[index];
    const path = `courses[${index}]`;
    if (!isRecord(course)) fail(path, 'course must be an object');
    if (
      typeof course.code !== 'string' ||
      !COURSE_CODE_PATTERN.test(course.code)
    )
      fail(`${path}.code`, 'course code is invalid');
    if (codes.has(course.code))
      fail(`${path}.code`, 'course code must be unique');
    codes.add(course.code);
    if (
      typeof course.blackboardId !== 'string' ||
      !CONTENT_ID_PATTERN.test(course.blackboardId)
    )
      fail(`${path}.blackboardId`, 'blackboardId must look like _12345_1');
    if (blackboardIds.has(course.blackboardId))
      fail(`${path}.blackboardId`, 'blackboardId must be unique');
    blackboardIds.add(course.blackboardId);
    if (
      typeof course.yeyuName !== 'string' ||
      !YEYU_NAME_PATTERN.test(course.yeyuName)
    )
      fail(`${path}.yeyuName`, 'yeyuName is invalid');
    if (typeof course.enabled !== 'boolean')
      fail(`${path}.enabled`, 'enabled must be boolean');
    if (!Array.isArray(course.roots))
      fail(`${path}.roots`, 'roots must be an array');
    if (course.enabled && course.roots.length === 0)
      fail(`${path}.roots`, 'an enabled course must have at least one root');

    const rootIds = new Set();
    for (let rootIndex = 0; rootIndex < course.roots.length; rootIndex += 1) {
      const root = course.roots[rootIndex];
      const rootPath = `${path}.roots[${rootIndex}]`;
      if (!isRecord(root)) fail(rootPath, 'root must be an object');
      if (
        typeof root.contentId !== 'string' ||
        !CONTENT_ID_PATTERN.test(root.contentId)
      )
        fail(`${rootPath}.contentId`, 'contentId must look like _12345_1');
      if (rootIds.has(root.contentId))
        fail(
          `${rootPath}.contentId`,
          'root contentId must be unique within a course',
        );
      rootIds.add(root.contentId);
      if (!validLabel(root.label))
        fail(`${rootPath}.label`, 'root label is invalid');
    }
  }
  return config;
}

function throwRule(code, message, details = {}) {
  throw new BlackboardRuleError(code, message, details);
}

function assertConfig(config) {
  return validateConfig(config);
}

function resolveCourse(config, courseRef, requireEnabled = true) {
  let course;
  if (typeof courseRef === 'string') {
    course = config.courses.find(
      (candidate) =>
        candidate.code === courseRef || candidate.blackboardId === courseRef,
    );
  } else if (isRecord(courseRef)) {
    const byCode =
      typeof courseRef.code === 'string'
        ? config.courses.find((candidate) => candidate.code === courseRef.code)
        : undefined;
    const byBlackboardId =
      typeof courseRef.blackboardId === 'string'
        ? config.courses.find(
            (candidate) => candidate.blackboardId === courseRef.blackboardId,
          )
        : undefined;
    if (byCode && byBlackboardId && byCode !== byBlackboardId)
      throwRule('COURSE_MISMATCH', 'course code and blackboardId disagree');
    course = byCode || byBlackboardId;
  }
  if (!course) throwRule('COURSE_NOT_FOUND', 'course is not in the config');
  if (requireEnabled && !course.enabled)
    throwRule('COURSE_DISABLED', `course ${course.code} is disabled`);
  return course;
}

function requireContentId(contentId) {
  if (typeof contentId !== 'string' || !CONTENT_ID_PATTERN.test(contentId))
    throwRule('INVALID_CONTENT_ID', 'contentId must look like _12345_1');
  return contentId;
}

/** Build the only Blackboard content-list URL that this collector follows. */
export function contentUrl(config, courseRef, contentId) {
  const checkedConfig = assertConfig(config);
  const course = resolveCourse(checkedConfig, courseRef);
  const id = requireContentId(contentId);
  const url = new URL(BLACKBOARD_CONTENT_PATH, checkedConfig.site);
  url.searchParams.set('course_id', course.blackboardId);
  url.searchParams.set('content_id', id);
  return url.href;
}

function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function decodedPathname(url) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

function queryHasOnlyExpectedCourse(url, course) {
  const values = url.searchParams.getAll('course_id');
  return values.length === 1 && values[0] === course.blackboardId;
}

function queryHasAllowedSemester(url, config) {
  for (const [key, value] of url.searchParams.entries()) {
    if (
      /^(?:semester|term|term_id|course_term|enrollment_term)$/i.test(key) &&
      value !== config.semester
    )
      return false;
  }
  return true;
}

function actionOrLogout(url) {
  const path = decodedPathname(url).toLowerCase();
  const query = url.search.toLowerCase();
  if (
    /logout|signout|sign-out/.test(path) ||
    /(?:^|[?&])logout(?:[=&]|$)/.test(query)
  )
    return true;
  if (
    MODIFICATION_PATH_PATTERN.test(path) ||
    MODIFICATION_QUERY_PATTERN.test(query)
  )
    return true;
  return false;
}

function sameOrigin(url, config) {
  return (
    url.protocol === 'https:' &&
    url.origin === new URL(config.site).origin &&
    url.username === '' &&
    url.password === ''
  );
}

function parseHref(rawHref, config, course) {
  if (typeof rawHref !== 'string' || rawHref.trim() === '')
    return { kind: 'unsafe', reason: 'invalid_url' };
  const href = rawHref.trim();
  if (UNSAFE_SCHEME_PATTERN.test(href))
    return { kind: 'unsafe', reason: 'unsafe_scheme' };
  let url;
  try {
    url = new URL(href, config.site);
  } catch {
    return { kind: 'unsafe', reason: 'invalid_url' };
  }
  if (!sameOrigin(url, config))
    return { kind: 'unsafe', reason: 'external_url' };
  if (!queryHasAllowedSemester(url, config))
    return { kind: 'unsafe', reason: 'semester_mismatch' };
  if (actionOrLogout(url)) return { kind: 'unsafe', reason: 'unsafe_action' };

  const pathname = decodedPathname(url);
  if (pathname === BLACKBOARD_CONTENT_PATH) {
    if (!queryHasOnlyExpectedCourse(url, course))
      return { kind: 'unsafe', reason: 'course_mismatch' };
    const contentIds = url.searchParams.getAll('content_id');
    if (contentIds.length !== 1 || !CONTENT_ID_PATTERN.test(contentIds[0]))
      return { kind: 'unsafe', reason: 'invalid_content_id' };
    url.hash = '';
    return { kind: 'folder', url: url.href, contentId: contentIds[0] };
  }

  if (/\/bbcswebdav\//i.test(pathname)) {
    const courseValues = url.searchParams.getAll('course_id');
    if (
      courseValues.length > 0 &&
      (courseValues.length !== 1 || courseValues[0] !== course.blackboardId)
    )
      return { kind: 'unsafe', reason: 'course_mismatch' };
    url.hash = '';
    return { kind: 'attachment', url: url.href };
  }
  return { kind: 'irrelevant' };
}

function loginPage(page) {
  const rawUrl = typeof page?.url === 'string' ? page.url : '';
  const title = normalizedText(page?.title);
  const text = typeof page?.text === 'string' ? page.text : '';
  if (
    /(?:^|[/_-])(?:login|signin|sign-in|authenticate)(?:[/_.?&-]|$)/i.test(
      rawUrl,
    )
  )
    return true;
  if (/(?:^|\s)(?:login|sign in|登录)(?:\s|$)/i.test(title)) return true;
  if (
    /(?:blackboard|learn).*(?:login|sign in)|(?:login|sign in).*(?:blackboard|learn)/i.test(
      title,
    )
  )
    return true;
  if (
    page?.contentFound === false &&
    /(?:^|[\s(])(?:login|sign in|登录)(?:[\s)]|$)/i.test(text)
  )
    return true;
  if (
    page?.contentFound === false &&
    /(?:username|user name|用户名)/i.test(text) &&
    /(?:password|密码)/i.test(text)
  )
    return true;
  return false;
}

function pageUrl(config, course, rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '')
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL is missing');
  if (UNSAFE_SCHEME_PATTERN.test(rawUrl.trim()))
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL uses an unsafe scheme');
  let url;
  try {
    url = new URL(rawUrl, config.site);
  } catch {
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL is invalid');
  }
  if (!sameOrigin(url, config))
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL is outside Blackboard');
  if (actionOrLogout(url) || decodedPathname(url) !== BLACKBOARD_CONTENT_PATH)
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL is not a content directory');
  if (!queryHasOnlyExpectedCourse(url, course))
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL has a different course_id');
  if (!queryHasAllowedSemester(url, config))
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL has a different semester');
  const ids = url.searchParams.getAll('content_id');
  if (ids.length !== 1 || !CONTENT_ID_PATTERN.test(ids[0]))
    throwRule('SOURCE_LAYOUT_CHANGED', 'page URL has an invalid content_id');
  return url;
}

function normalEmptyDirectory(page) {
  if (page.contentFound !== false || page.links.length !== 0) return false;
  const text = typeof page.text === 'string' ? page.text.trim() : '';
  return EMPTY_DIRECTORY_PATTERNS.some((pattern) => pattern.test(text));
}

function safeFileName(url, fallbackTitle) {
  const rawParts = url.pathname.split('/');
  const rawLast = rawParts[rawParts.length - 1] || '';
  let decodedLast = '';
  if (rawLast) {
    try {
      decodedLast = decodeURIComponent(rawLast);
    } catch {
      return { name: '', unsafe: true };
    }
    // A percent-encoded slash/backslash in the last path segment is an
    // attempted path escape, even when the visible anchor text looks safe.
    if (hasUnsafeFileNameCharacter(decodedLast))
      return { name: '', unsafe: true };
  }
  const preferred = normalizedText(fallbackTitle);
  // Blackboard WebDAV object URLs often end in an xid/rid rather than the
  // original filename.  The observed anchor text is the authoritative name
  // only when it is itself a complete, safe supported filename.  Do not try
  // to strip a trailing size such as "Lecture 1.pdf (2 MB)"; that would be an
  // invented filename and cannot pass the importer's batch re-check.
  if (DOCUMENT_PATTERN.test(preferred)) {
    if (
      preferred === '.' ||
      preferred === '..' ||
      preferred.length > 255 ||
      hasUnsafeFileNameCharacter(preferred)
    )
      return { name: '', unsafe: true };
    return { name: preferred, unsafe: false };
  }
  let name = decodedLast;
  if (!name) name = preferred;
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.length > 255 ||
    hasUnsafeFileNameCharacter(name)
  )
    return { name: '', unsafe: true };
  return { name, unsafe: false };
}

function titleForLink(link, fileName) {
  const text = normalizedText(link.text);
  if (text) return text;
  const context = normalizedText(link.context);
  return context || fileName;
}

function classificationText(fileName, title, trail, context) {
  return [fileName, title, ...(Array.isArray(trail) ? trail : []), context]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function exclusionReason(fileName, title, trail, context) {
  const haystack = classificationText(fileName, title, trail, context);
  if (NEGATIVE_PREVIEW_PATTERN.test(haystack)) return 'preview';
  if (NEGATIVE_OUT_OF_SCOPE_PATTERN.test(haystack)) return 'out_of_scope';
  return null;
}

function positiveLectureSignal(fileName, title, trail, context) {
  const haystack = classificationText(fileName, title, trail, context);
  if (/(?:^|[^a-z])lec(?:ture)?\d*(?:$|[^a-z])/i.test(haystack)) return true;
  if (/(?:^|[^a-z])lecture(?:s)?(?:$|[^a-z])/i.test(haystack)) return true;
  if (/(?:^|[^a-z])tut(?:orials?)?\d*(?:$|[^a-z])/i.test(haystack)) return true;
  return /讲义|教程|习题课/i.test(haystack);
}

function specialEce3250Lecture(course, fileName, title, trail) {
  if (course.code !== 'ECE3250') return false;
  if (!/3250\s*[-_ ]?\s*l1\.pdf$/i.test(fileName)) return false;
  return (
    Array.isArray(trail) && trail.some((part) => /lecture\s*notes/i.test(part))
  );
}

function safeExcludedName(fileName, title) {
  if (fileName && !hasUnsafeFileNameCharacter(fileName)) return fileName;
  const titleName = normalizedText(title)
    .split('')
    .map((character) =>
      hasUnsafeFileNameCharacter(character) ? '_' : character,
    )
    .join('');
  return titleName || 'unsafe-file';
}

/**
 * Classify one observed Blackboard content page.
 *
 * The input is intentionally a plain snapshot.  Any URL that cannot be
 * proven to stay in the configured course is ignored, and only the
 * conservative positive lecture rules can produce attachments.
 */
export function planPage(config, courseRef, page, trail = []) {
  const checkedConfig = assertConfig(config);
  const course = resolveCourse(checkedConfig, courseRef);
  if (!isRecord(page)) throwRule('SOURCE_LAYOUT_CHANGED', 'page is missing');
  if (loginPage(page))
    throwRule('AUTH_REQUIRED', 'Blackboard login is required');
  if (typeof page.contentFound !== 'boolean' || !Array.isArray(page.links))
    throwRule('SOURCE_LAYOUT_CHANGED', 'page DOM shape is not recognized');
  if (typeof page.text !== 'string' || typeof page.title !== 'string')
    throwRule('SOURCE_LAYOUT_CHANGED', 'page text/title is not recognized');
  pageUrl(checkedConfig, course, page.url);

  const safeTrail = Array.isArray(trail) ? trail.slice() : [];
  if (!page.contentFound && !normalEmptyDirectory(page))
    throwRule(
      'SOURCE_LAYOUT_CHANGED',
      'Blackboard content container is missing',
    );
  if (!page.contentFound) return { folders: [], attachments: [], excluded: [] };

  const folders = [];
  const attachments = [];
  const excluded = [];
  const folderUrls = new Set();
  const attachmentUrls = new Set();
  const excludedKeys = new Set();
  const inheritedExclusion = exclusionReason('', '', safeTrail, '');

  for (const rawLink of page.links) {
    if (!isRecord(rawLink)) continue;
    const parsed = parseHref(rawLink.href, checkedConfig, course);
    if (parsed.kind === 'folder') {
      const label = normalizedText(rawLink.text) || parsed.contentId;
      if (exclusionReason('', label, safeTrail, rawLink.context)) continue;
      if (!folderUrls.has(parsed.url)) {
        folderUrls.add(parsed.url);
        folders.push({ url: parsed.url, label });
      }
      continue;
    }
    if (parsed.kind !== 'attachment') continue;

    const filenameResult = safeFileName(
      parsed.url ? new URL(parsed.url) : null,
      rawLink.text,
    );
    // safeFileName() is only called with parsed URLs, but retaining this
    // branch makes the invariant explicit if parseHref changes later.
    const fileName = filenameResult.name;
    const title = titleForLink(rawLink, fileName);
    const key = `${parsed.url}\u0000${fileName || normalizedText(rawLink.text)}`;
    if (excludedKeys.has(key) || attachmentUrls.has(parsed.url)) continue;

    if (filenameResult.unsafe) {
      excludedKeys.add(key);
      excluded.push({
        fileName: safeExcludedName(fileName, title),
        reason: 'out_of_scope',
      });
      continue;
    }

    const extensionObserved =
      DOCUMENT_PATTERN.test(fileName) || DOCUMENT_PATTERN.test(title);
    const negative = exclusionReason(
      fileName,
      title,
      safeTrail,
      rawLink.context,
    );
    if (negative || inheritedExclusion) {
      excludedKeys.add(key);
      excluded.push({
        fileName,
        reason: negative || inheritedExclusion,
      });
      continue;
    }

    const lectureSignal = positiveLectureSignal(
      fileName,
      title,
      safeTrail,
      rawLink.context,
    );
    const specialSignal = specialEce3250Lecture(
      course,
      fileName,
      title,
      safeTrail,
    );
    if (!extensionObserved || (!lectureSignal && !specialSignal)) {
      excludedKeys.add(key);
      excluded.push({ fileName, reason: 'needs_review' });
      continue;
    }
    if (!attachmentUrls.has(parsed.url)) {
      attachmentUrls.add(parsed.url);
      attachments.push({
        sourceUrl: parsed.url,
        fileName,
        title,
        trail: safeTrail.slice(),
      });
    }
  }
  return { folders, attachments, excluded };
}

/**
 * Stable identity for a Blackboard source.  Queries and fragments are
 * intentionally omitted so tracking parameters cannot change the identity;
 * the path is retained so same-named files at different URLs do not collide.
 *
 * Both sourceKey(course, url) and sourceKey(config, course, url) are accepted
 * to keep this helper convenient for the browser runner and storage layer.
 */
export function sourceKey(courseOrConfig, sourceOrCourse, maybeSourceUrl) {
  let courseRef = courseOrConfig;
  let rawSourceUrl = sourceOrCourse;
  if (maybeSourceUrl !== undefined) {
    courseRef = sourceOrCourse;
    rawSourceUrl = maybeSourceUrl;
  }
  const courseId =
    typeof courseRef === 'string'
      ? courseRef
      : isRecord(courseRef)
        ? courseRef.blackboardId || courseRef.code
        : '';
  if (typeof courseId !== 'string' || !courseId)
    throw new TypeError('course is required');
  let url;
  try {
    url = new URL(rawSourceUrl, BLACKBOARD_SITE);
  } catch {
    throw new TypeError('sourceUrl is invalid');
  }
  return `${courseId}:${url.pathname}`;
}
