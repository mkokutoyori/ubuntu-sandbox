import { PathClock } from '@/network/core/time/PathClock';

export function elapsedWholeMs(startedAt: number): number {
  return Math.max(0, Math.round(PathClock.now() - startedAt));
}
