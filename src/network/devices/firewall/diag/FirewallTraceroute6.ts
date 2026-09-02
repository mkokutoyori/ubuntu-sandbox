import { IPv6Address } from '../../../core/types';
import type { IPv6DataPlane } from '../../router/IPv6DataPlane';
import { ECHO_DATA_BYTES } from '../../../icmp/IcmpEcho';
import {
  TRACEROUTE_MAX_HOPS, TRACEROUTE_PROBES, tracerouteHeader, tracerouteHopLine,
} from './FirewallTraceroute';

export const TRACEROUTE6_NO_ROUTE = 'tracert6: unknown host';

interface Hop6 { from?: string; arrived: boolean }

export class FirewallTraceroute6 {
  private awaited: Hop6 | null = null;
  private identifier = 0xfe00;

  constructor(private readonly engine: () => IPv6DataPlane) {}

  observeReply(from: string): void {
    if (!this.awaited) return;
    this.awaited.from = from;
    this.awaited.arrived = true;
  }

  observeHopExpiry(from: string): void {
    if (!this.awaited) return;
    this.awaited.from = from;
  }

  run(target: string, maxHops = TRACEROUTE_MAX_HOPS): string {
    let destination: IPv6Address;
    try {
      destination = new IPv6Address(target);
    } catch {
      return TRACEROUTE6_NO_ROUTE;
    }
    const egress = this.engine().resolveEgress(destination);
    if (!egress) return TRACEROUTE6_NO_ROUTE;

    const lines = [tracerouteHeader(target, maxHops, 80)];
    for (let limit = 1; limit <= maxHops; limit++) {
      const hop: Hop6 = { arrived: false };
      this.awaited = hop;
      const probes: string[] = [];

      for (let probe = 0; probe < TRACEROUTE_PROBES; probe++) {
        this.engine().sendEchoRequest(
          egress, destination, this.identifier++, limit, ECHO_DATA_BYTES, limit);
        probes.push(hop.from === undefined ? '*' : '0.0 ms');
      }
      this.awaited = null;

      lines.push(tracerouteHopLine(limit, hop.from, probes));
      if (hop.arrived) break;
    }
    return lines.join('\n');
  }
}
