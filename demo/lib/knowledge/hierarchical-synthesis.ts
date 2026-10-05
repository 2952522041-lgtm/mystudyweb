import { sha256Hex } from '../course-storage/file-utils.ts';
import type { SourceReference } from '../course-storage/types.ts';
import { mapWithConcurrency } from '../async-pool.ts';

/** UTF-8 bytes are a conservative, tokenizer-independent input measure, not a model context claim. */
export const SYNTHESIS_BUDGET = {
  chunk: 48000,
  document: 64000,
  course: 64000,
  payload: 24000,
  // Final synthesis has no subsequent reduction target. Allow two compacted
  // batches to join while the provider still enforces the full message limit.
  finalPayload: 36000,
  intermediate: 10000,
  rounds: 8,
} as const;
export const HIERARCHICAL_PROMPT_VERSION = 'hierarchical-v2';
export type SynthesisLayer = 'chunk' | 'document' | 'course';
export interface SynthesisDiagnostic {
  layer: SynthesisLayer;
  affected?: Array<{
    sources: SourceReference[];
    bytes: number;
    preview: string;
  }>;
  action:
    | 'split'
    | 'request'
    | 'request-timing'
    | 'completed'
    | 'cache-hit'
    | 'cache-unavailable'
    | 'rejected'
    | 'quality-restored';
  identity: string;
  inputBytes: number;
  outputBytes?: number;
  timing?: import('../openai-client.ts').ChatCompletionTiming;
  limit: number;
  droppedItems: number;
  droppedBytes: number;
  detail: string;
}
export interface KnowledgeEvidence {
  text: string;
  sources: SourceReference[];
}
/** Maps a document identity to its local file name without repeating it per source. */
export type SourceFileNameMap = Readonly<Record<string, string>>;
export const utf8Size = (value: unknown): number =>
  new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).length;
export async function synthesisCacheKey(parts: {
  layer: SynthesisLayer;
  identity: string;
  provider: string;
  model: string;
  promptVersion: string;
  input: unknown;
}): Promise<string> {
  return `hierarchy:${parts.layer}:${await sha256Hex(new TextEncoder().encode(JSON.stringify(parts)).buffer)}`;
}

/** Split at schema boundaries only. An indivisible formula/table is never sliced. */
export function synthesisRecords(
  value: unknown,
  identity: Record<string, unknown> = {},
  sourceFileNames?: SourceFileNameMap,
): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return [{ ...identity, value }];
  const object = value as Record<string, unknown>;
  const { sections, concepts, relations, ...header } = object;
  // The header can become a standalone batch after adaptive splitting. Carry the
  // actual document ranges so it never loses provenance when separated from sections.
  const documentId = identity.documentId ?? object.documentId;
  const fileName = identity.fileName ?? object.fileName;
  const provenance = synthesisSources(object, typeof documentId === 'string' && typeof fileName === 'string'
    ? { documentId, fileName, pageStart: 1, type: 'pdf' }
    : typeof documentId === 'string' ? { documentId, pageStart: 1, type: 'pdf' } as SourceReference : undefined,
    sourceFileNames,
  ).map((source) => sourceFileNames
    ? (({ fileName: _fileName, type: _type, ...compactSource }) => compactSource)(source)
    : source);
  const records: unknown[] = [{ ...identity, ...header,
    ...(provenance.length ? { provenance } : {}) }];
  for (const section of Array.isArray(sections) ? sections : []) {
    const { points, ...fields } = section as Record<string, unknown>;
    records.push({ ...identity, section: fields });
    for (const point of Array.isArray(points) ? points : [])
      records.push({ ...identity, sectionTitle: fields.title, point });
  }
  for (const concept of Array.isArray(concepts) ? concepts : [])
    records.push({ ...identity, concept });
  const conceptById = new Map<string, Record<string, unknown> | null>();
  for (const concept of Array.isArray(concepts) ? concepts : []) {
    if (!concept || typeof concept !== 'object' || Array.isArray(concept)) continue;
    const item = concept as Record<string, unknown>;
    if (typeof item.id !== 'string') continue;
    conceptById.set(item.id, conceptById.has(item.id) ? null : item);
  }
  for (const relation of Array.isArray(relations) ? relations : []) {
    let relationSources: SourceReference[] = [];
    if (relation && typeof relation === 'object' && !Array.isArray(relation)) {
      const item = relation as Record<string, unknown>;
      const endpointConcepts = [item.from, item.to]
        .filter((endpoint): endpoint is string => typeof endpoint === 'string')
        .map((endpoint) => conceptById.get(endpoint))
        .filter((concept): concept is Record<string, unknown> => Boolean(concept));
      relationSources = synthesisSources(endpointConcepts, undefined, sourceFileNames);
    }
    const provenance = relationSources.length
      ? relationSources.map((source) => sourceFileNames
        ? (({ fileName: _fileName, type: _type, ...compactSource }) => compactSource)(source)
        : source)
      : undefined;
    records.push({ ...identity, relation, ...(provenance ? { provenance } : {}) });
  }
  return records;
}

/** Validates an explicit final byte budget once; omitted means the existing default. */
function resolveFinalPayloadLimit(
  limit: number | undefined,
  layer: 'document' | 'course',
): number {
  if (limit === undefined) return SYNTHESIS_BUDGET.finalPayload;
  const maximum = SYNTHESIS_BUDGET[layer];
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < SYNTHESIS_BUDGET.payload ||
    limit > maximum
  )
    throw new RangeError(
      `finalPayloadLimit 必须是 ${SYNTHESIS_BUDGET.payload} 到 ${maximum} 之间的安全整数；收到 ${String(limit)}。`,
    );
  return limit;
}

export async function reduceWithinBudget(options: {
  records: unknown[];
  layer: 'document' | 'course';
  identity: string;
  signal?: AbortSignal;
  report: (diagnostic: SynthesisDiagnostic) => void;
  shouldSplit?: (error: unknown) => boolean;
  /** UTF-8 JSON bytes of records only; full request budgets remain independently enforced. */
  finalPayloadLimit?: number;
  reduce: (
    records: unknown[],
    identity: string,
    intermediate: boolean,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}): Promise<unknown> {
  const finalPayloadLimit = resolveFinalPayloadLimit(
    options.finalPayloadLimit,
    options.layer,
  );
  const reduceSafely = async (
    records: unknown[],
    identity: string,
    intermediate: boolean,
    signal: AbortSignal | undefined = options.signal,
    depth = 0,
  ): Promise<unknown> => {
    if (signal?.aborted) throw signal.reason ?? new Error('分层综合已取消。');
    try {
      const result = await options.reduce(records, identity, intermediate, signal);
      if (signal?.aborted) throw signal.reason ?? new Error('分层综合已取消。');
      return result;
    }
    catch (error) {
      if (signal?.aborted || !options.shouldSplit?.(error) || depth >= 5 || utf8Size(records) < 1500) throw error;
      let limit = Math.floor(utf8Size(records) / 2);
      // A previously complete digest is separable at section/concept boundaries.
      const units = records.flatMap(record => {
        if (utf8Size([record]) <= limit || !record || typeof record !== 'object'
          || !['sections', 'concepts', 'relations'].some(key => Array.isArray((record as Record<string, unknown>)[key]))) return [record];
        const metadata = record && typeof record === 'object'
          ? Object.fromEntries(Object.entries(record).filter(([key]) => ['documentId', 'fileName', 'chunkIndex', 'provenance'].includes(key))) : {};
        return synthesisRecords(record, metadata);
      });
      if (units.length < 2) throw error;
      limit = Math.max(limit, ...units.map(unit => utf8Size([unit])));
      const batches: unknown[][] = [];
      let batch: unknown[] = [];
      for (const unit of units) {
        if (batch.length && utf8Size([...batch, unit]) > limit) { batches.push(batch); batch = []; }
        batch.push(unit);
      }
      if (batch.length) batches.push(batch);
      if (batches.length < 2) throw error;
      const reason = error instanceof Error && 'code' in error && error.code === 'truncated'
        ? '模型输出被截断' : '服务商上下文不足';
      options.report({ layer: options.layer, action: 'split', identity, inputBytes: utf8Size(records), limit,
        droppedItems: 0, droppedBytes: 0, detail: `${reason}，自动缩小为 ${batches.length} 批综合；全部结构项保留。` });
      const next: unknown[] = [];
      for (const [index, part] of batches.entries())
        next.push(await reduceSafely(part, `${identity}/smaller-${index}`, true, signal, depth + 1));
      if (utf8Size(next) >= utf8Size(records)) throw error;
      return reduceSafely(next, `${identity}/merged`, intermediate, signal, depth + 1);
    }
  };
  let records = options.records;
  for (let round = 0; round <= SYNTHESIS_BUDGET.rounds; round++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('分层综合已取消。');
    if (utf8Size(records) <= finalPayloadLimit)
      return reduceSafely(records, `${options.identity}/final`, false, options.signal);
    const batches: unknown[][] = [];
    let batch: unknown[] = [];
    for (const record of records) {
      if (utf8Size([record]) > SYNTHESIS_BUDGET.payload) {
        options.report({
          layer: options.layer,
          action: 'rejected',
          identity: options.identity,
          inputBytes: utf8Size(record),
          limit: SYNTHESIS_BUDGET.payload,
          droppedItems: 0,
          droppedBytes: 0,
          detail: `不可拆分的结构项超限；未丢弃内容，未发布成果。来源：${JSON.stringify(record).slice(0, 240)}`,
        });
        throw new Error(
          '分层综合遇到超预算的单个结构项（可能是完整表格或超长定义）；未截断，请拆分材料后重试。',
        );
      }
      if (utf8Size([...batch, record]) > SYNTHESIS_BUDGET.payload) {
        batches.push(batch);
        batch = [];
      }
      batch.push(record);
    }
    if (batch.length) batches.push(batch);
    options.report({
      layer: options.layer,
      action: 'split',
      identity: `${options.identity}/round-${round}`,
      inputBytes: utf8Size(records),
      limit: SYNTHESIS_BUDGET.payload,
      droppedItems: 0,
      droppedBytes: 0,
      detail: `全部 ${records.length} 个结构项分为 ${batches.length} 批；无截断。`,
    });
    if (round === SYNTHESIS_BUDGET.rounds)
      throw new Error('分层综合达到 8 轮上限；已完成层可复用，未发布成果。');
    const next = await mapWithConcurrency(
      batches,
      2,
      (part, index, signal) => reduceSafely(
        part,
        `${options.identity}/round-${round}/batch-${index}`,
        true,
        signal,
      ),
      { signal: options.signal },
    );
    if (utf8Size(next) >= utf8Size(records)) {
      options.report({
        layer: options.layer,
        action: 'rejected',
        identity: options.identity,
        inputBytes: utf8Size(next),
        limit: utf8Size(records),
        droppedItems: 0,
        droppedBytes: 0,
        detail: '归并未缩小输入；停止以避免无限调用，已完成层保留。',
      });
      throw new Error('分层归并未缩小输入；请更换模型后重试，旧成果保留。');
    }
    records = next;
  }
  throw new Error('分层综合未完成。');
}

/** All explicit points are critical; prose is selected conservatively by scientific/definition markers. */
export function collectEvidence(
  raw: unknown,
  fallback: SourceReference,
  sourceFileNames?: SourceFileNameMap,
): KnowledgeEvidence[] {
  const result: KnowledgeEvidence[] = [];
  const scientific =
    /\$|\\\(|\\\[|\\begin|\|.*\||[A-Za-zα-ω]\s*=|定义|结论|定理|definition|conclusion|theorem/i;
  const visit = (
    value: unknown,
    sources: SourceReference[],
    critical = false,
  ) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const contextual = {
      ...(sources[0] ?? fallback),
      ...(typeof item.documentId === 'string'
        ? { documentId: item.documentId }
        : {}),
      ...(typeof item.fileName === 'string' ? { fileName: item.fileName } : {}),
    };
    const ownSources =
      Array.isArray(item.sources) && item.sources.length
        ? (item.sources as SourceReference[]).map((source) => {
            const documentId = source.documentId ?? fallback.documentId;
            return {
              ...fallback,
              ...source,
              documentId,
              fileName:
                source.fileName ?? sourceFileNames?.[documentId] ?? fallback.fileName,
              type: 'pdf' as const,
            };
          })
        : typeof item.pageStart === 'number'
          ? [
              {
                ...contextual,
                pageStart: item.pageStart,
                pageEnd:
                  typeof item.pageEnd === 'number'
                    ? item.pageEnd
                    : item.pageStart,
              },
            ]
          : item.documentId || item.fileName
            ? [contextual]
            : sources;
    for (const key of ['text', 'summary', 'description', 'overview']) {
      if (
        typeof item[key] === 'string' &&
        (critical || scientific.test(item[key]))
      )
        result.push({ text: item[key], sources: ownSources });
    }
    for (const key of ['section', 'concept', 'point'])
      if (item[key]) visit(item[key], ownSources, key === 'point');
    for (const key of ['sections', 'concepts', 'points'])
      if (Array.isArray(item[key]))
        for (const child of item[key])
          visit(child, ownSources, key === 'points');
  };
  visit(raw, [fallback]);
  return uniqueEvidence(result);
}
export function uniqueEvidence(
  items: KnowledgeEvidence[],
): KnowledgeEvidence[] {
  const map = new Map<string, KnowledgeEvidence>();
  for (const item of items) {
    const previous = map.get(item.text);
    const sources = [...(previous?.sources ?? []), ...item.sources];
    map.set(item.text, {
      text: item.text,
      sources: [
        ...new Map(
          sources.map((source) => [JSON.stringify(source), source]),
        ).values(),
      ],
    });
  }
  return [...map.values()];
}

/** Deterministic source-text guard; semantic paraphrase coverage still needs real-model review. */
export function sourceEvidence(
  pages: string[],
  documentId: string,
  fileName: string,
): KnowledgeEvidence[] {
  return uniqueEvidence(
    pages.flatMap((text, index) =>
      text
        .split(/\n\s*\n/)
        .filter((paragraph) =>
          /\$|\\\(|\\\[|\\begin|\|.*\||[A-Za-zα-ω]\s*=|定义|结论|定理|definition|conclusion|theorem/i.test(
            paragraph,
          ),
        )
        .map((text) => ({
          text,
          sources: [
            {
              documentId,
              fileName,
              pageStart: index + 1,
              pageEnd: index + 1,
              type: 'pdf' as const,
            },
          ],
        })),
    ),
  );
}

/** Provenance is carried by the application, independent of model-selected concept sources. */
export function synthesisSources(
  value: unknown,
  fallback?: SourceReference,
  sourceFileNames?: SourceFileNameMap,
): SourceReference[] {
  const found: SourceReference[] = [];
  const visit = (value: unknown, inherited?: SourceReference) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inherited);
      return;
    }
    const item = value as Record<string, unknown>;
    const fileName =
      typeof item.fileName === 'string'
        ? item.fileName
        : typeof item.documentId === 'string'
          ? sourceFileNames?.[item.documentId]
          : undefined;
    const identity =
      typeof item.documentId === 'string' && typeof fileName === 'string'
        ? {
            ...inherited,
            documentId: item.documentId,
            fileName,
            type: 'pdf' as const,
            pageStart: 1,
          }
        : inherited;
    if (identity && typeof item.pageStart === 'number')
      found.push({
        ...identity,
        pageStart: item.pageStart,
        pageEnd:
          typeof item.pageEnd === 'number' ? item.pageEnd : item.pageStart,
      });
    for (const [key, child] of Object.entries(item))
      if (key !== 'evidence' && key !== 'diagnostics') visit(child, identity);
  };
  visit(value, fallback);
  // Coalesce only contiguous/overlapping actual ranges, retaining gaps and filenames.
  const result: SourceReference[] = [];
  for (const source of found.sort(
    (a, b) =>
      a.documentId.localeCompare(b.documentId) ||
      a.fileName.localeCompare(b.fileName) ||
      a.pageStart - b.pageStart,
  )) {
    const last = result.at(-1);
    if (
      last &&
      last.documentId === source.documentId &&
      last.fileName === source.fileName &&
      source.pageStart <= (last.pageEnd ?? last.pageStart) + 1
    )
      last.pageEnd = Math.max(
        last.pageEnd ?? last.pageStart,
        source.pageEnd ?? source.pageStart,
      );
    else result.push({ ...source });
  }
  return result;
}
