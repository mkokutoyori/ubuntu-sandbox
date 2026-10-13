import type { SnmpSnapshot } from '../../layers/internet/SnmpSnapshot';

export type NetstatProtocolFilter = 'ip' | 'ipv6' | 'icmp' | 'icmpv6' | 'tcp' | 'tcpv6' | 'udp' | 'udpv6';

const VALUE_COLUMN = 36;

function pair(label: string, value: number): string {
  return `  ${label.padEnd(VALUE_COLUMN)}= ${value}`;
}

interface IpBlockCounters {
  readonly received: number;
  readonly headerErrors: number;
  readonly addressErrors: number;
  readonly forwarded: number;
  readonly unknownProtocols: number;
  readonly discarded: number;
  readonly delivered: number;
  readonly requests: number;
  readonly outputDiscards: number;
  readonly noRoute: number;
  readonly reassemblyRequired: number;
  readonly reassembled: number;
  readonly reassemblyFailures: number;
  readonly fragmented: number;
  readonly fragmentationFailures: number;
  readonly fragmentsCreated: number;
}

function ipBlock(title: string, c: IpBlockCounters): string[] {
  return [
    title,
    '',
    pair('Packets Received', c.received),
    pair('Received Header Errors', c.headerErrors),
    pair('Received Address Errors', c.addressErrors),
    pair('Datagrams Forwarded', c.forwarded),
    pair('Unknown Protocols Received', c.unknownProtocols),
    pair('Received Packets Discarded', c.discarded),
    pair('Received Packets Delivered', c.delivered),
    pair('Output Requests', c.requests),
    pair('Routing Discards', 0),
    pair('Discarded Output Packets', c.outputDiscards),
    pair('Output Packet No Route', c.noRoute),
    pair('Reassembly Required', c.reassemblyRequired),
    pair('Reassembly Successful', c.reassembled),
    pair('Reassembly Failures', c.reassemblyFailures),
    pair('Datagrams Successfully Fragmented', c.fragmented),
    pair('Datagrams Failing Fragmentation', c.fragmentationFailures),
    pair('Fragments Created', c.fragmentsCreated),
    '',
  ];
}

function ipv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return ipBlock('IPv4 Statistics', {
    received: c.ipInReceives, headerErrors: c.ipInHdrErrors, addressErrors: c.ipInAddrErrors,
    forwarded: c.ipForwDatagrams, unknownProtocols: c.ipInUnknownProtos, discarded: c.ipInDiscards,
    delivered: c.ipInDelivers, requests: c.ipOutRequests, outputDiscards: c.ipOutDiscards,
    noRoute: c.ipOutNoRoutes, reassemblyRequired: c.ipReasmReqds, reassembled: c.ipReasmOKs,
    reassemblyFailures: c.ipReasmFails, fragmented: c.ipFragOKs, fragmentationFailures: c.ipFragFails,
    fragmentsCreated: c.ipFragCreates,
  });
}

function ipv6Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return ipBlock('IPv6 Statistics', {
    received: c.ip6InReceives, headerErrors: c.ip6InHdrErrors, addressErrors: c.ip6InAddrErrors,
    forwarded: 0, unknownProtocols: c.ip6InUnknownProtos, discarded: c.ip6InDiscards,
    delivered: c.ip6InDelivers, requests: c.ip6OutRequests, outputDiscards: c.ip6OutDiscards,
    noRoute: c.ip6OutNoRoutes, reassemblyRequired: 0, reassembled: 0,
    reassemblyFailures: 0, fragmented: 0, fragmentationFailures: 0, fragmentsCreated: 0,
  });
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

const ICMPV6_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['Destination Unreachable', 1],
  ['Packet Too Big', 2],
  ['Time Exceeded', 3],
  ['Parameter Problems', 4],
  ['Echos', 128],
  ['Echo Replies', 129],
  ['MLD Queries', 130],
  ['MLD Reports', 131],
  ['MLD Dones', 132],
  ['Router Solicitations', 133],
  ['Router Advertisements', 134],
  ['Neighbor Solicitations', 135],
  ['Neighbor Advertisements', 136],
  ['Redirects', 137],
  ['Router Renumberings', 138],
];

function icmpv6Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return [
    'ICMPv6 Statistics',
    '',
    `  ${''.padEnd(ICMP_LABEL_COLUMN)}${'Received'.padEnd(12)}Sent`,
    icmpRow('Messages', c.icmp6InMsgs, c.icmp6OutMsgs),
    icmpRow('Errors', 0, 0),
    ...ICMPV6_ROWS.map(([label, type]) => icmpRow(label, c.icmp6InTypes[type], c.icmp6OutTypes[type])),
    '',
  ];
}

interface TcpBlockCounters {
  readonly activeOpens: number;
  readonly passiveOpens: number;
  readonly attemptFails: number;
  readonly establishedResets: number;
  readonly currentConnections: number;
  readonly segmentsReceived: number;
  readonly segmentsSent: number;
  readonly segmentsRetransmitted: number;
}

function tcpBlock(title: string, c: TcpBlockCounters): string[] {
  return [
    title,
    '',
    pair('Active Opens', c.activeOpens),
    pair('Passive Opens', c.passiveOpens),
    pair('Failed Connection Attempts', c.attemptFails),
    pair('Reset Connections', c.establishedResets),
    pair('Current Connections', c.currentConnections),
    pair('Segments Received', c.segmentsReceived),
    pair('Segments Sent', c.segmentsSent),
    pair('Segments Retransmitted', c.segmentsRetransmitted),
    '',
  ];
}

function tcpv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return tcpBlock('TCP Statistics for IPv4', {
    activeOpens: c.tcpActiveOpens, passiveOpens: c.tcpPassiveOpens, attemptFails: c.tcpAttemptFails,
    establishedResets: c.tcpEstabResets, currentConnections: c.tcpCurrEstab,
    segmentsReceived: c.tcpInSegs, segmentsSent: c.tcpOutSegs, segmentsRetransmitted: c.tcpRetransSegs,
  });
}

function tcpv6Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return tcpBlock('TCP Statistics for IPv6', {
    activeOpens: c.tcp6ActiveOpens, passiveOpens: c.tcp6PassiveOpens, attemptFails: c.tcp6AttemptFails,
    establishedResets: c.tcp6EstabResets, currentConnections: c.tcp6CurrEstab,
    segmentsReceived: c.tcp6InSegs, segmentsSent: c.tcp6OutSegs, segmentsRetransmitted: c.tcp6RetransSegs,
  });
}

function udpBlock(title: string, received: number, noPorts: number, errors: number, sent: number): string[] {
  return [
    title,
    '',
    pair('Datagrams Received', received),
    pair('No Ports', noPorts),
    pair('Receive Errors', errors),
    pair('Datagrams Sent', sent),
    '',
  ];
}

function udpv4Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return udpBlock('UDP Statistics for IPv4', c.udpInDatagrams, c.udpNoPorts, c.udpInErrors, c.udpOutDatagrams);
}

function udpv6Block(s: SnmpSnapshot): string[] {
  const c = s.counters;
  return udpBlock('UDP Statistics for IPv6', c.udp6InDatagrams, c.udp6NoPorts, c.udp6InErrors, c.udp6OutDatagrams);
}

const BLOCKS: ReadonlyArray<readonly [NetstatProtocolFilter, (snapshot: SnmpSnapshot) => string[]]> = [
  ['ip', ipv4Block],
  ['ipv6', ipv6Block],
  ['icmp', icmpv4Block],
  ['icmpv6', icmpv6Block],
  ['tcp', tcpv4Block],
  ['tcpv6', tcpv6Block],
  ['udp', udpv4Block],
  ['udpv6', udpv6Block],
];

export function netstatStatistics(
  snapshot: SnmpSnapshot, only?: readonly NetstatProtocolFilter[] | null,
): string {
  const lines: string[] = [''];
  for (const [protocol, render] of BLOCKS) {
    if (only === undefined || only === null || only.includes(protocol)) lines.push(...render(snapshot));
  }
  return lines.join('\n').trimEnd();
}
