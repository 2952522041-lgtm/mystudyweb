import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateQualityCase } from '../lib/quality-evaluation.ts';

interface MutableCase {
  schemaVersion: number;
  id: string;
  provenance: string;
  source: { label: string; pages: string[] };
  expectations: {
    terms: Array<{ source: string; target: string; forbidden: string[] }>;
    facts: Array<{ id: string; page: number; alternatives: string[] }>;
    formulas: Array<{ id: string; page: number; tex: string }>;
  };
  output: {
    label: string;
    text: string;
    sources: Array<Record<string, unknown>>;
  };
}

function baseInput(): MutableCase {
  return {
    schemaVersion: 1,
    id: 'case-001',
    provenance: 'synthetic',
    source: {
      label: '示例教材',
      pages: ['线粒体是细胞的能量工厂，进行有氧呼吸。', 'ATP 是能量货币。', ''],
    },
    expectations: {
      terms: [{ source: '线粒体', target: '线粒体', forbidden: ['粒线体'] }],
      facts: [{ id: 'f1', page: 1, alternatives: ['能量工厂'] }],
      formulas: [{ id: 'eq1', page: 1, tex: 'E = mc^2' }],
    },
    output: {
      label: '模型输出',
      text: '线粒体是细胞的能量工厂。公式 $E = mc^2$。',
      sources: [{ pageStart: 1, pageEnd: 2 }],
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

void test('valid sample reports the expected metrics with no issues', () => {
  const report = evaluateQualityCase(baseInput());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.id, 'case-001');
  assert.equal(report.provenance, 'synthetic');
  assert.equal(report.sourceLabel, '示例教材');
  assert.equal(report.outputLabel, '模型输出');
  assert.equal(report.manualReviewRequired, true);
  assert.deepEqual(report.metrics, {
    factMatches: 1,
    totalFacts: 1,
    termIssues: 0,
    formulaMatches: 1,
    totalFormulas: 1,
    formulaFallbacks: 0,
    invalidSources: 0,
  });
  assert.deepEqual(report.issues, []);
});

void test('document provenance is accepted and echoed', () => {
  const input = baseInput();
  input.provenance = 'document';
  const report = evaluateQualityCase(input);
  assert.equal(report.provenance, 'document');
});

void test('bad term reports missing preferred form and forbidden variant once per term', () => {
  const input = baseInput();
  input.output.text = '粒线体是细胞的能量工厂。';
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 1);
  assert.ok(
    report.issues.some(
      (issue) => issue.kind === 'term' && issue.message.includes('首选'),
    ),
  );
  assert.ok(
    report.issues.some(
      (issue) => issue.kind === 'term' && issue.message.includes('粒线体'),
    ),
  );
});

void test('term absent from source is ignored even when missing from output', () => {
  const input = baseInput();
  input.source.pages = ['叶绿体进行光合作用。'];
  input.expectations = {
    terms: [{ source: '线粒体', target: '线粒体', forbidden: ['粒线体'] }],
    facts: [],
    formulas: [],
  };
  input.output.text = '这里没有相关术语。';
  input.output.sources = [{ pageStart: 1 }];
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 0);
  assert.deepEqual(report.issues, []);
});

void test('ASCII word boundaries keep mass from matching massive', () => {
  // Target check: source has "mass", output only has "massive" -> preferred missing.
  let input = baseInput();
  input.source.pages = ['The mass of the object is 5 kg.'];
  input.expectations = {
    terms: [{ source: 'mass', target: 'mass', forbidden: [] }],
    facts: [],
    formulas: [],
  };
  input.output.text = 'The massive object moves fast.';
  input.output.sources = [{ pageStart: 1 }];
  let report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 1);

  // Source check: term is only a substring of "massive" -> source occurrence ignored.
  input = baseInput();
  input.source.pages = ['The massive object moves fast.'];
  input.expectations = {
    terms: [{ source: 'mass', target: 'mass', forbidden: [] }],
    facts: [],
    formulas: [],
  };
  input.output.text = 'mass';
  input.output.sources = [{ pageStart: 1 }];
  report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 0);

  // Exact bounded occurrence is accepted.
  input = baseInput();
  input.source.pages = ['The mass of the object is 5 kg.'];
  input.expectations = {
    terms: [{ source: 'mass', target: 'mass', forbidden: [] }],
    facts: [],
    formulas: [],
  };
  input.output.text = 'The mass is 5 kg.';
  input.output.sources = [{ pageStart: 1 }];
  report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 0);
  assert.deepEqual(report.issues, []);
});

void test('CJK term matches next to Latin text and matching stays case sensitive', () => {
  // Preferred target 质量 followed by Latin "m" must still count as present.
  let input = baseInput();
  input.source.pages = ['质量是物体的固有属性。'];
  input.expectations = {
    terms: [{ source: '质量', target: '质量', forbidden: [] }],
    facts: [],
    formulas: [],
  };
  input.output.text = '物体的质量m决定了加速度。';
  input.output.sources = [{ pageStart: 1 }];
  let report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 0);

  // A leading Latin symbol must not block the CJK target either.
  input = baseInput();
  input.source.pages = ['质量是物体的固有属性。'];
  input.expectations = {
    terms: [{ source: '质量', target: '质量', forbidden: [] }],
    facts: [],
    formulas: [],
  };
  input.output.text = 'm质量与加速度有关。';
  input.output.sources = [{ pageStart: 1 }];
  report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 0);

  // Matching is case sensitive: target "Mass" does not match output "mass".
  input = baseInput();
  input.source.pages = ['The mass is constant.'];
  input.expectations = {
    terms: [{ source: 'mass', target: 'Mass', forbidden: [] }],
    facts: [],
    formulas: [],
  };
  input.output.text = 'The mass is constant.';
  input.output.sources = [{ pageStart: 1 }];
  report = evaluateQualityCase(input);
  assert.equal(report.metrics.termIssues, 1);
});

void test('facts match aliases case-insensitively but flag missing literals for review', () => {
  const input = baseInput();
  input.expectations = {
    terms: [],
    facts: [
      { id: 'f1', page: 1, alternatives: ['atp', '能量货币'] },
      { id: 'f2', page: 2, alternatives: ['细胞动力站'] },
    ],
    formulas: [],
  };
  input.output.text = 'ATP 是细胞的能量货币。';
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.totalFacts, 2);
  assert.equal(report.metrics.factMatches, 1);
  const factIssues = report.issues.filter((issue) => issue.kind === 'fact');
  assert.equal(factIssues.length, 1);
  assert.equal(factIssues[0].id, 'f2');
  assert.equal(factIssues[0].page, 2);
  assert.match(factIssues[0].message, /人工复核/);
});

void test('malformed delimited formula produces a formula issue and one fallback', () => {
  const input = baseInput();
  input.expectations = {
    terms: [],
    facts: [{ id: 'f1', page: 1, alternatives: ['线索'] }],
    formulas: [],
  };
  input.output.text = '线索：$\\frac{1}{$';
  input.output.sources = [{ pageStart: 1 }];
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.formulaMatches, 0);
  assert.equal(report.metrics.formulaFallbacks, 1);
  const formulaIssues = report.issues.filter(
    (issue) => issue.kind === 'formula',
  );
  assert.equal(formulaIssues.length, 1);
  assert.match(formulaIssues[0].message, /无法解析|未闭合/);
});

void test('missing expected formula stays an issue without incrementing formulaFallbacks', () => {
  const input = baseInput();
  input.expectations = {
    terms: [],
    facts: [],
    formulas: [{ id: 'eq1', page: 1, tex: 'a^2 + b^2 = c^2' }],
  };
  input.output.text = '这里没有任何定界公式。';
  input.output.sources = [{ pageStart: 1 }];
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.totalFormulas, 1);
  assert.equal(report.metrics.formulaMatches, 0);
  assert.equal(report.metrics.formulaFallbacks, 0);
  assert.equal(
    report.issues.filter((issue) => issue.kind === 'formula').length,
    1,
  );
});

void test('formulaFallbacks counts invalid output spans only when expectations are empty', () => {
  let input = baseInput();
  input.expectations = {
    terms: [],
    facts: [{ id: 'f1', page: 1, alternatives: ['线索'] }],
    formulas: [],
  };
  input.output.text = '线索：$\\frac{1}{$';
  input.output.sources = [{ pageStart: 1 }];
  let report = evaluateQualityCase(input);
  assert.equal(report.metrics.totalFormulas, 0);
  assert.equal(report.metrics.formulaMatches, 0);
  assert.equal(report.metrics.formulaFallbacks, 1);

  // A clean output missing a valid expected formula has no fallback candidate.
  input = baseInput();
  input.expectations = {
    terms: [],
    facts: [],
    formulas: [{ id: 'eq1', page: 1, tex: 'a^2 + b^2 = c^2' }],
  };
  input.output.text = '输出干净，但没有公式。';
  input.output.sources = [{ pageStart: 1 }];
  report = evaluateQualityCase(input);
  assert.equal(report.metrics.totalFormulas, 1);
  assert.equal(report.metrics.formulaMatches, 0);
  assert.equal(report.metrics.formulaFallbacks, 0);
  assert.equal(
    report.issues.filter((issue) => issue.kind === 'formula').length,
    1,
  );
});

void test('unmatched dollar currency is not treated as a formula', () => {
  const input = baseInput();
  input.expectations = {
    terms: [],
    facts: [{ id: 'f1', page: 1, alternatives: ['价格'] }],
    formulas: [],
  };
  input.output.text = '价格是 $5，不构成公式。';
  input.output.sources = [{ pageStart: 1 }];
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.formulaFallbacks, 0);
  assert.equal(
    report.issues.filter((issue) => issue.kind === 'formula').length,
    0,
  );
  assert.deepEqual(report.issues, []);
});

void test('code fences and inline code are masked before math scanning', () => {
  let input = baseInput();
  input.expectations = {
    terms: [],
    facts: [{ id: 'f1', page: 1, alternatives: ['线索'] }],
    formulas: [],
  };
  input.output.text =
    '线索\n```\n$\\frac{1}{$\n```\n行内 `$\\frac{1}{$` 同样在代码中';
  input.output.sources = [{ pageStart: 1 }];
  let report = evaluateQualityCase(input);
  assert.equal(
    report.issues.filter((issue) => issue.kind === 'formula').length,
    0,
  );

  // A formula hidden inside code must not satisfy an expectation.
  input = baseInput();
  input.expectations = {
    terms: [],
    facts: [],
    formulas: [{ id: 'eq1', page: 1, tex: 'E=mc^2' }],
  };
  input.output.text = '```\n$E=mc^2$\n```';
  input.output.sources = [{ pageStart: 1 }];
  report = evaluateQualityCase(input);
  assert.equal(report.metrics.formulaMatches, 0);
  assert.equal(report.metrics.formulaFallbacks, 0);
});

void test('valid source references pass and invalid or missing ones are counted', () => {
  let input = baseInput();
  input.output.sources = [
    { pageStart: 1 },
    { pageStart: 1, pageEnd: 3 },
    { pageStart: 3 },
  ];
  assert.equal(evaluateQualityCase(input).metrics.invalidSources, 0);

  input = baseInput();
  input.output.sources = [
    { pageStart: 0 },
    { pageStart: 2, pageEnd: 1 },
    { pageStart: 4 },
    { pageStart: 1.5 },
    { pageStart: 1, pageEnd: 2.5 },
  ];
  const report = evaluateQualityCase(input);
  assert.equal(report.metrics.invalidSources, 5);
  assert.ok(report.issues.every((issue) => issue.kind === 'source'));

  input = baseInput();
  input.output.sources = [];
  const missing = evaluateQualityCase(input);
  assert.equal(missing.metrics.invalidSources, 1);
  assert.equal(
    missing.issues.filter((issue) => issue.kind === 'source').length,
    1,
  );
});

void test('blank output produces an empty-output issue and still requires manual review', () => {
  const input = baseInput();
  input.output.text = '   \n  ';
  const report = evaluateQualityCase(input);
  assert.ok(report.issues.some((issue) => issue.kind === 'empty-output'));
  assert.equal(report.manualReviewRequired, true);
});

void test('unknown and structurally bad inputs throw concise Chinese errors', () => {
  for (const bad of [null, undefined, 'text', 42, true, [], [{}]]) {
    assert.throws(() => evaluateQualityCase(bad), /案例|对象|JSON/);
  }
  assert.throws(() => evaluateQualityCase({}), /schemaVersion/);
  assert.throws(
    () => evaluateQualityCase({ ...baseInput(), schemaVersion: 2 }),
    /schemaVersion/,
  );
  assert.throws(
    () => evaluateQualityCase({ ...baseInput(), provenance: 'other' }),
    /provenance/,
  );
  assert.throws(() => evaluateQualityCase({ ...baseInput(), id: '   ' }), /id/);
  assert.throws(
    () =>
      evaluateQualityCase({
        ...baseInput(),
        source: { label: 'x', pages: [] },
      }),
    /source\.pages/,
  );
  assert.throws(
    () =>
      evaluateQualityCase({
        ...baseInput(),
        source: { label: 'x', pages: Array.from({ length: 1001 }, () => '') },
      }),
    /1000/,
  );
});

void test('malformed expectations are rejected', () => {
  const duplicateFacts = baseInput();
  duplicateFacts.expectations.facts = [
    { id: 'f1', page: 1, alternatives: ['a'] },
    { id: 'f1', page: 1, alternatives: ['b'] },
  ];
  assert.throws(() => evaluateQualityCase(duplicateFacts), /重复/);

  const duplicateFormulas = baseInput();
  duplicateFormulas.expectations.formulas = [
    { id: 'eq1', page: 1, tex: 'a' },
    { id: 'eq1', page: 1, tex: 'b' },
  ];
  assert.throws(() => evaluateQualityCase(duplicateFormulas), /重复/);

  const badPage = baseInput();
  badPage.expectations.facts[0].page = 9;
  assert.throws(() => evaluateQualityCase(badPage), /page/);

  const zeroPage = baseInput();
  zeroPage.expectations.formulas[0].page = 0;
  assert.throws(() => evaluateQualityCase(zeroPage), /page/);

  const emptyAlternative = baseInput();
  emptyAlternative.expectations.facts[0].alternatives = [];
  assert.throws(() => evaluateQualityCase(emptyAlternative), /alternatives/);

  const blankAlternative = baseInput();
  blankAlternative.expectations.facts[0].alternatives = ['  '];
  assert.throws(() => evaluateQualityCase(blankAlternative), /alternatives/);

  const emptyTarget = baseInput();
  emptyTarget.expectations.terms[0].target = '';
  assert.throws(() => evaluateQualityCase(emptyTarget), /target/);

  const emptyTex = baseInput();
  emptyTex.expectations.formulas[0].tex = '   ';
  assert.throws(() => evaluateQualityCase(emptyTex), /tex/);

  const noExpectations = baseInput();
  noExpectations.expectations = { terms: [], facts: [], formulas: [] };
  assert.throws(() => evaluateQualityCase(noExpectations), /至少/);

  const tooManyFacts = baseInput();
  tooManyFacts.expectations.facts = Array.from(
    { length: 1001 },
    (_, index) => ({
      id: `f${index}`,
      page: 1,
      alternatives: ['a'],
    }),
  );
  assert.throws(() => evaluateQualityCase(tooManyFacts), /1000/);
});

void test('string, source count and overall size limits are enforced', () => {
  const longString = baseInput();
  longString.output.text = 'a'.repeat(1_000_001);
  assert.throws(() => evaluateQualityCase(longString), /1M|超过/);

  const manySources = baseInput();
  manySources.output.sources = Array.from({ length: 10001 }, () => ({
    pageStart: 1,
  }));
  assert.throws(() => evaluateQualityCase(manySources), /10000/);

  const oversized = { payload: 'a'.repeat(8 * 1024 * 1024 + 1) };
  assert.throws(() => evaluateQualityCase(oversized), /8 MiB|超过/);
});

void test('evaluation does not mutate its input', () => {
  const input = baseInput();
  const snapshot = structuredClone(input);
  evaluateQualityCase(input);
  assert.deepEqual(input, snapshot);

  const frozen = deepFreeze(baseInput());
  assert.doesNotThrow(() => evaluateQualityCase(frozen));
});

void test('every report requires manual review and exposes no pass/fail or blended score', () => {
  const reports = [
    evaluateQualityCase(baseInput()),
    evaluateQualityCase({
      ...baseInput(),
      output: { label: 'x', text: '', sources: [] },
    }),
  ];
  for (const report of reports) {
    assert.equal(report.manualReviewRequired, true);
    assert.equal('score' in report, false);
    assert.equal('pass' in report, false);
    assert.equal('passed' in report, false);
    assert.equal(report.schemaVersion, 1);
  }
});
