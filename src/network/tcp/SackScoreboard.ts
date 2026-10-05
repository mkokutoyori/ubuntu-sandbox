import { seqLt } from './types';

export interface SackRange {
  readonly start: number;
  readonly end: number;
}

export class SackScoreboard {
  private held: SackRange[] = [];

  get ranges(): readonly SackRange[] { return this.held; }

  record(blocks: readonly SackRange[], sendUnacked: number, sendNext: number): boolean {
    let learned = false;
    for (const block of blocks) {
      if (!seqLt(block.start, block.end)) continue;
      if (seqLt(block.start, sendUnacked) || seqLt(sendNext, block.end)) continue;
      if (this.covers(block)) continue;
      this.insert(block);
      learned = true;
    }
    return learned;
  }

  get highestEnd(): number | null {
    return this.held.length === 0 ? null : this.held[this.held.length - 1].end;
  }

  isSacked(start: number, end: number): boolean {
    return this.covers({ start, end });
  }

  isLost(start: number, end: number, segmentBytes: number, duplicateThreshold: number): boolean {
    let ranges = 0;
    let bytes = 0;
    for (const range of this.held) {
      if (!seqLt(end, range.end)) continue;
      ranges += 1;
      bytes += (range.end - (seqLt(range.start, end) ? end : range.start)) >>> 0;
    }
    return ranges >= duplicateThreshold || bytes > (duplicateThreshold - 1) * segmentBytes;
  }

  advance(sendUnacked: number): void {
    this.held = this.held
      .filter((range) => seqLt(sendUnacked, range.end))
      .map((range) => (seqLt(range.start, sendUnacked) ? { start: sendUnacked, end: range.end } : range));
  }

  clear(): void {
    this.held = [];
  }

  private covers(block: SackRange): boolean {
    return this.held.some((range) => !seqLt(block.start, range.start) && !seqLt(range.end, block.end));
  }

  private insert(block: SackRange): void {
    let start = block.start;
    let end = block.end;
    const kept: SackRange[] = [];
    for (const range of this.held) {
      const apart = seqLt(range.end, start) || seqLt(end, range.start);
      if (apart) {
        kept.push(range);
        continue;
      }
      if (seqLt(range.start, start)) start = range.start;
      if (seqLt(end, range.end)) end = range.end;
    }
    kept.push({ start, end });
    kept.sort((a, b) => ((a.start - b.start) | 0));
    this.held = kept;
  }
}
