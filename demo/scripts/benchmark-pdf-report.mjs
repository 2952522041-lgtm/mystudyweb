/**
 * Pure helpers shared by the opt-in PDF knowledge benchmark CLI and its mock
 * tests. This module has no network, browser, filesystem, or AI side effects:
 * it only selects the CDP target, sanitizes diagnostics/timings into a fixed
 * safe shape, and parses the frozen-bundle CLI seam.
 *
 * Sanitization is allowlist-based: even if an injected diagnostic or timing
 * object gains arbitrary fields, only the fields named here can reach the
 * report. Report content must never contain PDF text, prompts, completions,
 * API keys, or other credentials.
 */

export const BENCHMARK_MAIN_PAGE_ORIGIN = 'http://127.0.0.1:47831';
export const BENCHMARK_DEBUG_PORT = 9223;
/** Success target for the benchmark wall clock. */
export const BENCHMARK_MAX_TARGET_MS = 180_000;
/** Hard abort bound: incomplete runs are reported as failures, never success. */
export const BENCHMARK_ABORT_MS = 12 * 60_000;

export const BENCHMARK_TARGET_ERROR =
  'No suitable benchmark target: keep the main page at http://127.0.0.1:47831/ open; background-worker query pages are rejected.';
export const BENCHMARK_USAGE =
  'Usage: benchmark-pdf.mjs <course-directory> <pdf-name> [report-path] [--bundle <path>] [--source-revision <hex>] [--transport-label <label>] [--private-quality-path <local-file>] [--existing-pdf <name>]';
export const BENCHMARK_ALREADY_RUNNING = 'A benchmark is already running.';
export const BENCHMARK_REPORT_MISSING = 'Benchmark report unavailable.';
export const BENCHMARK_BUNDLE_EMPTY = 'Frozen benchmark bundle is empty.';

const TIMING_STATUSES = new Set(['success', 'failure', 'cancelled']);
const DIAGNOSTIC_LAYERS = new Set(['chunk', 'document', 'course']);
const DIAGNOSTIC_ACTIONS = new Set(['split', 'request', 'request-timing', 'completed', 'cache-hit', 'cache-unavailable', 'rejected', 'quality-restored']);
const TIMING_NUMBER_FIELDS = [
  'headersMs',
  'firstContentMs',
  'totalMs',
  'outputChars',
  'queueMs',
  'startupMs',
  'executionMs',
  'retries',
];
const DIAGNOSTIC_NUMBER_FIELDS = ['inputBytes', 'outputBytes'];
const USAGE_TOP_LEVEL_FIELDS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
];

/** Fixed safe labels; report.error is one of these values only. */
const SAFE_ERROR_LABELS = Object.freeze({
  aborted: 'deadline_exceeded',
  not_configured: 'provider_not_configured',
  network: 'provider_network',
  auth: 'provider_auth',
  rate_limit: 'provider_rate_limit',
  quota: 'provider_quota',
  server: 'provider_server',
  timeout: 'provider_timeout',
  queue_timeout: 'provider_queue_timeout',
  authentication: 'provider_auth',
  service_busy: 'provider_service_busy',
  incomplete: 'provider_incomplete',
  protocol: 'provider_protocol',
  cancelled: 'provider_cancelled',
  invalid_input: 'provider_invalid_input',
  truncated: 'provider_truncated',
  context_overflow: 'provider_context_overflow',
  invalid_output: 'provider_invalid_output',
  invalid_source_pages: 'provider_invalid_source_pages',
  incomplete_artifacts: 'incomplete_artifacts',
  already_running: 'already_running',
});

export const BENCHMARK_SCOPE = Object.freeze({
  kind: 'memory-model-benchmark',
  productionEndToEnd: false,
  preservesProviderPipeline: true,
  excludes: Object.freeze([
    'external-upload-network',
    'durable-filesystem-artifacts',
    'actual-background-scheduling',
    'candidate-review-publication',
  ]),
});

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * True for same-origin auxiliary pages that must never be driven as the
 * benchmark document: any query string, hash, or non-root path (for example a
 * background-worker query page).
 */
export function isBackgroundWorkerTarget(target) {
  if (!target || target.type !== 'page') return false;
  const url = parseUrl(target.url);
  if (!url || url.origin !== BENCHMARK_MAIN_PAGE_ORIGIN) return false;
  return url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0;
}

/** True only for the unparameterized main page on the benchmark origin. */
export function isMainBenchmarkPageTarget(target) {
  if (!target || target.type !== 'page') return false;
  const url = parseUrl(target.url);
  if (!url || url.origin !== BENCHMARK_MAIN_PAGE_ORIGIN) return false;
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    return false;
  }
  return (
    typeof target.webSocketDebuggerUrl === 'string' &&
    target.webSocketDebuggerUrl.length > 0
  );
}

/**
 * Selects exactly one main benchmark page. Background-worker query pages and
 * every other debugging target are rejected; no suitable target is an error.
 */
export function selectBenchmarkTarget(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const mainPages = list.filter(isMainBenchmarkPageTarget);
  if (mainPages.length !== 1) throw new Error(BENCHMARK_TARGET_ERROR);
  return mainPages[0];
}

/** Keep only allowlisted, finite timing fields; status is a fixed enum. */
export function sanitizeTiming(timing) {
  if (!timing || typeof timing !== 'object') return undefined;
  const safe = {};
  for (const field of TIMING_NUMBER_FIELDS) {
    if ((field === 'headersMs' || field === 'firstContentMs') && timing[field] === null) {
      safe[field] = null;
      continue;
    }
    const value = finiteNumber(timing[field]);
    if (value !== undefined) safe[field] = value;
  }
  if (TIMING_STATUSES.has(timing.status)) safe.status = timing.status;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/**
 * Projects one provider diagnostic into the report shape: layer/action/
 * identity/inputBytes/outputBytes plus atMs and the allowlisted timing. The
 * free-form detail, affected/error payloads, and arbitrary injected fields are
 * dropped.
 */
/** @returns {{atMs:number,layer?:string,action?:string,identity?:string,inputBytes?:number,outputBytes?:number,failureCategory?:string,timing?:Record<string,number|string|null>} | null} */
export function sanitizeDiagnostic(diagnostic, atMs) {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const safe = { atMs: finiteNumber(atMs) ?? 0 };
  const layer = DIAGNOSTIC_LAYERS.has(diagnostic.layer) ? diagnostic.layer : undefined;
  if (layer !== undefined) safe.layer = layer;
  const action = DIAGNOSTIC_ACTIONS.has(diagnostic.action) ? diagnostic.action : undefined;
  if (action !== undefined) safe.action = action;
  // Only application-generated IDs and known numeric reduction paths belong
  // here. A future provider must not smuggle source prose through identity.
  const identity = typeof diagnostic.identity === 'string'
    && /^(?:(?:分块分析|文档综合|课程综合) )?(?:doc-[a-f0-9]{16}|course-[a-z0-9]+(?:-[a-f0-9-]{36})?)(?:\/(?:chunk-\d+|part-\d+|round-\d+|batch-\d+|smaller-\d+|final|merged))*$/.test(diagnostic.identity)
    ? diagnostic.identity : undefined;
  if (identity !== undefined) safe.identity = identity;
  for (const field of DIAGNOSTIC_NUMBER_FIELDS) {
    const value = finiteNumber(diagnostic[field]);
    if (value !== undefined) safe[field] = value;
  }
  const timing = sanitizeTiming(diagnostic.timing);
  if (timing) safe.timing = timing;
  // Classify known validation failures without retaining any original prose.
  if (diagnostic.action === 'rejected' && typeof diagnostic.detail === 'string') {
    const detail = diagnostic.detail;
    safe.failureCategory = /中间归并未满足预算|归并未缩小|不可拆分.*超限/.test(detail) ? 'reduction-budget'
      : /截断|输出达到/.test(detail) ? 'output-truncated'
      : /层级|脑图结构|parentId|循环|关系端点/.test(detail) ? 'hierarchy'
      : /页码|来源/.test(detail) ? 'source-range'
      : /points|sections|缺少.*字段/.test(detail) ? 'schema'
      : /JSON|解析/.test(detail) ? 'json-parse'
      : 'validation';
  }
  return safe;
}

/**
 * Projects a streaming usage object onto known numeric token counters. Unknown
 * or nested arbitrary fields (which could carry bodies or secrets) are never
 * copied.
 */
export function projectUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const safe = {};
  for (const field of USAGE_TOP_LEVEL_FIELDS) {
    const value = finiteNumber(usage[field]);
    if (value !== undefined) safe[field] = value;
  }
  const promptDetails = usage.prompt_tokens_details;
  if (promptDetails && typeof promptDetails === 'object') {
    const cached = finiteNumber(promptDetails.cached_tokens);
    if (cached !== undefined) safe.cached_tokens = cached;
  }
  const completionDetails = usage.completion_tokens_details;
  if (completionDetails && typeof completionDetails === 'object') {
    const reasoning = finiteNumber(completionDetails.reasoning_tokens);
    if (reasoning !== undefined) safe.reasoning_tokens = reasoning;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Maps an error code to a fixed safe label without reading error.message. */
export function safeBenchmarkErrorLabel(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(SAFE_ERROR_LABELS, code)
  ) {
    return SAFE_ERROR_LABELS[code];
  }
  return 'benchmark_failed';
}

/** A source revision is metadata only; require a short/full hex identity. */
export function isSafeSourceRevision(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{4,64}$/.test(value);
}

function normalizeGenerationMode(value) {
  return value === 'deep' ? 'deep' : 'fast';
}

function normalizeBackend(value) {
  return value === 'dsh' ? 'dsh' : 'api';
}

/**
 * Explicit scope metadata. Only the configured model name, generation mode,
 * selected backend, and an optional safe source revision are reported; the API
 * key, base URL, settings object, and profile content are never read here.
 */
/** @returns {{scope:typeof BENCHMARK_SCOPE,cacheState:{application:string,provider:string,osFileCache:string,existingCourseDigest:string},model:string,generationMode:string,backend:string,sourceRevision?:string}} */
export function createBenchmarkScopeMetadata(input = {}) {
  const model =
    typeof input.model === 'string' && input.model.trim().length > 0
      ? input.model.trim().slice(0, 200)
      : 'unknown';
  const metadata = {
    scope: {
      ...BENCHMARK_SCOPE,
      excludes: [...BENCHMARK_SCOPE.excludes],
    },
    cacheState: {
      application: 'fresh-per-run-digest-layer-pdf-text-ocr',
      provider: 'uncontrolled',
      osFileCache: 'uncontrolled',
      existingCourseDigest: input.existingPdf ? 'preloaded-read-only' : 'none',
    },
    model,
    generationMode: normalizeGenerationMode(input.generationMode),
    backend: normalizeBackend(input.backend),
  };
  if (isSafeSourceRevision(input.sourceRevision)) {
    metadata.sourceRevision = input.sourceRevision;
  }
  return metadata;
}

/**
 * Safe polling summary: stage/model/backend plus request counts and aggregate
 * timing. It intentionally carries no request bodies, prompts, or output text.
 */
export function summarizeProgress(report, elapsedMs) {
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const started = diagnostics.filter(item => item?.action === 'request');
  const completed = diagnostics.filter(item => item?.action === 'request-timing' && item.timing);
  const useDiagnostics = started.length > 0 || completed.length > 0;
  const requests = useDiagnostics ? completed.map(item => item.timing)
    : report && Array.isArray(report.requests) ? report.requests : [];
  const counts = {
    requested: 0,
    measured: 0,
    success: 0,
    failure: 0,
    cancelled: 0,
    pending: 0,
  };
  let maxTotalMs = 0;
  let sumTotalMs = 0;
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue;
    counts.requested += 1;
    if (TIMING_STATUSES.has(request.status)) counts[request.status] += 1;
    else counts.pending += 1;
    const totalMs = finiteNumber(request.totalMs);
    if (totalMs !== undefined) {
      counts.measured += 1;
      maxTotalMs = Math.max(maxTotalMs, totalMs);
      sumTotalMs += totalMs;
    }
  }
  if (useDiagnostics) {
    counts.requested = Math.max(started.length, completed.length);
    counts.pending = Math.max(0, counts.requested - completed.length);
  }
  return {
    stage: safeText(report?.stage, 40) ?? 'unknown',
    elapsedMs: finiteNumber(elapsedMs) ?? 0,
    model: safeText(report?.model, 200) ?? 'unknown',
    backend: normalizeBackend(report?.backend),
    requests: counts,
    timings: { maxTotalMs, sumTotalMs },
  };
}

/**
 * Parses CLI arguments while retaining the course/file/report positionals.
 * `--bundle <path>` freezes the browser IIFE; omitting it keeps the esbuild
 * path. `--source-revision <hex>` is optional metadata.
 */
export function parseBenchmarkCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const positional = [];
  let bundlePath;
  let sourceRevision;
  let privateQualityPath;
  let existingPdf;
  let transportLabel;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--bundle' || arg === '--source-revision' || arg === '--private-quality-path' || arg === '--existing-pdf' || arg === '--transport-label') {
      const value = args[index + 1];
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.startsWith('--')
      ) {
        throw new Error(BENCHMARK_USAGE);
      }
      index += 1;
      if (arg === '--bundle') bundlePath = value;
      else if (arg === '--source-revision') sourceRevision = value;
      else if(arg==='--private-quality-path') privateQualityPath = value;
      else if(arg==='--transport-label') transportLabel = value;
      else existingPdf=value;
      continue;
    }
    if (arg.startsWith('--bundle=')) {
      bundlePath = arg.slice('--bundle='.length);
      continue;
    }
    if (arg.startsWith('--source-revision=')) {
      sourceRevision = arg.slice('--source-revision='.length);
      continue;
    }
    if (arg.startsWith('--transport-label=')) {
      transportLabel = arg.slice('--transport-label='.length);
      continue;
    }
    if (arg.startsWith('--private-quality-path=')) {
      privateQualityPath = arg.slice('--private-quality-path='.length);
      if (!privateQualityPath) throw new Error(BENCHMARK_USAGE);
      continue;
    }
    if(arg.startsWith('--existing-pdf=')){
      existingPdf=arg.slice('--existing-pdf='.length);
      if(!existingPdf)throw new Error(BENCHMARK_USAGE);
      continue;
    }
    if (arg === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith('-')) throw new Error('Unknown benchmark option.');
    positional.push(arg);
  }
  if (positional.length < 2) throw new Error(BENCHMARK_USAGE);
  const [course, fileName, reportPath] = positional;
  if (sourceRevision !== undefined && !isSafeSourceRevision(sourceRevision)) {
    throw new Error(
      '--source-revision must be a safe hex string (4-64 hex characters).',
    );
  }
  if (bundlePath !== undefined && bundlePath.trim().length === 0) {
    throw new Error('--bundle requires a non-empty path.');
  }
  if (transportLabel !== undefined && !/^[a-z][a-z0-9-]{0,79}$/.test(transportLabel)) {
    throw new Error('--transport-label requires a short lowercase label.');
  }
  return {
    course,
    fileName,
    ...(reportPath !== undefined ? { reportPath } : {}),
    ...(bundlePath !== undefined ? { bundlePath } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(privateQualityPath !== undefined ? { privateQualityPath } : {}),
    ...(existingPdf !== undefined ? { existingPdf } : {}),
    ...(transportLabel !== undefined ? { transportLabel } : {}),
  };
}

/**
 * Returns the IIFE source to evaluate. A provided frozen bundle is read and
 * used verbatim; otherwise the caller-supplied builder runs. The injected
 * reader/builder make this seam testable without network, AI, or CDP.
 */
export async function resolveBenchmarkBundle(input = {}) {
  if (input.bundlePath !== undefined) {
    if (typeof input.readBundle !== 'function') {
      throw new Error(BENCHMARK_BUNDLE_EMPTY);
    }
    const text = await input.readBundle(input.bundlePath);
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(BENCHMARK_BUNDLE_EMPTY);
    }
    return { source: text, built: false };
  }
  if (typeof input.buildBundle !== 'function') {
    throw new Error(BENCHMARK_BUNDLE_EMPTY);
  }
  const result = await input.buildBundle();
  const source = result?.outputFiles?.[0]?.text;
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error(BENCHMARK_BUNDLE_EMPTY);
  }
  return { source, built: true };
}
