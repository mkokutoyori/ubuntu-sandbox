export interface FrameLineage {
  readonly seq: number;
  readonly at: Date;
}

const lineages = new WeakMap<object, FrameLineage>();
let nextSequence = 1;

export function lineageOf(frame: { readonly payload?: unknown }): FrameLineage {
  const key: object = typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : frame;
  let lineage = lineages.get(key);
  if (!lineage) {
    lineage = { seq: nextSequence++, at: new Date() };
    lineages.set(key, lineage);
  }
  return lineage;
}

export interface OrderedDelivery<T extends { readonly seq: number }> {
  push(entry: T): void;
  flush(): void;
}

export function orderedDelivery<T extends { readonly seq: number }>(sink: (entry: T) => void): OrderedDelivery<T> {
  const pending: T[] = [];
  const flush = (): void => {
    pending.sort((a, b) => a.seq - b.seq);
    for (const entry of pending.splice(0)) sink(entry);
  };
  return {
    push(entry) {
      if (pending.length === 0) queueMicrotask(flush);
      pending.push(entry);
    },
    flush,
  };
}
