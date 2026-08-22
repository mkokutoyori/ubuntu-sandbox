import { IP_PROTO_ICMP, type ICMPPacket, type IPv4Packet } from '../../../core/types';
import { buildEchoRequest, echoReplyOf, ECHO_DATA_BYTES } from '../../../icmp/IcmpEcho';
import type { FirewallPingDeps } from './FirewallPing';

export const TRACEROUTE_MAX_HOPS = 32;
export const TRACEROUTE_PROBES = 3;

interface HopAwaited {
  from?: string;
  arrived: boolean;
}

export interface FirewallTracerouteDeps {
  resolve: FirewallPingDeps['resolve'];
  send(iface: string, packet: IPv4Packet, gateway: string | undefined): void;
}

function timeExceededOf(packet: IPv4Packet): ICMPPacket | null {
  if (packet.protocol !== IP_PROTO_ICMP) return null;
  const icmp = packet.payload as ICMPPacket | undefined;
  return icmp?.type === 'icmp' && icmp.icmpType === 'time-exceeded' ? icmp : null;
}

export class FirewallTraceroute {
  private awaited: HopAwaited | null = null;
  private identifier = 0xff00;

  constructor(private readonly deps: FirewallTracerouteDeps) {}

  observe(packet: IPv4Packet): boolean {
    const pending = this.awaited;
    if (!pending) return false;

    if (echoReplyOf(packet)) {
      pending.from = packet.sourceIP.toString();
      pending.arrived = true;
      return true;
    }
    if (timeExceededOf(packet)) {
      pending.from = packet.sourceIP.toString();
      return true;
    }
    return false;
  }

  run(target: string, maxHops = TRACEROUTE_MAX_HOPS): string {
    const egress = this.deps.resolve(target);
    if (!egress) return 'traceroute: unknown host';

    const lines = [
      `traceroute to ${target} (${target}), ${maxHops} hops max, 84 byte packets`,
    ];

    for (let ttl = 1; ttl <= maxHops; ttl++) {
      const hop: HopAwaited = { arrived: false };
      this.awaited = hop;
      const seen: string[] = [];

      for (let probe = 0; probe < TRACEROUTE_PROBES; probe++) {
        const request = buildEchoRequest(
          egress.source, target, this.identifier++, ttl, ECHO_DATA_BYTES, ttl);
        this.deps.send(egress.iface, request, egress.gateway);
        seen.push(hop.from === undefined ? '*' : '0.0 ms');
      }
      this.awaited = null;

      lines.push(hop.from === undefined
        ? `${String(ttl).padStart(2)}  * * *`
        : `${String(ttl).padStart(2)}  ${hop.from}  ${seen.join('  ')}`);
      if (hop.arrived) break;
    }
    return lines.join('\n');
  }
}
