import {
  RFC_RTO_FLOOR, TCP_DATA_R2_MS, TCP_INITIAL_RTO_MS, TCP_MAX_RTO_MS, TCP_R1_RETRANSMITS, TCP_SYN_R2_MS,
  type RtoFloor,
} from './RttEstimator';

export type TcpGiveUp =
  | { readonly kind: 'retransmissions'; readonly count: number }
  | { readonly kind: 'elapsed'; readonly ms: number; readonly atExpiry?: boolean };

export interface TcpRetryPolicy {
  readonly initialRtoMs: number;
  readonly rtoFloor: RtoFloor;
  readonly maxRtoMs: number;
  readonly activeOpen: TcpGiveUp;
  readonly passiveOpen: TcpGiveUp;
  readonly established: TcpGiveUp;
  readonly delivery: TcpGiveUp;
}

export const RFC_RETRY_POLICY: TcpRetryPolicy = {
  initialRtoMs: TCP_INITIAL_RTO_MS,
  rtoFloor: RFC_RTO_FLOOR,
  maxRtoMs: TCP_MAX_RTO_MS,
  activeOpen: { kind: 'elapsed', ms: TCP_SYN_R2_MS },
  passiveOpen: { kind: 'elapsed', ms: TCP_SYN_R2_MS },
  established: { kind: 'elapsed', ms: TCP_DATA_R2_MS },
  delivery: { kind: 'retransmissions', count: TCP_R1_RETRANSMITS },
};

export function giveUpReached(limit: TcpGiveUp, retransmissions: number, elapsedMs: number): boolean {
  if (limit.kind === 'retransmissions') return retransmissions >= limit.count;
  if (limit.atExpiry && retransmissions === 0) return false;
  return elapsedMs >= limit.ms;
}

export function giveUpDeadlineMs(limit: TcpGiveUp, elapsedMs: number): number {
  if (limit.kind !== 'elapsed' || limit.atExpiry || !Number.isFinite(limit.ms)) return Number.POSITIVE_INFINITY;
  return Math.max(1, limit.ms - elapsedMs);
}

export function modelledRetransmitTimeoutMs(boundary: number, rtoBaseMs: number, rtoMaxMs: number): number {
  const linearBackoffThreshold = Math.floor(Math.log2(rtoMaxMs / rtoBaseMs));
  if (boundary <= linearBackoffThreshold) return ((2 << boundary) - 1) * rtoBaseMs;
  return ((2 << linearBackoffThreshold) - 1) * rtoBaseMs + (boundary - linearBackoffThreshold) * rtoMaxMs;
}
