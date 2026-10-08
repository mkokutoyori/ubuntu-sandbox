import type { DomainEvent } from '@/events/types';

export type IkeTunnelNamer = (peerIp: string) => string;

const hex = (value: number): string => (value >>> 0).toString(16).padStart(8, '0');

export function ikeDebugLine(event: DomainEvent, tunnelOf: IkeTunnelNamer): string | null {
  switch (event.topic) {
    case 'ipsec.ike.sa-installed': {
      const p = event.payload;
      return `ike 0:${tunnelOf(p.peerIp)}: established IKEv${p.version} SA ${p.localIp}->${p.peerIp}, lifetime ${p.lifetimeSec}s`;
    }
    case 'ipsec.ike.sa-deleted':
      return `ike 0:${tunnelOf(event.payload.peerIp)}: IKE SA deleted, reason ${event.payload.reason}`;
    case 'ipsec.sa.installed': {
      const p = event.payload;
      return `ike 0:${tunnelOf(p.peerIp)}: add IPsec SA: SPIs(in ${hex(p.spiInbound)} out ${hex(p.spiOutbound)}), ${p.protocol} ${p.encryption}/${p.integrity} ${p.mode}`;
    }
    case 'ipsec.sa.deleted':
      return `ike 0:${tunnelOf(event.payload.peerIp)}: delete IPsec SA spi ${hex(event.payload.spiInbound)}, reason ${event.payload.reason}`;
    case 'ipsec.dpd.request-sent':
      return `ike 0:${tunnelOf(event.payload.peerIp)}: DPD probe unanswered, attempt ${event.payload.attempt}`;
    case 'ipsec.dpd.peer-down':
      return `ike 0:${tunnelOf(event.payload.peerIp)}: DPD failed, peer dead after ${event.payload.retries} retries`;
    default:
      return null;
  }
}
