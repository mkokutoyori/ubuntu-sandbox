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
