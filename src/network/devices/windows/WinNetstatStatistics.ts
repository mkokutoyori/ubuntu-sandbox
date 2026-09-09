import type { SnmpSnapshot } from '../linux/ports/PortsFilesystem';

export type NetstatProtocolFilter = 'ip' | 'ipv4' | 'icmp' | 'icmpv4' | 'tcp' | 'tcpv4' | 'udp' | 'udpv4';

const VALUE_COLUMN = 36;

function pair(label: string, value: number): string {
  return `  ${label.padEnd(VALUE_COLUMN)}= ${value}`;
}

function ipv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return [
    'IPv4 Statistics',
    '',
    pair('Packets Received', c.ipInReceives),
    pair('Received Header Errors', c.ipInHdrErrors),
    pair('Received Address Errors', c.ipInAddrErrors),
    pair('Datagrams Forwarded', c.ipForwDatagrams),
    pair('Unknown Protocols Received', c.ipInUnknownProtos),
    pair('Received Packets Discarded', c.ipInDiscards),
    pair('Received Packets Delivered', c.ipInDelivers),
    pair('Output Requests', c.ipOutRequests),
    pair('Routing Discards', 0),
    pair('Discarded Output Packets', c.ipOutDiscards),
    pair('Output Packet No Route', c.ipOutNoRoutes),
    pair('Reassembly Required', c.ipReasmReqds),
    pair('Reassembly Successful', c.ipReasmOKs),
    pair('Reassembly Failures', c.ipReasmFails),
    pair('Datagrams Successfully Fragmented', c.ipFragOKs),
    pair('Datagrams Failing Fragmentation', c.ipFragFails),
    pair('Fragments Created', c.ipFragCreates),
    '',
  ];
}

const ICMP_LABEL_COLUMN = 24;

function icmpRow(label: string, received: number, sent: number): string {
  return `  ${label.padEnd(ICMP_LABEL_COLUMN)}${String(received).padEnd(12)}${sent}`;
}

function icmpv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return [
    'ICMPv4 Statistics',
    '',
    `  ${''.padEnd(ICMP_LABEL_COLUMN)}${'Received'.padEnd(12)}Sent`,
    icmpRow('Messages', c.icmpInMsgs, c.icmpOutMsgs),
    icmpRow('Errors', c.icmpInErrors, c.icmpOutErrors),
    icmpRow('Destination Unreachable', c.icmpInDestUnreachs, c.icmpOutDestUnreachs),
    icmpRow('Time Exceeded', c.icmpInTimeExcds, c.icmpOutTimeExcds),
    icmpRow('Parameter Problems', 0, 0),
    icmpRow('Source Quenches', 0, 0),
    icmpRow('Redirects', c.icmpInRedirects, c.icmpOutRedirects),
    icmpRow('Echo Replies', c.icmpInEchoReps, c.icmpOutEchoReps),
    icmpRow('Echos', c.icmpInEchos, c.icmpOutEchos),
    icmpRow('Timestamps', 0, 0),
    icmpRow('Timestamp Replies', 0, 0),
    icmpRow('Address Masks', 0, 0),
    icmpRow('Address Mask Replies', 0, 0),
    icmpRow('Router Solicitations', 0, 0),
    icmpRow('Router Advertisements', 0, 0),
    '',
  ];
}

function tcpv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return [
    'TCP Statistics for IPv4',
    '',
    pair('Active Opens', c.tcpActiveOpens),
    pair('Passive Opens', c.tcpPassiveOpens),
    pair('Failed Connection Attempts', c.tcpAttemptFails),
    pair('Reset Connections', c.tcpEstabResets),
    pair('Current Connections', s.currEstab),
    pair('Segments Received', c.tcpInSegs),
    pair('Segments Sent', c.tcpOutSegs),
    pair('Segments Retransmitted', c.tcpRetransSegs),
    '',
  ];
}

function udpv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return [
    'UDP Statistics for IPv4',
    '',
    pair('Datagrams Received', c.udpInDatagrams),
    pair('No Ports', c.udpNoPorts),
    pair('Receive Errors', c.udpInErrors),
    pair('Datagrams Sent', c.udpOutDatagrams),
    '',
  ];
}

export function netstatStatistics(
  snapshot: SnmpSnapshot, only?: NetstatProtocolFilter | null,
): string {
  const wanted = (family: 'ip' | 'icmp' | 'tcp' | 'udp'): boolean =>
    only === undefined || only === null || only.startsWith(family);
  const lines: string[] = [''];
  if (wanted('ip')) lines.push(...ipv4Block(snapshot));
  if (wanted('icmp')) lines.push(...icmpv4Block(snapshot));
  if (wanted('tcp')) lines.push(...tcpv4Block(snapshot));
  if (wanted('udp')) lines.push(...udpv4Block(snapshot));
  return lines.join('\n').trimEnd();
}
