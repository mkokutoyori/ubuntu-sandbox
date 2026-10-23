import type { FecStackChange, TargetFec } from './EchoCodec';

export function fecStackAfter(stack: readonly TargetFec[], changes: readonly FecStackChange[]): readonly TargetFec[] | null {
  let next = [...stack];
  let pushSeen = false;
  for (const change of changes) {
    if (change.operation === 'pop') {
      if (pushSeen || next.length === 0) return null;
      next = next.slice(1);
    } else {
      if (change.fec === null) return null;
      pushSeen = true;
      next = [change.fec, ...next];
    }
  }
  return next.length === 0 ? null : next;
}
