interface DisposablePdf { destroy(): Promise<void> }

/** Owns pending loading tasks and the displayed PDF, independently of parsing. */
export function createPdfImportLifecycle<T extends { loadingTask: DisposablePdf }>() {
  let generation = 0;
  let active: T | null = null;
  let pending: (() => void) | null = null;
  const destroy = (resource: DisposablePdf | null) => {
    if (resource) void resource.destroy().catch(() => { /* Disposal must not mask an import error. */ });
  };
  return {
    begin() {
      const token = ++generation;
      pending?.();
      let resource: DisposablePdf | null = null;
      let disposed = false;
      let committed = false;
      const cancel = () => {
        if (disposed || committed) return;
        disposed = true;
        destroy(resource);
        resource = null;
      };
      pending = cancel;
      const isCurrent = () => token === generation && !disposed;
      return {
        isCurrent,
        ownTask(task: DisposablePdf) {
          if (!isCurrent()) { destroy(task); return false; }
          resource = task;
          return true;
        },
        resolved(doc: T) {
          // The cancelled loading task owns disposal of any late proxy.
          if (!isCurrent()) return false;
          resource = doc.loadingTask;
          return true;
        },
        commit(doc: T) {
          if (!isCurrent()) return false;
          const previous = active;
          active = doc;
          committed = true;
          resource = null;
          pending = null;
          if (previous !== doc) destroy(previous?.loadingTask ?? null);
          return true;
        },
        finish() {
          cancel();
          if (pending === cancel) pending = null;
        },
      };
    },
    dispose() {
      generation++;
      pending?.();
      pending = null;
      destroy(active?.loadingTask ?? null);
      active = null;
    },
  };
}
