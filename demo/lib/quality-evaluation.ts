/**
 * 纯离线的质量诊断助手：对人工标注来源引用做确定性的词法/格式检查，
 * 不做 IO、网络或 AI 调用。无法字面确认的内容一律转交人工复核。
 */

import katex from 'katex';
import { mathSpans } from './scientific-text.ts';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 1000;
const MAX_EXPECTATIONS = 1000;
const MAX_OUTPUT_SOURCES = 10000;
const MAX_STRING_LENGTH = 1_000_000;

export type QualityProvenance = 'synthetic' | 'document';

export interface QualityTermExpectation {
  source: string;
  target: string;
  forbidden: string[];
}

export interface QualityFactExpectation {
  id: string;
  page: number;
  alternatives: string[];
}

export interface QualityFormulaExpectation {
  id: string;
  page: number;
  tex: string;
}

export interface QualitySource {
  label: string;
  pages: string[];
}

export interface QualityOutputSourceRef {
  pageStart: number;
  pageEnd?: number;
}

export interface QualityOutput {
  label: string;
  text: string;
  sources: QualityOutputSourceRef[];
}

export interface QualityExpectations {
  terms: QualityTermExpectation[];
  facts: QualityFactExpectation[];
  formulas: QualityFormulaExpectation[];
}

export interface QualityCase {
  schemaVersion: 1;
  id: string;
  provenance: QualityProvenance;
  source: QualitySource;
  expectations: QualityExpectations;
  output: QualityOutput;
}

export type QualityIssueKind =
  | 'fact'
  | 'term'
  | 'formula'
  | 'source'
  | 'empty-output';

export interface QualityIssue {
  kind: QualityIssueKind;
  id?: string;
  page?: number;
  message: string;
}

export interface QualityMetrics {
  factMatches: number;
  totalFacts: number;
  termIssues: number;
  formulaMatches: number;
  totalFormulas: number;
  /** 输出中无法解析或未闭合的定界公式数量（渲染回退候选）。 */
  formulaFallbacks: number;
  invalidSources: number;
}

export interface QualityReport {
  schemaVersion: 1;
  id: string;
  provenance: QualityProvenance;
  sourceLabel: string;
  outputLabel: string;
  metrics: QualityMetrics;
  issues: QualityIssue[];
  manualReviewRequired: true;
}

interface ValidatedCase {
  id: string;
  provenance: QualityProvenance;
  sourceLabel: string;
  sourcePages: string[];
  terms: QualityTermExpectation[];
  facts: QualityFactExpectation[];
  formulas: QualityFormulaExpectation[];
  outputLabel: string;
  outputText: string;
  /** 输出引用是待评估数据，结构上不预判，交给来源检查逐条判定。 */
  outputSources: unknown[];
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonSize(input: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    fail('输入无法序列化为 JSON。');
  }
  if (serialized === undefined) fail('输入必须是可序列化的 JSON 数据。');
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_JSON_BYTES) fail('输入超过 8 MiB 上限。');
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(`${name} 必须是字符串。`);
  if (value.length > MAX_STRING_LENGTH) fail(`${name} 超过 1M 字符上限。`);
  return value;
}

function requireNonBlankString(value: unknown, name: string): string {
  const text = requireString(value, name);
  if (text.trim().length === 0) fail(`${name} 不能为空。`);
  return text;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`${name} 必须是数组。`);
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  const array = requireArray(value, name);
  return array.map((item, index) => requireString(item, `${name}[${index}]`));
}

function requireExpectationPage(
  value: unknown,
  name: string,
  pageCount: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > pageCount
  ) {
    fail(`${name} 必须是 1..${pageCount} 之间的整数。`);
  }
  return value;
}

function validateCase(input: unknown): ValidatedCase {
  assertJsonSize(input);
  if (!isRecord(input)) fail('案例必须是 JSON 对象。');
  if (input.schemaVersion !== 1) fail('schemaVersion 必须为 1。');

  const id = requireNonBlankString(input.id, 'id');
  const provenance = input.provenance;
  if (provenance !== 'synthetic' && provenance !== 'document') {
    fail('provenance 必须是 synthetic 或 document。');
  }

  if (!isRecord(input.source)) fail('source 必须是对象。');
  const sourceLabel = requireNonBlankString(input.source.label, 'source.label');
  const sourcePages = requireStringArray(input.source.pages, 'source.pages');
  if (sourcePages.length === 0) fail('source.pages 不能为空。');
  if (sourcePages.length > MAX_PAGES) fail('source.pages 不能超过 1000 页。');

  if (!isRecord(input.expectations)) fail('expectations 必须是对象。');
  const rawTerms = requireArray(input.expectations.terms, 'expectations.terms');
  const rawFacts = requireArray(input.expectations.facts, 'expectations.facts');
  const rawFormulas = requireArray(
    input.expectations.formulas,
    'expectations.formulas',
  );
  if (rawTerms.length > MAX_EXPECTATIONS)
    fail('expectations.terms 不能超过 1000 项。');
  if (rawFacts.length > MAX_EXPECTATIONS)
    fail('expectations.facts 不能超过 1000 项。');
  if (rawFormulas.length > MAX_EXPECTATIONS)
    fail('expectations.formulas 不能超过 1000 项。');
  if (rawTerms.length + rawFacts.length + rawFormulas.length === 0) {
    fail('expectations 至少需要一个 terms、facts 或 formulas 项。');
  }

  const terms = rawTerms.map((raw, index): QualityTermExpectation => {
    const prefix = `expectations.terms[${index}]`;
    if (!isRecord(raw)) fail(`${prefix} 必须是对象。`);
    const source = requireNonBlankString(raw.source, `${prefix}.source`);
    const target = requireNonBlankString(raw.target, `${prefix}.target`);
    const forbidden = requireStringArray(raw.forbidden, `${prefix}.forbidden`);
    forbidden.forEach((variant, variantIndex) => {
      if (variant.trim().length === 0)
        fail(`${prefix}.forbidden[${variantIndex}] 不能为空。`);
    });
    return { source, target, forbidden };
  });

  const factIds = new Set<string>();
  const facts = rawFacts.map((raw, index): QualityFactExpectation => {
    const prefix = `expectations.facts[${index}]`;
    if (!isRecord(raw)) fail(`${prefix} 必须是对象。`);
    const factId = requireNonBlankString(raw.id, `${prefix}.id`);
    if (factIds.has(factId)) fail(`事实 ID 重复：${factId}。`);
    factIds.add(factId);
    const page = requireExpectationPage(
      raw.page,
      `${prefix}.page`,
      sourcePages.length,
    );
    const alternatives = requireStringArray(
      raw.alternatives,
      `${prefix}.alternatives`,
    );
    if (alternatives.length === 0) fail(`${prefix}.alternatives 不能为空。`);
    alternatives.forEach((alternative, alternativeIndex) => {
      if (alternative.trim().length === 0)
        fail(`${prefix}.alternatives[${alternativeIndex}] 不能为空。`);
    });
    return { id: factId, page, alternatives };
  });

  const formulaIds = new Set<string>();
  const formulas = rawFormulas.map((raw, index): QualityFormulaExpectation => {
    const prefix = `expectations.formulas[${index}]`;
    if (!isRecord(raw)) fail(`${prefix} 必须是对象。`);
    const formulaId = requireNonBlankString(raw.id, `${prefix}.id`);
    if (formulaIds.has(formulaId)) fail(`公式 ID 重复：${formulaId}。`);
    formulaIds.add(formulaId);
    const page = requireExpectationPage(
      raw.page,
      `${prefix}.page`,
      sourcePages.length,
    );
    const tex = requireNonBlankString(raw.tex, `${prefix}.tex`);
    return { id: formulaId, page, tex };
  });

  if (!isRecord(input.output)) fail('output 必须是对象。');
  const outputLabel = requireNonBlankString(input.output.label, 'output.label');
  const outputText = requireString(input.output.text, 'output.text');
  const outputSources = requireArray(input.output.sources, 'output.sources');
  if (outputSources.length > MAX_OUTPUT_SOURCES)
    fail('output.sources 不能超过 10000 项。');

  return {
    id,
    provenance,
    sourceLabel,
    sourcePages,
    terms,
    facts,
    formulas,
    outputLabel,
    outputText,
    outputSources,
  };
}

function isAsciiWordChar(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

/**
 * NFKC 后的大小写敏感字面检测：只有 needle 的首/尾字符是 ASCII 词字符时，
 * 才分别要求前/后边界，避免 CJK 术语紧邻拉丁字符时被误判为不匹配。
 */
function literalOccursWithBoundaries(text: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const requireBefore = isAsciiWordChar(needle[0]);
  const requireAfter = isAsciiWordChar(needle[needle.length - 1]);
  let index = text.indexOf(needle);
  while (index !== -1) {
    const before = index > 0 ? text[index - 1] : undefined;
    const afterIndex = index + needle.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    if (
      (!requireBefore || !isAsciiWordChar(before)) &&
      (!requireAfter || !isAsciiWordChar(after))
    ) {
      return true;
    }
    index = text.indexOf(needle, index + 1);
  }
  return false;
}

/** 事实专用归一化：NFKC、折叠空白、转小写（仅事实别名使用）。 */
function normalizeFactText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 公式比较只忽略空白。 */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

/** 把代码围栏与行内代码替换为等长空白，避免在其中扫描公式。 */
function maskCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (match) => match.replace(/[^\n]/g, ' '));
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

export function evaluateQualityCase(input: unknown): QualityReport {
  const validated = validateCase(input);
  const pageCount = validated.sourcePages.length;
  const issues: QualityIssue[] = [];

  const outputText = validated.outputText;
  if (outputText.trim().length === 0) {
    issues.push({
      kind: 'empty-output',
      message: '输出文本为空，无法进行内容核验，需人工复核。',
    });
  }

  // 事实：只做字面关键词线索匹配，绝不代表语义通过。
  const normalizedOutput = normalizeFactText(outputText);
  let factMatches = 0;
  for (const fact of validated.facts) {
    const matched = fact.alternatives.some((alternative) => {
      const normalizedAlternative = normalizeFactText(alternative);
      return (
        normalizedAlternative.length > 0 &&
        normalizedOutput.includes(normalizedAlternative)
      );
    });
    if (matched) {
      factMatches += 1;
    } else {
      issues.push({
        kind: 'fact',
        id: fact.id,
        page: fact.page,
        message: `事实「${fact.id}」的字面关键词未在输出中出现，可能被等价改写，需人工复核；本诊断只把命中当作线索，不判断语义是否正确。`,
      });
    }
  }

  // 术语：仅当来源页中确实出现该术语时才评估。
  const normalizedSource = validated.sourcePages.join('\n').normalize('NFKC');
  const normalizedTermOutput = outputText.normalize('NFKC');
  let termIssues = 0;
  for (const term of validated.terms) {
    const sourceTerm = term.source.normalize('NFKC');
    if (!literalOccursWithBoundaries(normalizedSource, sourceTerm)) continue; // 来源中不存在，忽略。
    const problems: string[] = [];
    const target = term.target.normalize('NFKC');
    if (!literalOccursWithBoundaries(normalizedTermOutput, target)) {
      problems.push(`缺少首选术语「${term.target}」`);
    }
    const forbiddenFound = term.forbidden.filter((forbidden) =>
      literalOccursWithBoundaries(
        normalizedTermOutput,
        forbidden.normalize('NFKC'),
      ),
    );
    if (forbiddenFound.length > 0) {
      problems.push(
        `出现禁用变体：${forbiddenFound.map((forbidden) => `「${forbidden}」`).join('、')}`,
      );
    }
    if (problems.length > 0) {
      termIssues += 1;
      issues.push({
        kind: 'term',
        message: `术语「${term.source}」需要人工复核：${problems.join('；')}。`,
      });
    }
  }

  // 公式：屏蔽代码后扫描定界公式；无法解析或未闭合的片段计入 formulaFallbacks。
  const maskedOutput = maskCode(outputText);
  const spans = mathSpans(maskedOutput);
  const validBodies: string[] = [];
  let formulaFallbacks = 0;
  for (const span of spans) {
    let invalid = !span.closed;
    if (!invalid) {
      try {
        katex.renderToString(span.body, {
          trust: false,
          strict: 'ignore',
          maxExpand: 1000,
          throwOnError: true,
          displayMode: span.display,
        });
      } catch {
        invalid = true;
      }
    }
    if (invalid) {
      formulaFallbacks += 1;
      issues.push({
        kind: 'formula',
        message:
          '输出中存在无法解析或未闭合的定界公式片段，需人工复核；本诊断不判断公式等价性（化学式亦不在支持范围内）。',
      });
    } else {
      validBodies.push(stripWhitespace(span.body));
    }
  }

  let formulaMatches = 0;
  for (const formula of validated.formulas) {
    const expected = stripWhitespace(formula.tex);
    if (expected.length > 0 && validBodies.includes(expected)) {
      formulaMatches += 1;
    } else {
      issues.push({
        kind: 'formula',
        id: formula.id,
        page: formula.page,
        message: `未能在输出中找到与预期公式（id=${formula.id}）字面一致的定界公式，可能是等价改写或格式差异，需人工复核；本诊断不做等价性判断。`,
      });
    }
  }

  // 来源引用：坏引用只作为待评估数据，绝不抛错。
  let invalidSources = 0;
  if (validated.outputSources.length === 0) {
    invalidSources += 1;
    issues.push({
      kind: 'source',
      message: '输出未提供任何来源页引用，无法核验来源覆盖，需人工复核。',
    });
  }
  for (let index = 0; index < validated.outputSources.length; index += 1) {
    const raw = validated.outputSources[index];
    if (!isRecord(raw)) {
      invalidSources += 1;
      issues.push({
        kind: 'source',
        message: `output.sources[${index}] 不是有效的来源引用对象，需人工复核。`,
      });
      continue;
    }
    const start = raw.pageStart;
    const end = raw.pageEnd;
    const startOk =
      typeof start === 'number' &&
      Number.isInteger(start) &&
      start >= 1 &&
      start <= pageCount;
    const endOk =
      end === undefined ||
      (startOk &&
        typeof end === 'number' &&
        Number.isInteger(end) &&
        end >= (start as number) &&
        end <= pageCount);
    if (!startOk || !endOk) {
      invalidSources += 1;
      const issue: QualityIssue = {
        kind: 'source',
        message: `来源引用无效：pageStart=${describeValue(start)}，pageEnd=${describeValue(end)}（有效范围为 1..${pageCount} 的整数）。`,
      };
      if (startOk) issue.page = start as number;
      issues.push(issue);
    }
  }

  return {
    schemaVersion: 1,
    id: validated.id,
    provenance: validated.provenance,
    sourceLabel: validated.sourceLabel,
    outputLabel: validated.outputLabel,
    metrics: {
      factMatches,
      totalFacts: validated.facts.length,
      termIssues,
      formulaMatches,
      totalFormulas: validated.formulas.length,
      formulaFallbacks,
      invalidSources,
    },
    issues,
    manualReviewRequired: true,
  };
}
