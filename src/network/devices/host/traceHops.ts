import { PathClock } from '../../core/time/PathClock';
import type { IcmpExtensionObject } from '../../icmp/IcmpExtensions';
import type { TracerouteHopResult, TracerouteProbeResult } from '../EndHost';
import type { HostIcmpUnreachablePayload } from './events';

export interface TraceProbeOutcome {
  timeout: boolean;
  reached: boolean;
  ip?: string;
  rttMs?: number;
  unreachable?: boolean;
  icmpCode?: number;
  icmpType?: number;
  code?: HostIcmpUnreachablePayload['code'];
  extensions?: readonly IcmpExtensionObject[];
}

export interface TraceHopRange {
  firstTtl: number;
  maxHops: number;
  probesPerHop: number;
}

export interface TraceHopHooks {
  onHop?: (hop: TracerouteHopResult) => void;
  shouldStop?: () => boolean;
  compressedWaitMs?: number;
}

export async function collectTraceHops(
  range: TraceHopRange,
  hooks: TraceHopHooks | undefined,
  probeOnce: (ttl: number, probeIndex: number) => Promise<TraceProbeOutcome>,
): Promise<TracerouteHopResult[]> {
  const hops: TracerouteHopResult[] = [];
  for (let ttl = range.firstTtl; ttl <= range.maxHops; ttl++) {
    if (hooks?.shouldStop?.()) break;
    const probes: TracerouteProbeResult[] = [];
    let destinationReached = false;

    for (let p = 0; p < range.probesPerHop; p++) {
      const outcome = await probeOnce(ttl, p);
      probes.push({
        responded: !outcome.timeout,
        rttMs: outcome.rttMs,
        ip: outcome.ip,
        unreachable: outcome.unreachable,
        icmpCode: outcome.icmpCode,
        icmpType: outcome.icmpType,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.extensions ? { extensions: outcome.extensions } : {}),
      });
      if (outcome.reached) destinationReached = true;
    }

    if (probes.some(p => !p.responded)) PathClock.wait(hooks?.compressedWaitMs ?? 0);

    const firstResponded = probes.find(p => p.responded);
    const firstUnreachable = probes.find(p => p.unreachable);
    const allTimeout = probes.every(p => !p.responded);

    const hop: TracerouteHopResult = {
      hop: ttl,
      ip: firstResponded?.ip,
      rttMs: firstResponded?.rttMs,
      timeout: allTimeout,
      unreachable: !!firstUnreachable,
      icmpCode: firstUnreachable?.icmpCode ?? firstResponded?.icmpCode,
      probes,
    };

    hops.push(hop);
    hooks?.onHop?.(hop);

    if (destinationReached) break;
    if (firstUnreachable) break;
  }

  return hops;
}
