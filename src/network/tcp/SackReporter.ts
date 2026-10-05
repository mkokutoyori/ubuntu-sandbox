import type { SackBlock } from './ReassemblyQueue';

export const SACK_MAX_BLOCKS = 4;
export const SACK_MAX_BLOCKS_WITH_TIMESTAMPS = 3;

function distance(from: number, to: number): number {
  return (to - from) | 0;
}

function covers(block: SackBlock, sequence: number): boolean {
  return distance(block.start, sequence) >= 0 && distance(sequence, block.end) > 0;
}

function contains(outer: SackBlock, inner: SackBlock): boolean {
  return distance(outer.start, inner.start) >= 0 && distance(inner.end, outer.end) >= 0;
}

export class SackReporter {
  private recent: SackBlock[] = [];

  report(held: readonly SackBlock[], triggeredBy: number | null, capacity: number): SackBlock[] {
    const chosen: SackBlock[] = [];
    const take = (block: SackBlock | undefined): void => {
      if (block === undefined || chosen.length >= capacity) return;
      if (chosen.some((already) => contains(already, block))) return;
      chosen.push(block);
    };
    if (triggeredBy !== null) take(held.find((block) => covers(block, triggeredBy)));
    for (const earlier of this.recent) take(held.find((block) => contains(block, earlier)));
    for (let i = held.length - 1; i >= 0; i--) take(held[i]);
    this.recent = chosen.length === 0 ? [] : this.remember(chosen[0], held);
    return chosen;
  }

  private remember(first: SackBlock, held: readonly SackBlock[]): SackBlock[] {
    const earlier = this.recent.filter((block) =>
      !contains(first, block) && held.some((still) => contains(still, block)));
    return [first, ...earlier].slice(0, SACK_MAX_BLOCKS);
  }
}
