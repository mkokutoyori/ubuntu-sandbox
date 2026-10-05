import { seqLt, type UnackedSegment } from './types';
import type { SackScoreboard } from './SackScoreboard';

export const DUPLICATE_ACK_THRESHOLD = 3;

export type RecoveryKind = 'sack' | 'newreno' | 'timeout';

export interface LastResortSegment {
  readonly segment: UnackedSegment;
  readonly rescue: boolean;
}

interface Phase {
  readonly kind: RecoveryKind;
  readonly point: number;
  highRetransmitted: number;
  rescued: number | null;
}

function endOf(segment: UnackedSegment): number {
  return (segment.sequence + segment.length) >>> 0;
}

export class TcpLossRecovery {
  private phase: Phase | null = null;
  driving = false;

  get active(): boolean {
    return this.phase !== null;
  }

  get kind(): RecoveryKind | null {
    return this.phase?.kind ?? null;
  }

  get usesPipe(): boolean {
    return this.phase !== null && this.phase.kind !== 'newreno';
  }

  enter(kind: RecoveryKind, point: number, retransmittedEnd: number): void {
    this.phase = {
      kind, point, highRetransmitted: retransmittedEnd,
      rescued: kind === 'sack' ? retransmittedEnd : null,
    };
  }

  completes(sendUnacked: number): boolean {
    return this.phase !== null && !seqLt(sendUnacked, this.phase.point);
  }

  leave(): void {
    this.phase = null;
  }

  noteRetransmission(segment: UnackedSegment): void {
    const phase = this.phase;
    if (phase === null) return;
    const end = endOf(segment);
    if (seqLt(phase.highRetransmitted, end)) phase.highRetransmitted = end;
  }

  retransmittedSince(segment: UnackedSegment): boolean {
    const phase = this.phase;
    return phase !== null && seqLt(segment.sequence, phase.highRetransmitted);
  }

  pipe(queue: readonly UnackedSegment[], scoreboard: SackScoreboard, segmentBytes: number): number {
    const phase = this.phase;
    if (phase === null) return 0;
    let pipe = 0;
    for (const segment of queue) {
      const end = endOf(segment);
      if (scoreboard.isSacked(segment.sequence, end)) continue;
      const retransmitted = !seqLt(phase.highRetransmitted, end);
      if (phase.kind === 'sack') {
        if (!scoreboard.isLost(segment.sequence, end, segmentBytes, DUPLICATE_ACK_THRESHOLD)) pipe += segment.length;
        if (retransmitted) pipe += segment.length;
      } else if (retransmitted || seqLt(phase.point, end)) {
        pipe += segment.length;
      }
    }
    return pipe;
  }

  nextHole(queue: readonly UnackedSegment[], scoreboard: SackScoreboard, segmentBytes: number): UnackedSegment | null {
    const phase = this.phase;
    if (phase === null) return null;
    if (phase.kind === 'timeout') return this.nextPresumedLost(queue, scoreboard, phase);
    if (phase.kind !== 'sack') return null;
    const highest = scoreboard.highestEnd;
    if (highest === null) return null;
    for (const segment of queue) {
      if (!seqLt(segment.sequence, highest)) return null;
      if (segment.windowProbe || seqLt(segment.sequence, phase.highRetransmitted)) continue;
      const end = endOf(segment);
      if (scoreboard.isSacked(segment.sequence, end)) continue;
      if (scoreboard.isLost(segment.sequence, end, segmentBytes, DUPLICATE_ACK_THRESHOLD)) return segment;
    }
    return null;
  }

  takeLastResort(queue: readonly UnackedSegment[], scoreboard: SackScoreboard, sendUnacked: number): LastResortSegment | null {
    const phase = this.phase;
    if (phase === null || phase.kind !== 'sack') return null;
    const highest = scoreboard.highestEnd;
    if (highest !== null) {
      for (const segment of queue) {
        if (!seqLt(segment.sequence, highest)) break;
        if (segment.windowProbe || seqLt(segment.sequence, phase.highRetransmitted)) continue;
        if (!scoreboard.isSacked(segment.sequence, endOf(segment))) return { segment, rescue: false };
      }
    }
    if (phase.rescued !== null && !seqLt(phase.rescued, sendUnacked)) return null;
    for (let index = queue.length - 1; index >= 0; index--) {
      const segment = queue[index];
      if (segment.windowProbe || scoreboard.isSacked(segment.sequence, endOf(segment))) continue;
      if (seqLt(segment.sequence, phase.highRetransmitted)) return null;
      phase.rescued = phase.point;
      return { segment, rescue: true };
    }
    return null;
  }

  private nextPresumedLost(
    queue: readonly UnackedSegment[], scoreboard: SackScoreboard, phase: Phase,
  ): UnackedSegment | null {
    for (const segment of queue) {
      if (!seqLt(segment.sequence, phase.point)) return null;
      if (segment.windowProbe || seqLt(segment.sequence, phase.highRetransmitted)) continue;
      if (scoreboard.isSacked(segment.sequence, endOf(segment))) continue;
      return segment;
    }
    return null;
  }
}
