import type { NetstatOptions } from './NetstatArguments';

type EntryKind = 'number' | 'optNumber' | 'forward' | 'inputIcmp' | 'outputIcmp' | 'rtoAlgorithm';

interface Entry {
  readonly title: string;
  readonly format: string;
  readonly kind: EntryKind;
  readonly isStatic?: true;
  readonly hasTitle?: true;
}

interface StateLayout {
  readonly indent: number;
  readonly title: string | null;
}

const STATE_LAYOUT: Readonly<Record<EntryKind, StateLayout>> = {
  number: { indent: 4, title: null },
  optNumber: { indent: 4, title: null },
  forward: { indent: 4, title: null },
  inputIcmp: { indent: 8, title: 'ICMP input histogram:' },
  outputIcmp: { indent: 8, title: 'ICMP output histogram:' },
  rtoAlgorithm: { indent: 0, title: null },
};

const number = (title: string, format: string): Entry => ({ title, format, kind: 'number' });
const optNumber = (title: string, format: string): Entry => ({ title, format, kind: 'optNumber' });
const received = (title: string, format: string): Entry => ({ title, format, kind: 'inputIcmp', hasTitle: true });
const sent = (title: string, format: string): Entry => ({ title, format, kind: 'outputIcmp', hasTitle: true });

const IP_TABLE: readonly Entry[] = [
  { title: 'DefaultTTL', format: 'Default TTL is %llu', kind: 'number', isStatic: true },
  { title: 'Forwarding', format: 'Forwarding is %s', kind: 'forward', isStatic: true },
  number('ForwDatagrams', '%llu forwarded'),
  optNumber('FragCreates', '%llu fragments created'),
  optNumber('FragFails', '%llu fragments failed'),
  optNumber('FragOKs', '%llu fragments received ok'),
  optNumber('InAddrErrors', '%llu with invalid addresses'),
  number('InDelivers', '%llu incoming packets delivered'),
  number('InDiscards', '%llu incoming packets discarded'),
  optNumber('InHdrErrors', '%llu with invalid headers'),
  number('InReceives', '%llu total packets received'),
  optNumber('InUnknownProtos', '%llu with unknown protocol'),
  optNumber('OutDiscards', '%llu outgoing packets dropped'),
  optNumber('OutNoRoutes', '%llu dropped because of missing route'),
  number('OutRequests', '%llu requests sent out'),
  optNumber('ReasmFails', '%llu packet reassemblies failed'),
  optNumber('ReasmOKs', '%llu packets reassembled ok'),
  optNumber('ReasmReqds', '%llu reassemblies required'),
  optNumber('ReasmTimeout', '%llu fragments dropped after timeout'),
];

const IP6_TABLE: readonly Entry[] = [
  optNumber('Ip6FragCreates', '%llu fragments created'),
  optNumber('Ip6FragFails', '%llu fragments failed'),
  optNumber('Ip6FragOKs', '%llu fragments received ok'),
  optNumber('Ip6InAddrErrors', '%llu with invalid addresses'),
  number('Ip6InDelivers', '%llu incoming packets delivered'),
  number('Ip6InDiscards', '%llu incoming packets discarded'),
  optNumber('Ip6InHdrErrors', '%llu with invalid headers'),
  optNumber('Ip6InMcastPkts', '%llu incoming multicast packets'),
  optNumber('Ip6InNoRoutes', '%llu incoming packets with no route'),
  number('Ip6InReceives', '%llu total packets received'),
  optNumber('Ip6InTooBigErrors', '%llu with packets too big'),
  optNumber('Ip6InTruncatedPkts', '%llu with truncated packets'),
  optNumber('Ip6InUnknownProtos', '%llu with unknown protocol'),
  optNumber('Ip6OutDiscards', '%llu outgoing packets dropped'),
  number('Ip6OutForwDatagrams', '%llu forwarded'),
  optNumber('Ip6OutMcastPkts', '%llu outgoing multicast packets'),
  optNumber('Ip6OutNoRoutes', '%llu dropped because of missing route'),
  number('Ip6OutRequests', '%llu requests sent out'),
  optNumber('Ip6ReasmFails', '%llu packet reassemblies failed'),
  optNumber('Ip6ReasmOKs', '%llu packets reassembled ok'),
  optNumber('Ip6ReasmReqds', '%llu reassemblies required'),
  optNumber('Ip6ReasmTimeout', '%llu fragments dropped after timeout'),
];

const ICMP_TABLE: readonly Entry[] = [
  received('InAddrMaskReps', 'address mask replies: %llu'),
  received('InAddrMasks', 'address mask request: %llu'),
  received('InDestUnreachs', 'destination unreachable: %llu'),
  received('InEchoReps', 'echo replies: %llu'),
  received('InEchos', 'echo requests: %llu'),
  number('InErrors', '%llu input ICMP message failed'),
  number('InMsgs', '%llu ICMP messages received'),
  received('InParmProbs', 'wrong parameters: %llu'),
  received('InRedirects', 'redirects: %llu'),
  received('InSrcQuenchs', 'source quenches: %llu'),
  received('InTimeExcds', 'timeout in transit: %llu'),
  received('InTimestampReps', 'timestamp reply: %llu'),
  received('InTimestamps', 'timestamp request: %llu'),
  sent('OutAddrMaskReps', 'address mask replies: %llu'),
  sent('OutAddrMasks', 'address mask requests: %llu'),
  sent('OutDestUnreachs', 'destination unreachable: %llu'),
  sent('OutEchoReps', 'echo replies: %llu'),
  sent('OutEchos', 'echo requests: %llu'),
  number('OutErrors', '%llu ICMP messages failed'),
  number('OutMsgs', '%llu ICMP messages sent'),
  sent('OutParmProbs', 'wrong parameters: %llu'),
  sent('OutRedirects', 'redirect: %llu'),
  sent('OutSrcQuenchs', 'source quench: %llu'),
  sent('OutTimeExcds', 'time exceeded: %llu'),
  sent('OutTimestampReps', 'timestamp replies: %llu'),
  sent('OutTimestamps', 'timestamp requests: %llu'),
];

const ICMP6_TABLE: readonly Entry[] = [
  received('Icmp6InDestUnreachs', 'destination unreachable: %llu'),
  received('Icmp6InEchoReplies', 'echo replies: %llu'),
  received('Icmp6InEchos', 'echo requests: %llu'),
  number('Icmp6InErrors', '%llu input ICMP message failed'),
  received('Icmp6InGroupMembQueries', 'group member queries: %llu'),
  received('Icmp6InGroupMembReductions', 'group member reductions: %llu'),
  received('Icmp6InGroupMembResponses', 'group member responses: %llu'),
  number('Icmp6InMsgs', '%llu ICMP messages received'),
  received('Icmp6InNeighborAdvertisements', 'neighbour advertisement: %llu'),
  received('Icmp6InNeighborSolicits', 'neighbour solicits: %llu'),
  received('Icmp6InParmProblems', 'parameter problem: %llu'),
  received('Icmp6InPktTooBigs', 'packets too big: %llu'),
  received('Icmp6InRedirects', 'redirects: %llu'),
  received('Icmp6InRouterAdvertisements', 'router advertisement: %llu'),
  received('Icmp6InRouterSolicits', 'router solicits: %llu'),
  received('Icmp6InTimeExcds', 'received ICMPv6 time exceeded: %llu'),
  sent('Icmp6OutDestUnreachs', 'destination unreachable: %llu'),
  sent('Icmp6OutEchoReplies', 'echo replies: %llu'),
  sent('Icmp6OutEchos', 'echo requests: %llu'),
  sent('Icmp6OutGroupMembQueries', 'group member queries: %llu'),
  sent('Icmp6OutGroupMembReductions', 'group member reductions: %llu'),
  sent('Icmp6OutGroupMembResponses', 'group member responses: %llu'),
  number('Icmp6OutMsgs', '%llu ICMP messages sent'),
  sent('Icmp6OutNeighborAdvertisements', 'neighbor advertisements: %llu'),
  sent('Icmp6OutNeighborSolicits', 'neighbor solicits: %llu'),
  sent('Icmp6OutParmProblems', 'parameter problem: %llu'),
  sent('Icmp6OutPktTooBigs', 'packets too big: %llu'),
  sent('Icmp6OutRedirects', 'redirects: %llu'),
  sent('Icmp6OutRouterAdvertisements ', 'router advertisement: %llu'),
  sent('Icmp6OutRouterSolicits', 'router solicits: %llu'),
  sent('Icmp6OutTimeExcds', 'sent ICMPv6 time exceeded: %llu'),
];

const TCP_TABLE: readonly Entry[] = [
  number('ActiveOpens', '%llu active connection openings'),
  number('AttemptFails', '%llu failed connection attempts'),
  number('CurrEstab', '%llu connections established'),
  number('EstabResets', '%llu connection resets received'),
  number('InErrs', '%llu bad segments received'),
  number('InSegs', '%llu segments received'),
  number('MaxConn', ''),
  number('OutRsts', '%llu resets sent'),
  number('OutSegs', '%llu segments sent out'),
  number('PassiveOpens', '%llu passive connection openings'),
  number('RetransSegs', '%llu segments retransmitted'),
  { title: 'RtoAlgorithm', format: 'RTO algorithm is %s', kind: 'rtoAlgorithm', isStatic: true },
  number('RtoMax', ''),
  number('RtoMin', ''),
];

const UDP_TABLE: readonly Entry[] = [
  number('InDatagrams', '%llu packets received'),
  number('InErrors', '%llu packet receive errors'),
  number('NoPorts', '%llu packets to unknown port received'),
  number('OutDatagrams', '%llu packets sent'),
  number('RcvbufErrors', '%llu receive buffer errors'),
  number('SndbufErrors', '%llu send buffer errors'),
];

const UDP6_TABLE: readonly Entry[] = [
  number('Udp6InDatagrams', '%llu packets received'),
  number('Udp6InErrors', '%llu packet receive errors'),
  number('Udp6NoPorts', '%llu packets to unknown port received'),
  number('Udp6OutDatagrams', '%llu packets sent'),
];

const TCP_EXT_TABLE: readonly Entry[] = [
  optNumber('DelayedACKLocked', '%llu delayed acks further delayed because of locked socket'),
  optNumber('DelayedACKLost', 'Quick ack mode was activated %llu times'),
  optNumber('DelayedACKs', '%llu delayed acks sent'),
  optNumber('EmbryonicRsts', '%llu resets received for embryonic SYN_RECV sockets'),
  optNumber('ListenDrops', '%llu SYNs to LISTEN sockets dropped'),
  optNumber('ListenOverflows', '%llu times the listen queue of a socket overflowed'),
  optNumber('LockDroppedIcmps', '%llu ICMP packets dropped because socket was locked'),
  optNumber('OfoPruned', '%llu packets dropped from out-of-order queue because of socket buffer overrun'),
  optNumber('OutOfWindowIcmps', '%llu ICMP packets dropped because they were out-of-window'),
  optNumber('PAWSActive', '%llu active connections rejected because of time stamp'),
  optNumber('PAWSEstab', '%llu packetes rejected in established connections because of timestamp'),
  optNumber('PAWSPassive', '%llu passive connections rejected because of time stamp'),
  optNumber('PruneCalled', '%llu packets pruned from receive queue because of socket buffer overrun'),
  optNumber('RcvPruned', '%llu packets pruned from receive queue'),
  optNumber('SockMallocOOM', 'Ran %llu times out of system memory during packet sending'),
  optNumber('SyncookiesFailed', '%llu invalid SYN cookies received'),
  optNumber('SyncookiesRecv', '%llu SYN cookies received'),
  optNumber('SyncookiesSent', '%llu SYN cookies sent'),
  optNumber('TCPAbortFailed', '%llu times unable to send RST due to no memory'),
  optNumber('TCPAbortOnClose', '%llu connections reset due to early user close'),
  optNumber('TCPAbortOnData', '%llu connections reset due to unexpected data'),
  optNumber('TCPAbortOnLinger', '%llu connections aborted after user close in linger timeout'),
  optNumber('TCPAbortOnMemory', '%llu connections aborted due to memory pressure'),
  optNumber('TCPAbortOnSyn', '%llu connections reset due to unexpected SYN'),
  optNumber('TCPAbortOnTimeout', '%llu connections aborted due to timeout'),
  optNumber('TCPDirectCopyFromBacklog', '%llu bytes directly in process context from backlog'),
  optNumber('TCPDirectCopyFromPrequeue', '%llu bytes directly received in process context from prequeue'),
  optNumber('TCPDSACKOfoRecv', '%llu DSACKs for out of order packets received'),
  optNumber('TCPDSACKOfoSent', '%llu DSACKs sent for out of order packets'),
  optNumber('TCPDSACKOldSent', '%llu DSACKs sent for old packets'),
  optNumber('TCPDSACKRecv', '%llu DSACKs received'),
  optNumber('TCPDSackUndo', '%llu congestion window recovered without slow start using DSACK'),
  optNumber('TCPDSACKUndo', '%llu congestion windows recovered without slow start by DSACK'),
  optNumber('TCPFACKReorder', 'Detected reordering %llu times using FACK'),
  optNumber('TCPFastRetrans', '%llu fast retransmits'),
  optNumber('TCPForwardRetrans', '%llu forward retransmits'),
  optNumber('TCPFullUndo', '%llu congestion windows fully recovered without slow start'),
  optNumber('TCPHPAcks', '%llu predicted acknowledgments'),
  number('TCPHPHits', '%llu packet headers predicted'),
  optNumber('TCPHPHitsToUser', '%llu packet headers predicted and directly queued to user'),
  optNumber('TCPLossFailures', '%llu timeouts in loss state'),
  optNumber('TCPLoss', '%llu TCP data loss events'),
  optNumber('TCPLossUndo', '%llu congestion windows recovered without slow start after partial ack'),
  optNumber('TCPLostRetransmits', '%llu retransmits lost'),
  optNumber('TCPMemoryPressures', 'TCP ran low on memory %llu times'),
  optNumber('TCPPartialUndo', '%llu congestion windows partially recovered using Hoe heuristic'),
  optNumber('TCPPrequeued', '%llu packets directly queued to recvmsg prequeue'),
  optNumber('TCPPrequeueDropped', '%llu packets dropped from prequeue'),
  optNumber('TCPPureAcks', '%llu acknowledgments not containing data payload received'),
  optNumber('TCPRcvCollapsed', '%llu packets collapsed in receive queue due to low socket buffer'),
  optNumber('TCPRenoFailures', '%llu timeouts after reno fast retransmit'),
  optNumber('TCPRenoRecoveryFailed', '%llu reno fast retransmits failed'),
  optNumber('TCPRenoRecoveryFail', '%llu classic Reno fast retransmits failed'),
  optNumber('TCPRenoRecovery', '%llu times recovered from packet loss due to fast retransmit'),
  optNumber('TCPRenoReorder', 'Detected reordering %llu times using reno fast retransmit'),
  optNumber('TCPSackFailures', '%llu timeouts after SACK recovery'),
  optNumber('TCPSackRecoveryFail', '%llu SACK retransmits failed'),
  optNumber('TCPSackRecovery', '%llu times recovered from packet loss by selective acknowledgements'),
  optNumber('TCPSACKReneging', '%llu bad SACK blocks received'),
  optNumber('TCPSACKReorder', 'Detected reordering %llu times using SACK'),
  optNumber('TCPSchedulerFailed', '%llu times receiver scheduled too late for direct processing'),
  optNumber('TCPSlowStartRetrans', '%llu retransmits in slow start'),
  optNumber('TCPTimeouts', '%llu other TCP timeouts'),
  optNumber('TCPTSReorder', 'Detected reordering %llu times using time stamp'),
  optNumber('TWKilled', '%llu TCP sockets finished time wait in slow timer'),
  optNumber('TW', '%llu TCP sockets finished time wait in fast timer'),
  optNumber('TWRecycled', '%llu time wait sockets recycled by time stamp'),
];

type ProtocolFlag = 'raw' | 'tcp' | 'udp' | 'unknown';

interface Table {
  readonly title: string;
  readonly entries: readonly Entry[] | null;
  readonly flag: ProtocolFlag;
}

const SNMP_TABLES: readonly Table[] = [
  { title: 'Ip', entries: IP_TABLE, flag: 'raw' },
  { title: 'Icmp', entries: ICMP_TABLE, flag: 'raw' },
  { title: 'Tcp', entries: TCP_TABLE, flag: 'tcp' },
  { title: 'Udp', entries: UDP_TABLE, flag: 'udp' },
  { title: 'TcpExt', entries: TCP_EXT_TABLE, flag: 'tcp' },
];

const SNMP6_TABLES: readonly Table[] = [
  { title: 'Ip6', entries: IP6_TABLE, flag: 'raw' },
  { title: 'Icmp6', entries: ICMP6_TABLE, flag: 'raw' },
  { title: 'Udp6', entries: UDP6_TABLE, flag: 'udp' },
  { title: 'Tcp6', entries: TCP_TABLE, flag: 'tcp' },
];

const PROC_SNMP = '/proc/net/snmp';
const PROC_SNMP6 = '/proc/net/snmp6';
const PROC_NETSTAT = '/proc/net/netstat';

export interface StatisticsHost {
  procFile(path: string): string | null;
}

export interface StatisticsResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function compareStrings(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const difference = a.charCodeAt(i) - b.charCodeAt(i);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function binarySearch(entries: readonly Entry[], title: string): Entry | null {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const comparison = compareStrings(title, entries[middle].title);
    if (comparison < 0) high = middle;
    else if (comparison > 0) low = middle + 1;
    else return entries[middle];
  }
  return null;
}

function unsignedValue(text: string, from: number): { value: bigint; end: number } {
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(text.slice(from));
  if (match === null) return { value: 0n, end: from };
  const magnitude = BigInt(match[2]);
  const value = BigInt.asUintN(64, match[1] === '-' ? -magnitude : magnitude);
  return { value, end: from + match[0].length };
}

class StatisticsPrinter {
  readonly lines: string[] = [];
  private state: EntryKind = 'number';
  private readonly flags: Record<ProtocolFlag, boolean>;

  constructor(raw: boolean, tcp: boolean, udp: boolean) {
    this.flags = { raw, tcp, udp, unknown: true };
  }

  private indented(kind: EntryKind, text: string): void {
    this.lines.push(`${' '.repeat(STATE_LAYOUT[kind].indent)}${text}`);
  }

  newTable(tables: readonly Table[], title: string): Table {
    const known = tables.find((table) => table.title === title);
    if (known !== undefined) {
      if (this.flags[known.flag]) this.lines.push(`${title}:`);
      this.state = 'number';
      return known;
    }
    this.lines.push(`${title}:`);
    return { title, entries: null, flag: 'unknown' };
  }

  enabled(table: Table): boolean {
    return this.flags[table.flag];
  }

  printValue(table: Table, title: string, value: bigint): void {
    const entry = table.entries === null ? null : binarySearch(table.entries, title);
    if (entry === null) {
      if (value !== 0n) this.indented(this.state, `${title}: ${value}`);
      return;
    }
    if (entry.isStatic === true) return;
    if (entry.format === '') return;
    let kind = entry.kind;
    if (entry.hasTitle === true && this.state !== kind) {
      this.indented(this.state, STATE_LAYOUT[kind].title ?? '');
    }
    let text = '';
    switch (kind) {
      case 'optNumber':
        if (value === 0n) break;
        text = entry.format.replace('%llu', String(value));
        break;
      case 'number':
        text = entry.format.replace('%llu', String(value));
        break;
      case 'forward':
        kind = 'number';
        text = entry.format.replace('%s', value === 2n ? 'enabled' : 'disabled');
        break;
      case 'outputIcmp':
      case 'inputIcmp':
        if (value > 0n) text = entry.format.replace('%llu', String(value));
        break;
      case 'rtoAlgorithm':
        break;
    }
    if (text !== '') this.indented(kind, text);
    this.state = kind;
  }
}

function processPairs(printer: StatisticsPrinter, text: string, filter: string | null): number {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let at = 0;
  while (at < lines.length) {
    const names = lines[at++];
    if (names === '') continue;
    if (at >= lines.length) break;
    const values = lines[at++];
    const nameColon = names.indexOf(':');
    const valueColon = values.indexOf(':');
    if (nameColon < 0 || valueColon < 0) return -1;
    const title = names.slice(0, nameColon);
    if (filter !== null && !title.startsWith(filter)) continue;
    const table = printer.newTable(SNMP_TABLES, title);
    let cursor = valueColon + 1;
    for (const name of names.slice(nameColon + 1).split(/[ \t]+/)) {
      if (name === '' || !printer.enabled(table)) continue;
      const parsed = unsignedValue(values, cursor);
      cursor = parsed.end;
      printer.printValue(table, name, parsed.value);
    }
  }
  return 0;
}

function titleOfSnmp6Name(name: string): string {
  const six = name.indexOf('6');
  return six < 0 ? name : name.slice(0, six + 1);
}

function processSnmp6(printer: StatisticsPrinter, text: string): void {
  let table: Table | null = null;
  let title = '';
  for (const line of text.split('\n')) {
    const fields = /^(\S+)\s+(\d+)/.exec(line);
    if (fields === null) continue;
    const name = fields[1];
    if (table === null || !name.includes(title)) {
      title = titleOfSnmp6Name(name);
      table = printer.newTable(SNMP6_TABLES, title);
    }
    if (printer.enabled(table)) printer.printValue(table, name, BigInt.asUintN(64, BigInt(fields[2])));
  }
}

function missing(path: string): string {
  return `cannot open ${path}: No such file or directory\n`;
}

function finish(printer: StatisticsPrinter, stderr: string): StatisticsResult {
  return {
    stdout: printer.lines.length === 0 ? '' : `${printer.lines.join('\n')}\n`,
    stderr,
    exitCode: 0,
  };
}

function inetStatistics(options: NetstatOptions, host: StatisticsHost): StatisticsResult {
  const printer = new StatisticsPrinter(options.raw, options.tcp, options.udp);
  const snmp = host.procFile(PROC_SNMP);
  if (snmp === null) return finish(printer, missing(PROC_SNMP));
  let stderr = '';
  if (processPairs(printer, snmp, null) < 0) stderr += 'Problem while parsing /proc/net/snmp\n';
  const extended = host.procFile(PROC_NETSTAT);
  if (extended !== null && processPairs(printer, extended, null) < 0) {
    stderr += 'Problem while parsing /proc/net/netstat\n';
  }
  return finish(printer, stderr);
}

function inet6Statistics(options: NetstatOptions, host: StatisticsHost): StatisticsResult {
  const printer = new StatisticsPrinter(options.raw, options.tcp, options.udp);
  const snmp6 = host.procFile(PROC_SNMP6);
  if (snmp6 === null) return finish(printer, missing(PROC_SNMP6));
  processSnmp6(printer, snmp6);
  const snmp = host.procFile(PROC_SNMP);
  if (snmp === null) return finish(printer, missing(PROC_SNMP));
  processPairs(printer, snmp, 'Tcp');
  return finish(printer, '');
}

export function runStatistics(options: NetstatOptions, host: StatisticsHost): StatisticsResult {
  const family = options.addressFamily === '' ? 'inet' : options.addressFamily;
  if (family === 'inet') return inetStatistics(options, host);
  if (family === 'inet6') return inet6Statistics(options, host);
  return {
    stdout: `netstat: No statistics support for specified address family: ${family}\n`,
    stderr: '',
    exitCode: 1,
  };
}
