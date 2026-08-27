import {
  IPAddress,
  IP_PROTO_ICMP,
  computeIPv4Checksum,
  type ICMPPacket,
  type IPv4Packet,
  type TCPPacket,
  type UDPPacket,
} from '../core/types';
import {
  computeTcpChecksum,
  type TcpSegment,
} from '../tcp/types';
import {
  computeUdpChecksum,
  type UdpChecksumInput,
} from '../layers/transport/UdpChecksum';

export function recomputeL4Checksum(result: IPv4Packet): void {
  const payload = result.payload as (UDPPacket | TCPPacket | undefined);
  if (!payload) return;
  const srcIp = result.sourceIP.toString();
  const dstIp = result.destinationIP.toString();
  if (payload.type === 'tcp') {
    const seg = payload as unknown as TcpSegment;
    result.payload = { ...payload, checksum: computeTcpChecksum(seg, srcIp, dstIp) };
  } else if (payload.type === 'udp') {
    const udp = payload as unknown as UdpChecksumInput;
    result.payload = { ...payload, checksum: computeUdpChecksum(udp, srcIp, dstIp) };
  }
}

export function rewriteSrcIP(pkt: IPv4Packet, newSrc: string, newSrcPort?: number): IPv4Packet {
  const result: IPv4Packet = { ...pkt, sourceIP: new IPAddress(newSrc), headerChecksum: 0 };

  if (newSrcPort !== undefined) {
    const payload = pkt.payload as (UDPPacket | TCPPacket | ICMPPacket);
    if (payload && payload.type === 'udp') {
      result.payload = { ...payload, sourcePort: newSrcPort };
    } else if (payload && payload.type === 'tcp') {
      result.payload = { ...payload, sourcePort: newSrcPort };
    } else if (pkt.protocol === IP_PROTO_ICMP) {
      const icmp = pkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp') {
        result.payload = { ...icmp, id: newSrcPort };
      }
    }
  }

  recomputeL4Checksum(result);
  result.headerChecksum = computeIPv4Checksum(result);
  return result;
}

export function rewriteDestIP(pkt: IPv4Packet, newDst: string, newDstPort?: number): IPv4Packet {
  const result: IPv4Packet = { ...pkt, destinationIP: new IPAddress(newDst), headerChecksum: 0 };

  if (newDstPort !== undefined) {
    const payload = pkt.payload as (UDPPacket | TCPPacket | ICMPPacket);
    if (payload && payload.type === 'udp') {
      result.payload = { ...payload, destinationPort: newDstPort };
    } else if (payload && payload.type === 'tcp') {
      result.payload = { ...payload, destinationPort: newDstPort };
    } else if (pkt.protocol === IP_PROTO_ICMP) {
      const icmp = pkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp') {
        result.payload = { ...icmp, id: newDstPort };
      }
    }
  }

  recomputeL4Checksum(result);
  result.headerChecksum = computeIPv4Checksum(result);
  return result;
}

export function getPacketSrcPort(pkt: IPv4Packet): number {
  const payload = pkt.payload as (UDPPacket | TCPPacket);
  if (payload && (payload.type === 'udp' || payload.type === 'tcp')) return payload.sourcePort;
  if (pkt.protocol === IP_PROTO_ICMP) {
    const icmp = pkt.payload as ICMPPacket;
    if (icmp && icmp.type === 'icmp') return icmp.id ?? 0;
  }
  return 0;
}

export function getPacketDstPort(pkt: IPv4Packet): number {
  const payload = pkt.payload as (UDPPacket | TCPPacket);
  if (payload && (payload.type === 'udp' || payload.type === 'tcp')) return payload.destinationPort;
  if (pkt.protocol === IP_PROTO_ICMP) {
    const icmp = pkt.payload as ICMPPacket;
    if (icmp && icmp.type === 'icmp') return icmp.id ?? 0;
  }
  return 0;
}

export function isBroadcastOrMulticastDest(ip: string): boolean {
  if (ip === '255.255.255.255') return true;
  const first = Number(ip.split('.', 1)[0]);
  return first >= 224 && first <= 239;
}

export function parseNatAddress(spec: string): { ip: string; port?: number } {
  const idx = spec.lastIndexOf(':');
  if (idx === -1) return { ip: spec };
  const port = parseInt(spec.slice(idx + 1), 10);
  if (isNaN(port) || port < 1 || port > 65535) return { ip: spec };
  return { ip: spec.slice(0, idx), port };
}

export function rewriteNatAddress(
  pkt: IPv4Packet, target: 'src' | 'dst', ip: string, port?: number,
): IPv4Packet {
  return target === 'src' ? rewriteSrcIP(pkt, ip, port) : rewriteDestIP(pkt, ip, port);
}
