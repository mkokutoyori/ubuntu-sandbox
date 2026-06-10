/**
 * EIGRP classic composite metric (RFC 7868 §5.6.2 / Cisco IOS semantics).
 *
 *   metric = 256 × [ K1·bw + (K2·bw)/(256−load) + K3·delay ]
 *   …and, when K5 ≠ 0, the bracket is further scaled by K5/(reliability+K4).
 *
 *   bw    = 10⁷ / min-bandwidth-along-path (kbps), integer-truncated as IOS
 *   delay = cumulative path delay in tens of microseconds
 *
 * With default K values (K1=K3=1, K2=K4=K5=0) this yields the figures seen
 * on real gear: 2816 for a connected GigabitEthernet network, 3072 one GigE
 * hop away, 30720 across a FastEthernet path.
 *
 * SRP: pure metric arithmetic only — no engine/topology knowledge.
 */

export interface EigrpKValues {
  readonly k1: number;
  readonly k2: number;
  readonly k3: number;
  readonly k4: number;
  readonly k5: number;
}

/** IOS default: `metric weights 0 1 0 1 0 0`. */
export const EIGRP_DEFAULT_K_VALUES: EigrpKValues = Object.freeze({
  k1: 1, k2: 0, k3: 1, k4: 0, k5: 0,
});

/** Reference bandwidth used by the classic-metric scaling (kbps). */
export const EIGRP_BANDWIDTH_SCALE = 10_000_000;

/** Final scaling factor of the classic metric. */
export const EIGRP_METRIC_MULTIPLIER = 256;

/** Maximum representable classic metric — "unreachable" on the wire. */
export const EIGRP_METRIC_INFINITY = 0xffff_ffff;

/** Fallbacks when the topology seam carries no link attributes (GigE). */
export const EIGRP_FALLBACK_BANDWIDTH_KBPS = 1_000_000;
export const EIGRP_FALLBACK_DELAY_USEC = 10;

/**
 * Vector metric of one path: minimum bandwidth and cumulative delay,
 * plus the (rarely tuned) load/reliability factors.
 */
export interface EigrpPathMetrics {
  /** Minimum bandwidth along the path, in kbps. */
  readonly bandwidthKbps: number;
  /** Cumulative delay along the path, in microseconds. */
  readonly delayUsec: number;
  /** Worst load on the path, 1–255 (default 1 = idle). */
  readonly load?: number;
  /** Worst reliability on the path, 1–255 (default 255 = perfect). */
  readonly reliability?: number;
}

function clampByte(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(255, Math.max(1, Math.floor(v)));
}

/**
 * Classic 32-bit composite metric for one path. Saturates at
 * {@link EIGRP_METRIC_INFINITY} (the protocol's "unreachable").
 */
export function compositeMetric(
  path: EigrpPathMetrics,
  k: EigrpKValues = EIGRP_DEFAULT_K_VALUES,
): number {
  const bwKbps = Math.max(1, Math.floor(path.bandwidthKbps));
  const scaledBw = Math.floor(EIGRP_BANDWIDTH_SCALE / bwKbps);
  const scaledDelay = Math.floor(path.delayUsec / 10);
  const load = clampByte(path.load ?? 1, 1);
  const reliability = clampByte(path.reliability ?? 255, 255);

  let bracket = k.k1 * scaledBw
    + Math.floor((k.k2 * scaledBw) / (256 - load))
    + k.k3 * scaledDelay;
  if (k.k5 !== 0) {
    bracket = Math.floor(bracket * (k.k5 / (reliability + k.k4)));
  }
  const metric = bracket * EIGRP_METRIC_MULTIPLIER;
  return Math.min(Math.max(metric, 0), EIGRP_METRIC_INFINITY);
}

/**
 * Neighbours must agree on K values or the adjacency never forms
 * (RFC 7868 §5.4 — "K-value mismatch" is logged on real gear).
 */
export function kValuesMatch(a: EigrpKValues, b: EigrpKValues): boolean {
  return a.k1 === b.k1 && a.k2 === b.k2 && a.k3 === b.k3
    && a.k4 === b.k4 && a.k5 === b.k5;
}
