import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createPdfTextCache } from '../lib/pdf-text-cache.ts';
import { createMemoryStore } from '../lib/reader-cache.ts';

const FIXTURE_KEY = '__documentDigestFixture';

interface DigestFixture {
  pages: string[];
  delay: number;
  activeTextPages: number;
  maximumActiveTextPages: number;
  cleanedPages: number[];
  pdfCleanupCalls: number;
  startedPages: number[];
  failPage?: number;
  renderedPages: number[];
}

const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/lib/pdfjs.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export async function loadPdfjs() {
            const getFixture = () => globalThis.${FIXTURE_KEY};
            return {
              getDocument() {
                const fixture = getFixture();
                return { destroy: async () => { getFixture().pdfCleanupCalls += 1; }, promise: Promise.resolve({
                  numPages: fixture.pages.length,
                  getPage: async (pageNumber) => ({
                    getViewport: () => ({height: 1000}),
                    getTextContent: async () => {
                      const current = getFixture();
                      current.startedPages.push(pageNumber);
                      current.activeTextPages += 1;
                      current.maximumActiveTextPages = Math.max(
                        current.maximumActiveTextPages,
                        current.activeTextPages,
                      );
                      try {
                        if (current.failPage === pageNumber) {
                          throw new Error('mock page 2 failed');
                        }
                        await new Promise((resolve) => setTimeout(resolve, current.delay));
                        const text = current.pages[pageNumber - 1];
                        return {items: text ? [{
                          str: text,
                          transform: [1, 0, 0, 12, 40, 940],
                          width: text.length * 8,
                          height: 12,
                        }] : []};
                      } finally {
                        current.activeTextPages -= 1;
                      }
                    },
                    cleanup() {
                      getFixture().cleanedPages.push(pageNumber);
                    },
                  }),
                  cleanup: async () => { getFixture().pdfCleanupCalls += 1; },
                })};
              },
            };
          }
        `,
      };
    }
    if (url.endsWith('/lib/page-vision.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export async function renderPageImage(_pdf, pageNumber) {
            globalThis.${FIXTURE_KEY}.renderedPages.push(pageNumber);
            return {mimeType: 'image/png', dataUrl: 'data:image/png;base64,bW9jaw==', width: 1, height: 1};
          }
          export async function extractPageText() { return ''; }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { extractPdfPages, inspectPdf } = await import('../lib/knowledge/document-digest.ts');
hooks.deregister();

function setFixture(pages: string[], delay = 5): DigestFixture {
  const fixture: DigestFixture = {
    pages,
    delay,
    activeTextPages: 0,
    maximumActiveTextPages: 0,
    cleanedPages: [],
    pdfCleanupCalls: 0,
    startedPages: [],
    renderedPages: [],
  };
  (globalThis as unknown as Record<string, unknown>)[FIXTURE_KEY] = fixture;
  return fixture;
}

void test('native text cache skips repeated extraction, isolates changed PDF bytes, never stores OCR output', async () => {
  const textCache = createPdfTextCache({store:createMemoryStore()});
  const source = 'A lecture page with enough selectable text for native extraction.';
  const fixture = setFixture([source]);
  const file = new File(['cache-original'], 'lecture.pdf');
  const first = await extractPdfPages(file,{textCache});
  await extractPdfPages(file,{textCache});
  assert.deepEqual(fixture.startedPages,[1]);
  await extractPdfPages(new File(['cache-changed'],'lecture.pdf'),{textCache});
  assert.deepEqual(fixture.startedPages,[1,1]);
  const scanned = setFixture(['']);
  const scan = new File(['scan-original'],'scanned.pdf');
  const native = await extractPdfPages(scan,{textCache,allowEmptyText:true});
  let calls=0;
  for (let index=0; index<2; index++) await extractPdfPages(scan,{textCache,recognizePage:async()=>{calls++;return source;}});
  assert.equal(calls,2);
  assert.equal(await textCache.get(native.fingerprint,1),'');
  assert.deepEqual(scanned.startedPages,[1]);
  assert.ok(first.pages[0].includes('lecture'));
});

void test('quick PDF inspection reads only page metadata and destroys its parser', async () => {
  const fixture = setFixture(['first', 'second']);
  const result = await inspectPdf(new File(['pdf'], 'lecture.pdf'));
  assert.equal(result.pageCount, 2);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.startedPages, []);
  assert.deepEqual(fixture.renderedPages, []);
  assert.equal(fixture.pdfCleanupCalls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectPdf(new File(['pdf'], 'lecture.pdf'), controller.signal), /取消/);
});

void test('PDF pages extract in bounded parallelism while retaining page order', async () => {
  const sourcePages = [
    'Page one contains enough selectable text for local extraction.',
    'Page two contains enough selectable text for local extraction.',
    'Page three contains enough selectable text for local extraction.',
    'Page four contains enough selectable text for local extraction.',
    'Page five contains enough selectable text for local extraction.',
  ];
  const fixture = setFixture(sourcePages, 8);
  const progress: number[] = [];

  const extracted = await extractPdfPages(
    new File(['mock pdf'], 'lecture.pdf', { type: 'application/pdf' }),
    {
      pageConcurrency: 2,
      onProgress: (page) => progress.push(page),
    },
  );

  assert.equal(extracted.pageCount, sourcePages.length);
  assert.deepEqual(
    extracted.pages.map((page) => page.replace(/\s+/g, ' ').trim()),
    sourcePages,
  );
  assert.equal(fixture.maximumActiveTextPages, 2);
  assert.deepEqual(
    fixture.cleanedPages.sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  assert.equal(fixture.pdfCleanupCalls, 1);
  assert.deepEqual(
    progress.sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
});

void test('OCR pages use the same bounded pool and receive cancellation signals', { timeout: 5000 }, async () => {
  const fixture = setFixture([
    'A normal selectable page with enough text for extraction.',
    '',
    'Another normal selectable page with enough text for extraction.',
    '',
  ]);
  let activeOcr = 0;
  let maximumActiveOcr = 0;
  const signals: AbortSignal[] = [];
  const recognizedPages: number[] = [];
  let releaseOcr!: () => void;
  const bothOcrStarted = new Promise<void>(resolve => { releaseOcr = resolve; });

  const extracted = await extractPdfPages(
    new File(['mock pdf'], 'scanned-mix.pdf', { type: 'application/pdf' }),
    {
      recognizePage: async ({ pageNumber, signal }) => {
        recognizedPages.push(pageNumber);
        if (!signal) throw new Error('missing OCR cancellation signal');
        signals.push(signal);
        activeOcr += 1;
        maximumActiveOcr = Math.max(maximumActiveOcr, activeOcr);
        // Hold the first task until its peer starts. A 12ms sleep only proved
        // overlap on an idle machine and failed under parallel build load.
        if (activeOcr === 2) releaseOcr();
        await bothOcrStarted;
        activeOcr -= 1;
        return `OCR page ${pageNumber} contains enough recognized text.`;
      },
    },
  );

  assert.deepEqual(
    recognizedPages.sort((a, b) => a - b),
    [2, 4],
  );
  assert.deepEqual(
    fixture.renderedPages.sort((a, b) => a - b),
    [2, 4],
  );
  assert.equal(maximumActiveOcr, 2);
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.equal(
    extracted.pages[1],
    'OCR page 2 contains enough recognized text.',
  );
  assert.equal(
    extracted.pages[3],
    'OCR page 4 contains enough recognized text.',
  );
});

void test('page and document cleanup run when one page fails', async () => {
  const fixture = setFixture([
    'Page one contains enough selectable text for local extraction.',
    'Page two contains enough selectable text for local extraction.',
    'Page three contains enough selectable text for local extraction.',
  ]);
  fixture.failPage = 2;

  await assert.rejects(
    extractPdfPages(
      new File(['mock pdf'], 'broken.pdf', { type: 'application/pdf' }),
      { pageConcurrency: 2 },
    ),
    /mock page 2 failed/,
  );
  assert.deepEqual(
    fixture.startedPages.sort((a, b) => a - b),
    [1, 2],
  );
  assert.deepEqual(
    fixture.cleanedPages.sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal(fixture.pdfCleanupCalls, 1);
});

void test('external cancellation retains the extraction cancellation error', async () => {
  const fixture = setFixture(
    [
      'Page one contains enough selectable text for local extraction.',
      'Page two contains enough selectable text for local extraction.',
    ],
    30,
  );
  const controller = new AbortController();
  const extraction = extractPdfPages(
    new File(['mock pdf'], 'cancelled.pdf', { type: 'application/pdf' }),
    { pageConcurrency: 2, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  controller.abort();

  await assert.rejects(extraction, /PDF 文字提取已取消/);
  assert.equal(fixture.pdfCleanupCalls, 1);
  assert.equal(fixture.cleanedPages.length, fixture.startedPages.length);
});
