import { tcpTotals, type ProtocolCounters } from '../../../layers/internet/ProtocolCounters';
import { snmpSnapshot, type SnmpSnapshot } from '../../../layers/internet/SnmpSnapshot';
import { STANDALONE_KERNEL_IP_FACTS, type KernelIpFacts } from '../LinuxIpv4Settings';

export interface LinuxSnmpSnapshot extends SnmpSnapshot {
  kernel: KernelIpFacts;
}

export function linuxSnmpSnapshot(counters?: ProtocolCounters, kernel?: KernelIpFacts): LinuxSnmpSnapshot {
  return { ...snmpSnapshot(counters), kernel: kernel ?? STANDALONE_KERNEL_IP_FACTS };
}

type Counter = (c: ProtocolCounters) => number;
type Column = readonly [name: string, value: Counter];

const zero: Counter = () => 0;

function twoLines(title: string, columns: readonly Column[], c: ProtocolCounters): string[] {
  return [
    `${title}: ${columns.map(([name]) => name).join(' ')}`,
    `${title}: ${columns.map(([, value]) => value(c)).join(' ')}`,
  ];
}

function ipColumns(kernel: KernelIpFacts): readonly Column[] {
  return [
    ['Forwarding', () => (kernel.forwarding ? 1 : 2)],
    ['DefaultTTL', () => kernel.defaultTtl],
    ['InReceives', (c) => c.ipInReceives],
    ['InHdrErrors', (c) => c.ipInHdrErrors],
    ['InAddrErrors', (c) => c.ipInAddrErrors],
    ['ForwDatagrams', (c) => c.ipForwDatagrams],
    ['InUnknownProtos', (c) => c.ipInUnknownProtos],
    ['InDiscards', (c) => c.ipInDiscards],
    ['InDelivers', (c) => c.ipInDelivers],
    ['OutRequests', (c) => c.ipOutRequests],
    ['OutDiscards', (c) => c.ipOutDiscards],
    ['OutNoRoutes', (c) => c.ipOutNoRoutes],
    ['ReasmTimeout', zero],
    ['ReasmReqds', (c) => c.ipReasmReqds],
    ['ReasmOKs', (c) => c.ipReasmOKs],
    ['ReasmFails', (c) => c.ipReasmFails],
    ['FragOKs', (c) => c.ipFragOKs],
    ['FragFails', (c) => c.ipFragFails],
    ['FragCreates', (c) => c.ipFragCreates],
  ];
}

interface IcmpMessageType {
  readonly name: string;
  readonly type: number;
  readonly received?: keyof ProtocolCounters;
  readonly sent?: keyof ProtocolCounters;
}

const ICMP_MESSAGE_TYPES: readonly IcmpMessageType[] = [
  { name: 'DestUnreachs', type: 3, received: 'icmpInDestUnreachs', sent: 'icmpOutDestUnreachs' },
  { name: 'TimeExcds', type: 11, received: 'icmpInTimeExcds', sent: 'icmpOutTimeExcds' },
  { name: 'ParmProbs', type: 12 },
  { name: 'SrcQuenchs', type: 4 },
  { name: 'Redirects', type: 5, received: 'icmpInRedirects', sent: 'icmpOutRedirects' },
  { name: 'Echos', type: 8, received: 'icmpInEchos', sent: 'icmpOutEchos' },
  { name: 'EchoReps', type: 0, received: 'icmpInEchoReps', sent: 'icmpOutEchoReps' },
  { name: 'Timestamps', type: 13 },
  { name: 'TimestampReps', type: 14 },
  { name: 'AddrMasks', type: 17 },
  { name: 'AddrMaskReps', type: 18 },
];

function fieldCounter(field: keyof ProtocolCounters | undefined): Counter {
  return field === undefined ? zero : (c) => c[field] as number;
}

function icmpColumns(): readonly Column[] {
  return [
    ['InMsgs', (c) => c.icmpInMsgs],
    ['InErrors', (c) => c.icmpInErrors],
    ['InCsumErrors', zero],
    ...ICMP_MESSAGE_TYPES.map((entry): Column => [`In${entry.name}`, fieldCounter(entry.received)]),
    ['OutMsgs', (c) => c.icmpOutMsgs],
    ['OutErrors', (c) => c.icmpOutErrors],
    ...ICMP_MESSAGE_TYPES.map((entry): Column => [`Out${entry.name}`, fieldCounter(entry.sent)]),
  ];
}

function icmpMessageLines(c: ProtocolCounters): string[] {
  const byType = [...ICMP_MESSAGE_TYPES].sort((a, b) => a.type - b.type);
  const counted = [
    ...byType.map((entry) => ({ name: `InType${entry.type}`, value: fieldCounter(entry.received)(c) })),
    ...byType.map((entry) => ({ name: `OutType${entry.type}`, value: fieldCounter(entry.sent)(c) })),
  ].filter((message) => message.value !== 0);
  if (counted.length === 0) return [];
  return [
    `IcmpMsg: ${counted.map((message) => message.name).join(' ')}`,
    `IcmpMsg: ${counted.map((message) => message.value).join(' ')}`,
  ];
}

function tcpColumns(kernel: KernelIpFacts): readonly Column[] {
  return [
    ['RtoAlgorithm', () => 1],
    ['RtoMin', () => kernel.rtoMinMs],
    ['RtoMax', () => kernel.rtoMaxMs],
    ['MaxConn', () => -1],
    ['ActiveOpens', (c) => tcpTotals(c).ActiveOpens],
    ['PassiveOpens', (c) => tcpTotals(c).PassiveOpens],
    ['AttemptFails', (c) => tcpTotals(c).AttemptFails],
    ['EstabResets', (c) => tcpTotals(c).EstabResets],
    ['CurrEstab', (c) => tcpTotals(c).CurrEstab],
    ['InSegs', (c) => tcpTotals(c).InSegs],
    ['OutSegs', (c) => tcpTotals(c).OutSegs],
    ['RetransSegs', (c) => tcpTotals(c).RetransSegs],
    ['InErrs', (c) => tcpTotals(c).InErrs],
    ['OutRsts', (c) => tcpTotals(c).OutRsts],
    ['InCsumErrors', (c) => tcpTotals(c).InCsumErrors],
  ];
}

const UDP_COLUMNS: readonly Column[] = [
  ['InDatagrams', (c) => c.udpInDatagrams],
  ['NoPorts', (c) => c.udpNoPorts],
  ['InErrors', (c) => c.udpInErrors],
  ['OutDatagrams', (c) => c.udpOutDatagrams],
  ['RcvbufErrors', zero],
  ['SndbufErrors', zero],
  ['InCsumErrors', (c) => c.udpInCsumErrors],
  ['IgnoredMulti', (c) => c.udpIgnoredMulti],
  ['MemErrors', zero],
];

const UDP_LITE_COLUMNS: readonly Column[] = [
  ['InDatagrams', (c) => c.udpLiteInDatagrams],
  ['NoPorts', (c) => c.udpLiteNoPorts],
  ['InErrors', (c) => c.udpLiteInErrors],
  ['OutDatagrams', (c) => c.udpLiteOutDatagrams],
  ['RcvbufErrors', zero],
  ['SndbufErrors', zero],
  ['InCsumErrors', (c) => c.udpLiteInCsumErrors],
  ['IgnoredMulti', (c) => c.udpLiteIgnoredMulti],
  ['MemErrors', zero],
];

export function renderProcNetSnmp(snapshot: LinuxSnmpSnapshot): string {
  const c = snapshot.counters;
  const lines = [
    ...twoLines('Ip', ipColumns(snapshot.kernel), c),
    ...twoLines('Icmp', icmpColumns(), c),
    ...icmpMessageLines(c),
    ...twoLines('Tcp', tcpColumns(snapshot.kernel), c),
    ...twoLines('Udp', UDP_COLUMNS, c),
    ...twoLines('UdpLite', UDP_LITE_COLUMNS, c),
  ];
  return `${lines.join('\n')}\n`;
}

const IP6_COLUMNS: readonly Column[] = [
  ['Ip6InReceives', (c) => c.ip6InReceives],
  ['Ip6InHdrErrors', (c) => c.ip6InHdrErrors],
  ['Ip6InTooBigErrors', zero],
  ['Ip6InNoRoutes', zero],
  ['Ip6InAddrErrors', (c) => c.ip6InAddrErrors],
  ['Ip6InUnknownProtos', (c) => c.ip6InUnknownProtos],
  ['Ip6InTruncatedPkts', zero],
  ['Ip6InDiscards', (c) => c.ip6InDiscards],
  ['Ip6InDelivers', (c) => c.ip6InDelivers],
  ['Ip6OutForwDatagrams', zero],
  ['Ip6OutRequests', (c) => c.ip6OutRequests],
  ['Ip6OutDiscards', (c) => c.ip6OutDiscards],
  ['Ip6OutNoRoutes', (c) => c.ip6OutNoRoutes],
  ['Ip6ReasmTimeout', (c) => c.ip6ReasmTimeout],
  ['Ip6ReasmReqds', (c) => c.ip6ReasmReqds],
  ['Ip6ReasmOKs', (c) => c.ip6ReasmOKs],
  ['Ip6ReasmFails', (c) => c.ip6ReasmFails],
  ['Ip6FragOKs', (c) => c.ip6FragOKs],
  ['Ip6FragFails', (c) => c.ip6FragFails],
  ['Ip6FragCreates', (c) => c.ip6FragCreates],
  ['Ip6InMcastPkts', (c) => c.ip6InMcastPkts],
  ['Ip6OutMcastPkts', (c) => c.ip6OutMcastPkts],
  ['Ip6InOctets', (c) => c.ip6InOctets],
  ['Ip6OutOctets', (c) => c.ip6OutOctets],
  ['Ip6InMcastOctets', (c) => c.ip6InMcastOctets],
  ['Ip6OutMcastOctets', (c) => c.ip6OutMcastOctets],
  ['Ip6InBcastOctets', zero],
  ['Ip6OutBcastOctets', zero],
  ['Ip6InNoECTPkts', (c) => c.ip6InNoECTPkts],
  ['Ip6InECT1Pkts', (c) => c.ip6InECT1Pkts],
  ['Ip6InECT0Pkts', (c) => c.ip6InECT0Pkts],
  ['Ip6InCEPkts', (c) => c.ip6InCEPkts],
];

const ICMP6_COLUMNS: readonly Column[] = [
  ['Icmp6InMsgs', (c) => c.icmp6InMsgs],
  ['Icmp6InErrors', zero],
  ['Icmp6OutMsgs', (c) => c.icmp6OutMsgs],
  ['Icmp6OutErrors', zero],
  ['Icmp6InCsumErrors', zero],
];

const ICMP6_NAMED_TYPES: ReadonlyArray<readonly [type: number, name: string]> = [
  [1, 'DestUnreachs'],
  [2, 'PktTooBigs'],
  [3, 'TimeExcds'],
  [4, 'ParmProblems'],
  [128, 'Echos'],
  [129, 'EchoReplies'],
  [130, 'GroupMembQueries'],
  [131, 'GroupMembResponses'],
  [132, 'GroupMembReductions'],
  [133, 'RouterSolicits'],
  [134, 'RouterAdvertisements'],
  [135, 'NeighborSolicits'],
  [136, 'NeighborAdvertisements'],
  [137, 'Redirects'],
  [143, 'MLDv2Reports'],
];

const UDP6_COLUMNS: readonly Column[] = [
  ['Udp6InDatagrams', (c) => c.udp6InDatagrams],
  ['Udp6NoPorts', (c) => c.udp6NoPorts],
  ['Udp6InErrors', (c) => c.udp6InErrors],
  ['Udp6OutDatagrams', (c) => c.udp6OutDatagrams],
  ['Udp6RcvbufErrors', zero],
  ['Udp6SndbufErrors', zero],
  ['Udp6InCsumErrors', (c) => c.udp6InCsumErrors],
  ['Udp6IgnoredMulti', (c) => c.udp6IgnoredMulti],
  ['Udp6MemErrors', zero],
];

const UDP_LITE6_COLUMNS: readonly Column[] = [
  ['UdpLite6InDatagrams', (c) => c.udpLite6InDatagrams],
  ['UdpLite6NoPorts', (c) => c.udpLite6NoPorts],
  ['UdpLite6InErrors', (c) => c.udpLite6InErrors],
  ['UdpLite6OutDatagrams', (c) => c.udpLite6OutDatagrams],
  ['UdpLite6RcvbufErrors', zero],
  ['UdpLite6SndbufErrors', zero],
  ['UdpLite6InCsumErrors', (c) => c.udpLite6InCsumErrors],
  ['UdpLite6MemErrors', zero],
];

const NAME_WIDTH = 32;

function snmp6Row(name: string, value: number): string {
  return `${name.padEnd(NAME_WIDTH)}\t${value}`;
}

function snmp6Rows(columns: readonly Column[], c: ProtocolCounters): string[] {
  return columns.map(([name, value]) => snmp6Row(name, value(c)));
}

const OUTBOUND = 0x100;
const ICMP6_MESSAGE_MIB_MAX = 512;

function icmp6MessageValue(c: ProtocolCounters, index: number): number {
  return ((index & OUTBOUND) === 0 ? c.icmp6InTypes : c.icmp6OutTypes)[index & 0xff];
}

function icmp6MessageRows(c: ProtocolCounters): string[] {
  const named = new Map(ICMP6_NAMED_TYPES);
  const byName: string[] = [];
  const byNumber: string[] = [];
  for (let index = 0; index < ICMP6_MESSAGE_MIB_MAX; index++) {
    const direction = (index & OUTBOUND) === 0 ? 'In' : 'Out';
    const name = named.get(index & 0xff);
    if (name !== undefined) byName.push(snmp6Row(`Icmp6${direction}${name}`, icmp6MessageValue(c, index)));
    const value = icmp6MessageValue(c, index);
    if (value !== 0) byNumber.push(snmp6Row(`Icmp6${direction}Type${index & 0xff}`, value));
  }
  return [...byName, ...byNumber];
}

export function renderProcNetSnmp6(snapshot: SnmpSnapshot): string {
  const c = snapshot.counters;
  const rows = [
    ...snmp6Rows(IP6_COLUMNS, c),
    ...snmp6Rows(ICMP6_COLUMNS, c),
    ...icmp6MessageRows(c),
    ...snmp6Rows(UDP6_COLUMNS, c),
    ...snmp6Rows(UDP_LITE6_COLUMNS, c),
  ];
  return `${rows.join('\n')}\n`;
}
