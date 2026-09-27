type WorkerOutcome<R> =
  | { status: 'fulfilled'; index: number; value: R }
  | { status: 'rejected'; index: number; error: unknown };

/**
 * Run an asynchronous worker over every item with a bounded number of
 * concurrent workers while preserving input order in the returned results.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  options?: { signal?: AbortSignal },
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('concurrency must be a positive integer');
  }

  if (items.length === 0) {
    return [];
  }

  const controller = new AbortController();
  const externalSignal = options?.signal;
  let termination: 'failure' | 'external' | undefined;
  let firstFailure: unknown;
  let externalReason: unknown;

  const handleExternalAbort = () => {
    if (termination !== undefined) {
      return;
    }
    termination = 'external';
    externalReason = externalSignal?.reason;
    controller.abort(externalReason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      handleExternalAbort();
    } else {
      externalSignal.addEventListener('abort', handleExternalAbort, {
        once: true,
      });
    }
  }

  const recordFailure = (error: unknown) => {
    if (termination !== undefined) {
      return;
    }
    termination = 'failure';
    firstFailure = error;
    controller.abort(error);
  };

  const results: R[] = [];
  results.length = items.length;
  const active = new Set<Promise<WorkerOutcome<R>>>();
  let nextIndex = 0;

  const launch = (index: number) => {
    const task = Promise.resolve()
      .then(() => worker(items[index], index, controller.signal))
      .then(
        (value): WorkerOutcome<R> => ({
          status: 'fulfilled',
          index,
          value,
        }),
        (error): WorkerOutcome<R> => {
          recordFailure(error);
          return {
            status: 'rejected',
            index,
            error,
          };
        },
      );
    active.add(task);
  };

  try {
    while (active.size < concurrency && nextIndex < items.length) {
      if (termination !== undefined) {
        break;
      }
      launch(nextIndex);
      nextIndex += 1;
    }

    while (active.size > 0) {
      const completed = await Promise.race(
        [...active].map(async (task) => ({
          task,
          outcome: await task,
        })),
      );
      active.delete(completed.task);

      if (completed.outcome.status === 'fulfilled') {
        results[completed.outcome.index] = completed.outcome.value;
      }

      if (termination === undefined && nextIndex < items.length) {
        launch(nextIndex);
        nextIndex += 1;
      }
    }
  } finally {
    externalSignal?.removeEventListener('abort', handleExternalAbort);
  }

  if (termination === 'failure') {
    throw firstFailure;
  }
  if (termination === 'external') {
    throw externalReason;
  }

  return results;
}
