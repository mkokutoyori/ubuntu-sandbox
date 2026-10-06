import { simulationDate } from '@/network/core/SystemClock';

export interface FrameLineage {
  readonly seq: number;
  readonly at: Date;
}

const lineages = new WeakMap<object, FrameLineage>();
let nextSequence = 1;

export function carryLineage(original: { readonly payload?: unknown }, copy: { readonly payload?: unknown }): void {
  lineages.set(lineageKey(copy), lineageOf(original));
}

function lineageKey(frame: { readonly payload?: unknown }): object {
  return typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : frame;
}

export function lineageOf(frame: { readonly payload?: unknown }): FrameLineage {
  const key = lineageKey(frame);
  let lineage = lineages.get(key);
  if (!lineage) {
    lineage = { seq: nextSequence++, at: simulationDate() };
    lineages.set(key, lineage);
  }
  return lineage;
}

export interface OrderedDelivery<T extends { readonly seq: number }> {
  push(entry: T): void;
  flush(): void;
}

const undelivered = new Set<() => void>();

export function settleOrderedDeliveries(): void {
  for (const flush of [...undelivered]) flush();
}

export function orderedDelivery<T extends { readonly seq: number }>(sink: (entry: T) => void): OrderedDelivery<T> {
  const pending: T[] = [];
  const flush = (): void => {
    undelivered.delete(flush);
    pending.sort((a, b) => a.seq - b.seq);
    for (const entry of pending.splice(0)) sink(entry);
  };
  return {
    push(entry) {
      if (pending.length === 0) {
        undelivered.add(flush);
        queueMicrotask(flush);
      }
      pending.push(entry);
    },
    flush,
  };
}
