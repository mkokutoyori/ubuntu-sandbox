import type { EthernetFrame, IPv4Packet } from '@/network/core/types';

export type LoadBalanceMethod =
  | 'src-mac' | 'dst-mac' | 'src-dst-mac'
  | 'src-ip' | 'dst-ip' | 'src-dst-ip'
  | 'src-dst-port';

export const LOAD_BALANCE_METHODS: ReadonlySet<string> = new Set<LoadBalanceMethod>([
  'src-mac', 'dst-mac', 'src-dst-mac', 'src-ip', 'dst-ip', 'src-dst-ip', 'src-dst-port',
]);

export const DEFAULT_LOAD_BALANCE: LoadBalanceMethod = 'src-dst-ip';

function fold(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function ipv4Of(frame: EthernetFrame): IPv4Packet | null {
  const payload = frame.payload as { type?: string } | undefined;
  return payload?.type === 'ipv4' ? (payload as IPv4Packet) : null;
}

function portsOf(pkt: IPv4Packet): string {
  const l4 = pkt.payload as { sourcePort?: number; destinationPort?: number } | undefined;
  if (!l4 || l4.sourcePort === undefined || l4.destinationPort === undefined) return '';
  return `${l4.sourcePort}|${l4.destinationPort}`;
}

export function loadBalanceKey(frame: EthernetFrame, method: LoadBalanceMethod): string {
  const src = frame.srcMAC?.toString() ?? '';
  const dst = frame.dstMAC?.toString() ?? '';
  const pkt = ipv4Of(frame);
  switch (method) {
    case 'src-mac': return src;
    case 'dst-mac': return dst;
    case 'src-dst-mac': return `${src}|${dst}`;
    case 'src-ip': return pkt ? pkt.sourceIP.toString() : src;
    case 'dst-ip': return pkt ? pkt.destinationIP.toString() : dst;
    case 'src-dst-port':
      if (pkt) {
        const l4 = portsOf(pkt);
        if (l4) return `${pkt.sourceIP}|${pkt.destinationIP}|${l4}`;
        return `${pkt.sourceIP}|${pkt.destinationIP}`;
      }
      return `${src}|${dst}`;
    case 'src-dst-ip':
    default:
      return pkt ? `${pkt.sourceIP}|${pkt.destinationIP}` : `${src}|${dst}`;
  }
}

export function selectBundleMember(
  members: readonly string[],
  frame: EthernetFrame,
  method: LoadBalanceMethod = DEFAULT_LOAD_BALANCE,
): string | null {
  if (members.length === 0) return null;
  if (members.length === 1) return members[0];
  const ordered = [...members].sort();
  return ordered[fold(loadBalanceKey(frame, method)) % ordered.length];
}

export function selectBundleMemberForFlow(
  members: readonly string[],
  key: string,
): string | null {
  if (members.length === 0) return null;
  const ordered = [...members].sort();
  return ordered[fold(key) % ordered.length];
}
