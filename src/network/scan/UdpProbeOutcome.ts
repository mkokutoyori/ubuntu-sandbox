import type { Equipment } from '@/network/equipment/Equipment';
import { IP_PROTO_UDP } from '@/network/core/types';

export interface UdpProbeOutcome {
  icmpCode?: number;
  icmpFrom?: string;
  ttl?: number;
}

export function readUdpProbeOutcome(
  device: Equipment | null, ip: string, port: number, emit: () => unknown,
): UdpProbeOutcome | null {
  if (!device) return null;
  let outcome: UdpProbeOutcome = {};
  const stop = device.getBus().subscribe('host.icmp.unreachable', (event) => {
    const p = event.payload;
    if (p.deviceId !== device.getId()) return;
    if (p.fromIp !== ip) return;
    if (p.origProtocol !== undefined && p.origProtocol !== IP_PROTO_UDP) return;
    if (p.origDestPort !== undefined && p.origDestPort !== port) return;
    outcome = { icmpCode: p.icmpCode, icmpFrom: p.fromIp, ttl: p.ttl };
  });
  try {
    emit();
  } finally {
    stop();
  }
  return outcome;
}
