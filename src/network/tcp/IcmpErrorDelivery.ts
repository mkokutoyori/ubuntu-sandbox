import { isProhibitedUnreachCode, tcpIcmpErrorClass, type TcpIcmpErrorKind } from '../core/IcmpErrors';
import type { ICMPPacket, ICMPv6Packet, IPv4Packet, IPv6Packet } from '../core/types';
import type { TcpSegment } from './types';
import { canonicalIpText, receivedIpHeaderOf, type TcpStack, type ReceivedIpHeader } from './TcpStack';

export type TcpIcmpErrorSink = Pick<
  TcpStack, 'onIcmpUnreachable' | 'onIcmpSoftError' | 'noteProbeTimeExceeded' | 'onIcmpFragNeeded'
>;

interface ReceivedTcpIcmpError {
  readonly family: 'ipv4' | 'ipv6';
  readonly kind: TcpIcmpErrorKind;
  readonly code: number;
  readonly from: string;
  readonly mtu?: number;
  readonly invokingDestination: string;
  readonly segment: TcpSegment;
  readonly receivedHeader?: ReceivedIpHeader;
}

function dispatch(sink: TcpIcmpErrorSink, error: ReceivedTcpIcmpError): void {
  const { segment } = error;
  const sourcePort = segment.sourcePort;
  const destinationPort = segment.destinationPort;
  const destination = error.invokingDestination;
  switch (tcpIcmpErrorClass(error.family, error.kind, error.code)) {
    case 'path-mtu':
      if (error.mtu === undefined) return;
      sink.onIcmpFragNeeded(sourcePort, destinationPort, destination, segment.sequence, error.mtu);
      return;
    case 'hard':
      sink.onIcmpUnreachable(
        sourcePort, destinationPort, destination, segment.sequence,
        isProhibitedUnreachCode(error.family, error.code), error.code, error.from, error.receivedHeader);
      return;
    case 'soft':
      sink.onIcmpSoftError(
        sourcePort, destinationPort, destination, segment.sequence,
        error.kind, error.code, error.from);
      if (error.kind === 'time-exceeded') {
        sink.noteProbeTimeExceeded(
          sourcePort, destinationPort, destination, error.code, error.from, error.receivedHeader);
      }
      return;
  }
}

export function deliverIcmpv4ErrorToTcp(sink: TcpIcmpErrorSink, ipPkt: IPv4Packet, icmp: ICMPPacket): void {
  const original = icmp.originalPacket;
  const segment = original?.payload as TcpSegment | undefined;
  if (!original || segment?.type !== 'tcp') return;
  if (icmp.icmpType !== 'time-exceeded' && icmp.icmpType !== 'destination-unreachable') return;
  dispatch(sink, {
    family: 'ipv4', kind: icmp.icmpType, code: icmp.code, from: ipPkt.sourceIP.toString(),
    ...(icmp.mtu === undefined ? {} : { mtu: icmp.mtu }),
    invokingDestination: canonicalIpText(original.destinationIP.toString()),
    segment, receivedHeader: receivedIpHeaderOf(ipPkt),
  });
}

export function deliverIcmpv6ErrorToTcp(sink: TcpIcmpErrorSink, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
  const invoking = icmpv6.invokingPacket;
  const segment = invoking?.payload as TcpSegment | undefined;
  if (!invoking || segment?.type !== 'tcp') return;
  if (icmpv6.icmpType !== 'time-exceeded' && icmpv6.icmpType !== 'destination-unreachable'
    && icmpv6.icmpType !== 'packet-too-big') return;
  dispatch(sink, {
    family: 'ipv6', kind: icmpv6.icmpType, code: icmpv6.code, from: ipv6.sourceIP.toString(),
    ...(icmpv6.mtu === undefined ? {} : { mtu: icmpv6.mtu }),
    invokingDestination: canonicalIpText(invoking.destinationIP.toString()), segment,
  });
}
