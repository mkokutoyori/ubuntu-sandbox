import { appendStream, sliceStream, type StreamPayload } from './StreamPayload';

export interface SackBlock {
  start: number;
  end: number;
}

interface HeldRange {
  start: number;
  payload: StreamPayload;
  psh: boolean;
}

export interface ReassembledRun {
  payload: StreamPayload | null;
  next: number;
  psh: boolean;
}

function distance(from: number, to: number): number {
  return (to - from) | 0;
}

function endOf(range: HeldRange): number {
  return (range.start + range.payload.length) >>> 0;
}

export class ReassemblyQueue {
  private ranges: HeldRange[] = [];
  private finAt: number | null = null;

  get length(): number {
    return this.ranges.length;
  }

  get bytes(): number {
    let total = 0;
    for (const range of this.ranges) total += range.payload.length;
    return total;
  }

  get finSequence(): number | null {
    return this.finAt;
  }

  insert(start: number, payload: StreamPayload, psh: boolean, byteBudget: number): boolean {
    if (payload.length === 0) return true;
    const pieces = this.gapsWithin(start, payload.length);
    let needed = 0;
    for (const piece of pieces) needed += piece.length;
    if (needed === 0) return true;
    if (this.bytes + needed > byteBudget) return false;
    for (const piece of pieces) {
      const offset = distance(start, piece.start);
      const slice = sliceStream(payload, offset, offset + piece.length);
      const reachesEnd = offset + piece.length === payload.length;
      this.ranges.push({ start: piece.start, payload: slice, psh: psh && reachesEnd });
    }
    this.ranges.sort((a, b) => distance(b.start, a.start));
    return true;
  }

  holdFin(sequence: number): void {
    this.finAt = sequence >>> 0;
  }

  releaseFin(): void {
    this.finAt = null;
  }

  takeFrom(next: number): ReassembledRun {
    let payload: StreamPayload | null = null;
    let psh = false;
    let cursor = next >>> 0;
    for (;;) {
      const head = this.ranges[0];
      if (!head) break;
      const headEnd = endOf(head);
      if (distance(headEnd, cursor) >= 0) {
        this.ranges.shift();
        continue;
      }
      if (distance(cursor, head.start) > 0) break;
      const fresh = sliceStream(head.payload, distance(head.start, cursor));
      payload = appendStream(payload, fresh);
      cursor = headEnd;
      if (head.psh) psh = true;
      this.ranges.shift();
    }
    return { payload, next: cursor, psh };
  }

  blocks(): SackBlock[] {
    const merged: SackBlock[] = [];
    for (const range of this.ranges) {
      const end = endOf(range);
      const last = merged[merged.length - 1];
      if (last && last.end === range.start) last.end = end;
      else merged.push({ start: range.start, end });
    }
    return merged;
  }

  clear(): void {
    this.ranges = [];
    this.finAt = null;
  }

  private gapsWithin(start: number, length: number): Array<{ start: number; length: number }> {
    const end = (start + length) >>> 0;
    const gaps: Array<{ start: number; length: number }> = [];
    let cursor = start >>> 0;
    for (const range of this.ranges) {
      const rangeEnd = endOf(range);
      if (distance(cursor, rangeEnd) <= 0) continue;
      if (distance(end, range.start) >= 0) break;
      if (distance(cursor, range.start) > 0) {
        gaps.push({ start: cursor, length: distance(cursor, range.start) });
      }
      cursor = rangeEnd;
    }
    if (distance(cursor, end) > 0) gaps.push({ start: cursor, length: distance(cursor, end) });
    return gaps;
  }
}
