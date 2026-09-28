import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentUrl,
  planPage,
  sourceKey,
  validateConfig,
} from '../scripts/blackboard/rules.mjs';

const config = {
  schemaVersion: 1,
  site: 'https://bb.cuhk.edu.cn',
  semester: '2610UG',
  courses: [
    {
      code: 'ECE3060',
      blackboardId: '_17870_1',
      yeyuName: 'ece3060',
      enabled: true,
      roots: [{ contentId: '_642863_1', label: 'Content' }],
    },
    {
      code: 'ECE3080',
      blackboardId: '_17869_1',
      yeyuName: 'ece3080',
      enabled: true,
      roots: [{ contentId: '_642860_1', label: 'Content' }],
    },
    {
      code: 'ECE3250',
      blackboardId: '_17866_1',
      yeyuName: 'ece3250',
      enabled: true,
      roots: [{ contentId: '_642851_1', label: 'Content' }],
    },
    {
      code: 'CSC3002',
      blackboardId: '_17929_1',
      yeyuName: 'csc3002',
      enabled: false,
      roots: [],
    },
  ],
} as const;

const course = config.courses[0];
const rootUrl = contentUrl(config, course, course.roots[0].contentId);

void test('supplementary handouts inherit the plural Tutorials folder scope', () => {
  const result = planPage(
    config,
    course,
    page([
      {
        href: '/bbcswebdav/handout.pdf',
        text: 'Week 1 solutions.pdf',
        context: '',
      },
    ]),
    ['Content', 'Tutorials'],
  );
  assert.equal(result.attachments.length, 1);
});

function page(links: Array<Record<string, string>> = [], overrides = {}) {
  return {
    url: rootUrl,
    title: 'Content',
    text: '',
    contentFound: true,
    links,
    ...overrides,
  };
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (!error || typeof error !== 'object')
      assert.fail('error must be an object');
    return String((error as { code?: unknown }).code);
  }
  assert.fail('expected a code-bearing error');
}

void test('validates the fixed Blackboard config without mutating it', () => {
  assert.strictEqual(validateConfig(config), config);
  const invalidSite = { ...config, site: 'http://bb.cuhk.edu.cn' };
  assert.equal(
    errorCode(() => validateConfig(invalidSite)),
    'INVALID_CONFIG',
  );

  const invalidCourse = {
    ...config,
    courses: [
      {
        ...course,
        blackboardId: '17870',
      },
    ],
  };
  assert.equal(
    errorCode(() => validateConfig(invalidCourse)),
    'INVALID_CONFIG',
  );

  const enabledWithoutRoot = {
    ...config,
    courses: [{ ...course, roots: [] }],
  };
  assert.equal(
    errorCode(() => validateConfig(enabledWithoutRoot)),
    'INVALID_CONFIG',
  );
  const disabledConfig = {
    ...config,
    courses: [{ ...config.courses[3], roots: [] }],
  };
  assert.strictEqual(validateConfig(disabledConfig), disabledConfig);
});

void test('builds only the configured content/listContent.jsp URL', () => {
  assert.equal(
    rootUrl,
    'https://bb.cuhk.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_17870_1&content_id=_642863_1',
  );
  assert.equal(
    contentUrl(config, 'ECE3060', '_90001_2'),
    'https://bb.cuhk.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_17870_1&content_id=_90001_2',
  );
  assert.equal(
    errorCode(() => contentUrl(config, config.courses[3], '_90001_2')),
    'COURSE_DISABLED',
  );
  assert.equal(
    errorCode(() => contentUrl(config, course, 'not-an-id')),
    'INVALID_CONTENT_ID',
  );
});

void test('plans lecture attachments, traversable folders, and conservative exclusions', () => {
  const result = planPage(
    config,
    course,
    page([
      {
        href: '/bbcswebdav/courses/ece3060/Lecture%201.pdf',
        text: 'Lecture 1.pdf',
        context: 'Lecture 1',
      },
      {
        href: '/bbcswebdav/courses/ece3060/slides.pptx',
        text: 'Slides.pptx',
        context: 'lecture slides',
      },
      {
        href: '/bbcswebdav/courses/ece3060/reading.pdf',
        text: 'Reading.pdf',
        context: 'Additional reading',
      },
      {
        href: '/bbcswebdav/courses/ece3060/lecture.pdf',
        text: 'Preview copy',
        context: 'Preview',
      },
      {
        href: '/bbcswebdav/courses/ece3060/syllabus.pdf',
        text: 'Course outline.pdf',
        context: 'Syllabus',
      },
      {
        href: '/webapps/blackboard/content/listContent.jsp?course_id=_17870_1&content_id=_90001_2',
        text: 'Week 1',
        context: 'Week 1',
      },
      {
        href: '/webapps/blackboard/content/listContent.jsp?course_id=_17870_1&content_id=_90001_3',
        text: 'Preview',
        context: 'Preview',
      },
    ]),
    ['Content'],
  );

  assert.deepEqual(result.folders, [
    {
      url: 'https://bb.cuhk.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_17870_1&content_id=_90001_2',
      label: 'Week 1',
    },
  ]);
  assert.deepEqual(
    result.attachments.map(({ sourceUrl, fileName, title, trail }) => ({
      sourceUrl,
      fileName,
      title,
      trail,
    })),
    [
      {
        sourceUrl:
          'https://bb.cuhk.edu.cn/bbcswebdav/courses/ece3060/Lecture%201.pdf',
        fileName: 'Lecture 1.pdf',
        title: 'Lecture 1.pdf',
        trail: ['Content'],
      },
      {
        sourceUrl:
          'https://bb.cuhk.edu.cn/bbcswebdav/courses/ece3060/slides.pptx',
        fileName: 'Slides.pptx',
        title: 'Slides.pptx',
        trail: ['Content'],
      },
    ],
  );
  assert.deepEqual(result.excluded, [
    { fileName: 'Reading.pdf', reason: 'needs_review' },
    { fileName: 'lecture.pdf', reason: 'preview' },
    { fileName: 'Course outline.pdf', reason: 'out_of_scope' },
  ]);
});

void test('uses title/context and ancestor trail for negative and positive rules', () => {
  const result = planPage(
    config,
    course,
    page([
      {
        href: '/bbcswebdav/courses/ece3060/week-1.pdf',
        text: 'Week 1.pdf',
        context: 'Preview',
      },
      {
        href: '/bbcswebdav/courses/ece3060/week-2.pdf',
        text: 'Week 2.pdf',
        context: 'Lecture Notes',
      },
      {
        href: '/bbcswebdav/courses/ece3060/week-3.pdf',
        text: 'Week 3.pdf',
        context: 'Tutorial',
      },
    ]),
    ['Content'],
  );
  assert.deepEqual(
    result.attachments.map((attachment) => attachment.fileName),
    ['Week 2.pdf', 'Week 3.pdf'],
  );
  assert.deepEqual(result.excluded, [
    { fileName: 'Week 1.pdf', reason: 'preview' },
  ]);

  const rootLecture = planPage(
    config,
    course,
    page([
      {
        href: '/bbcswebdav/courses/ece3060/Lec01.pdf',
        text: 'Lec01.pdf',
        context: '',
      },
    ]),
  );
  assert.equal(rootLecture.attachments[0].fileName, 'Lec01.pdf');
  assert.deepEqual(rootLecture.attachments[0].trail, []);

  const xidAttachment = planPage(
    config,
    course,
    page([
      {
        href: '/bbcswebdav/pid-670218-dt-content-rid-12531621_1/xid-12531621_1',
        text: 'Lecture 2.pdf',
        context: 'Lecture 2',
      },
    ]),
  );
  assert.equal(xidAttachment.attachments[0].fileName, 'Lecture 2.pdf');
});

void test('allows the ECE3250 Lecture Notes exception only in its named directory', () => {
  const ece3250 = config.courses[2];
  const ece3250Url = contentUrl(config, ece3250, ece3250.roots[0].contentId);
  const result = planPage(
    config,
    ece3250,
    {
      ...page([], { url: ece3250Url }),
      links: [
        {
          href: '/bbcswebdav/courses/ece3250/3250%20L1.pdf',
          text: '3250 L1.pdf',
          context: 'Lecture Notes',
        },
        {
          href: '/bbcswebdav/courses/ece3250/3250%20L2.pdf',
          text: '3250 L2.pdf',
          context: 'Other files',
        },
      ],
    },
    ['Content', 'Lecture Notes'],
  );
  assert.deepEqual(
    result.attachments.map((attachment) => attachment.fileName),
    ['3250 L1.pdf', '3250 L2.pdf'],
  );
  assert.deepEqual(result.excluded, []);
});

void test('fails closed for authentication, malformed pages, disabled courses, and anomalous empty pages', () => {
  assert.equal(
    errorCode(() =>
      planPage(
        config,
        course,
        page([], {
          url: 'https://bb.cuhk.edu.cn/webapps/login/?new_loc=%2Fwebapps%2Fblackboard',
          title: 'LOGIN',
          text: 'Username Password',
        }),
      ),
    ),
    'AUTH_REQUIRED',
  );
  assert.equal(
    errorCode(() =>
      planPage(
        config,
        course,
        page([], {
          title: 'Blackboard',
          text: '在线教学平台(E-Learning) LOGIN',
          contentFound: false,
        }),
      ),
    ),
    'AUTH_REQUIRED',
  );
  assert.equal(
    errorCode(() =>
      planPage(config, course, page([], { contentFound: false, text: '' })),
    ),
    'SOURCE_LAYOUT_CHANGED',
  );
  assert.deepEqual(
    planPage(
      config,
      course,
      page([], {
        contentFound: false,
        text: 'There are no items in this folder.',
      }),
    ),
    { folders: [], attachments: [], excluded: [] },
  );
  assert.equal(
    errorCode(() => planPage(config, config.courses[3], page())),
    'COURSE_DISABLED',
  );
});

void test('rejects wrong course/source and ignores unsafe or modifying links', () => {
  const wrongCourseUrl = rootUrl.replace('_17870_1', '_17869_1');
  assert.equal(
    errorCode(() =>
      planPage(config, course, page([], { url: wrongCourseUrl })),
    ),
    'SOURCE_LAYOUT_CHANGED',
  );

  const result = planPage(
    config,
    course,
    page([
      {
        href: 'https://evil.example/lecture.pdf',
        text: 'Lecture.pdf',
        context: '',
      },
      {
        href: 'javascript:alert(1)',
        text: 'Lecture.pdf',
        context: '',
      },
      {
        href: '/webapps/blackboard/logout',
        text: 'Lecture.pdf',
        context: '',
      },
      {
        href: '/webapps/blackboard/content/editContent.jsp?course_id=_17870_1&content_id=_90001_2',
        text: 'Lecture.pdf',
        context: '',
      },
      {
        href: '/webapps/blackboard/content/listContent.jsp?course_id=_17869_1&content_id=_90001_2',
        text: 'Other course',
        context: '',
      },
      {
        href: '/bbcswebdav/courses/ece3060/Lecture.pdf?semester=2510UG',
        text: 'Lecture.pdf',
        context: '',
      },
    ]),
  );
  assert.deepEqual(result, { folders: [], attachments: [], excluded: [] });
});

void test('refuses path-escaping names and keeps source identity independent of queries', () => {
  const result = planPage(
    config,
    course,
    page([
      {
        href: '/bbcswebdav/courses/ece3060/%2e%2e%2fLecture.pdf',
        text: 'Lecture.pdf',
        context: '',
      },
    ]),
  );
  assert.equal(result.attachments.length, 0);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].reason, 'out_of_scope');
  assert.ok(!/[\\/]/.test(result.excluded[0].fileName));

  const first = sourceKey(
    course,
    'https://bb.cuhk.edu.cn/bbcswebdav/courses/ece3060/Lecture.pdf?download=1',
  );
  const second = sourceKey(
    config,
    course,
    'https://bb.cuhk.edu.cn/bbcswebdav/courses/ece3060/Lecture.pdf?download=2',
  );
  const otherPath = sourceKey(
    course,
    'https://bb.cuhk.edu.cn/bbcswebdav/courses/ece3060/Lecture-2.pdf',
  );
  assert.equal(first, second);
  assert.notEqual(first, otherPath);
});
