export interface ProtocolCounters {
  ifInOctets: number;
  ifOutOctets: number;

  ipInReceives: number;
  ipInHdrErrors: number;
  ipInAddrErrors: number;
  ipForwDatagrams: number;
  ipInUnknownProtos: number;
  ipInDiscards: number;
  ipInDelivers: number;
  ipOutRequests: number;
  ipOutDiscards: number;
  ipOutNoRoutes: number;
  ipReasmReqds: number;
  ipReasmOKs: number;
  ipReasmFails: number;
  ipFragOKs: number;
  ipFragFails: number;
  ipFragCreates: number;

  icmpInMsgs: number;
  icmpInErrors: number;
  icmpInDestUnreachs: number;
  icmpInTimeExcds: number;
  icmpInRedirects: number;
  icmpInEchos: number;
  icmpInEchoReps: number;
  icmpOutMsgs: number;
  icmpOutErrors: number;
  icmpOutDestUnreachs: number;
  icmpOutTimeExcds: number;
  icmpOutRedirects: number;
  icmpOutEchos: number;
  icmpOutEchoReps: number;

  tcpActiveOpens: number;
  tcpPassiveOpens: number;
  tcpAttemptFails: number;
  tcpEstabResets: number;
  tcpInSegs: number;
  tcpOutSegs: number;
  tcpRetransSegs: number;
  tcpInErrs: number;
  tcpOutRsts: number;
  tcpInCsumErrors: number;
  tcpCurrEstab: number;

  udpInDatagrams: number;
  udpNoPorts: number;
  udpInErrors: number;
  udpOutDatagrams: number;
  udpInCsumErrors: number;

  udpIgnoredMulti: number;

  udpLiteInDatagrams: number;
  udpLiteNoPorts: number;
  udpLiteInErrors: number;
  udpLiteOutDatagrams: number;
  udpLiteInCsumErrors: number;
  udpLiteIgnoredMulti: number;

  ip6InReceives: number;
  ip6InHdrErrors: number;
  ip6InAddrErrors: number;
  ip6InUnknownProtos: number;
  ip6InDiscards: number;
  ip6InDelivers: number;
  ip6OutRequests: number;
  ip6OutDiscards: number;
  ip6OutNoRoutes: number;
  ip6ReasmTimeout: number;
  ip6ReasmReqds: number;
  ip6ReasmOKs: number;
  ip6ReasmFails: number;
  ip6FragOKs: number;
  ip6FragFails: number;
  ip6FragCreates: number;
  ip6InMcastPkts: number;
  ip6OutMcastPkts: number;
  ip6InOctets: number;
  ip6OutOctets: number;
  ip6InMcastOctets: number;
  ip6OutMcastOctets: number;
  ip6InNoECTPkts: number;
  ip6InECT1Pkts: number;
  ip6InECT0Pkts: number;
  ip6InCEPkts: number;

  icmp6InMsgs: number;
  icmp6OutMsgs: number;
  icmp6InTypes: number[];
  icmp6OutTypes: number[];

  tcp6ActiveOpens: number;
  tcp6PassiveOpens: number;
  tcp6AttemptFails: number;
  tcp6EstabResets: number;
  tcp6InSegs: number;
  tcp6OutSegs: number;
  tcp6RetransSegs: number;
  tcp6InErrs: number;
  tcp6OutRsts: number;
  tcp6InCsumErrors: number;
  tcp6CurrEstab: number;

  udp6InDatagrams: number;
  udp6NoPorts: number;
  udp6InErrors: number;
  udp6OutDatagrams: number;
  udp6InCsumErrors: number;
  udp6IgnoredMulti: number;

  udpLite6InDatagrams: number;
  udpLite6NoPorts: number;
  udpLite6InErrors: number;
  udpLite6OutDatagrams: number;
  udpLite6InCsumErrors: number;
  udpLite6IgnoredMulti: number;
}

export const ICMPV6_TYPE_COUNT = 256;

export type ProtocolCounterName = keyof ProtocolCounters;

export function newProtocolCounters(): ProtocolCounters {
  return {
    ifInOctets: 0, ifOutOctets: 0,
    ipInReceives: 0, ipInHdrErrors: 0, ipInAddrErrors: 0, ipForwDatagrams: 0,
    ipInUnknownProtos: 0, ipInDiscards: 0, ipInDelivers: 0, ipOutRequests: 0,
    ipOutDiscards: 0, ipOutNoRoutes: 0, ipReasmReqds: 0, ipReasmOKs: 0,
    ipReasmFails: 0, ipFragOKs: 0, ipFragFails: 0, ipFragCreates: 0,
    icmpInMsgs: 0, icmpInErrors: 0, icmpInDestUnreachs: 0, icmpInTimeExcds: 0,
    icmpInRedirects: 0, icmpInEchos: 0, icmpInEchoReps: 0,
    icmpOutMsgs: 0, icmpOutErrors: 0, icmpOutDestUnreachs: 0,
    icmpOutTimeExcds: 0, icmpOutRedirects: 0, icmpOutEchos: 0, icmpOutEchoReps: 0,
    tcpActiveOpens: 0, tcpPassiveOpens: 0, tcpAttemptFails: 0, tcpEstabResets: 0,
    tcpInSegs: 0, tcpOutSegs: 0, tcpRetransSegs: 0, tcpInErrs: 0, tcpOutRsts: 0,
    tcpInCsumErrors: 0, tcpCurrEstab: 0,
    udpInDatagrams: 0, udpNoPorts: 0, udpInErrors: 0, udpOutDatagrams: 0, udpInCsumErrors: 0,
    udpIgnoredMulti: 0,
    udpLiteInDatagrams: 0, udpLiteNoPorts: 0, udpLiteInErrors: 0, udpLiteOutDatagrams: 0,
    udpLiteInCsumErrors: 0, udpLiteIgnoredMulti: 0,
    ip6InReceives: 0, ip6InHdrErrors: 0, ip6InAddrErrors: 0, ip6InUnknownProtos: 0,
    ip6InDiscards: 0, ip6InDelivers: 0, ip6OutRequests: 0, ip6OutDiscards: 0, ip6OutNoRoutes: 0,
    ip6ReasmTimeout: 0, ip6ReasmReqds: 0, ip6ReasmOKs: 0, ip6ReasmFails: 0,
    ip6FragOKs: 0, ip6FragFails: 0, ip6FragCreates: 0,
    ip6InMcastPkts: 0, ip6OutMcastPkts: 0, ip6InOctets: 0, ip6OutOctets: 0,
    ip6InMcastOctets: 0, ip6OutMcastOctets: 0,
    ip6InNoECTPkts: 0, ip6InECT1Pkts: 0, ip6InECT0Pkts: 0, ip6InCEPkts: 0,
    icmp6InMsgs: 0, icmp6OutMsgs: 0,
    icmp6InTypes: new Array<number>(ICMPV6_TYPE_COUNT).fill(0),
    icmp6OutTypes: new Array<number>(ICMPV6_TYPE_COUNT).fill(0),
    tcp6ActiveOpens: 0, tcp6PassiveOpens: 0, tcp6AttemptFails: 0, tcp6EstabResets: 0,
    tcp6InSegs: 0, tcp6OutSegs: 0, tcp6RetransSegs: 0, tcp6InErrs: 0, tcp6OutRsts: 0,
    tcp6InCsumErrors: 0, tcp6CurrEstab: 0,
    udp6InDatagrams: 0, udp6NoPorts: 0, udp6InErrors: 0, udp6OutDatagrams: 0,
    udp6InCsumErrors: 0, udp6IgnoredMulti: 0,
    udpLite6InDatagrams: 0, udpLite6NoPorts: 0, udpLite6InErrors: 0, udpLite6OutDatagrams: 0,
    udpLite6InCsumErrors: 0, udpLite6IgnoredMulti: 0,
  };
}

const ICMP_IN: Record<string, ProtocolCounterName> = {
  'echo-request': 'icmpInEchos',
  'echo-reply': 'icmpInEchoReps',
  'destination-unreachable': 'icmpInDestUnreachs',
  'time-exceeded': 'icmpInTimeExcds',
  redirect: 'icmpInRedirects',
};

const ICMP_OUT: Record<string, ProtocolCounterName> = {
  'echo-request': 'icmpOutEchos',
  'echo-reply': 'icmpOutEchoReps',
  'destination-unreachable': 'icmpOutDestUnreachs',
  'time-exceeded': 'icmpOutTimeExcds',
  redirect: 'icmpOutRedirects',
};

export function countIcmpIn(counters: ProtocolCounters, icmpType: string): void {
  counters.icmpInMsgs++;
  const field = ICMP_IN[icmpType];
  if (field !== undefined) counters[field]++;
}

export function countIcmpOut(counters: ProtocolCounters, icmpType: string): void {
  counters.icmpOutMsgs++;
  const field = ICMP_OUT[icmpType];
  if (field !== undefined) counters[field]++;
}

export function countIcmp6In(counters: ProtocolCounters, typeNumber: number): void {
  counters.icmp6InMsgs++;
  counters.icmp6InTypes[typeNumber]++;
}

export function countIcmp6Out(counters: ProtocolCounters, typeNumber: number): void {
  counters.icmp6OutMsgs++;
  counters.icmp6OutTypes[typeNumber]++;
}

export type TcpCounterSuffix =
  | 'ActiveOpens' | 'PassiveOpens' | 'AttemptFails' | 'EstabResets' | 'InSegs' | 'OutSegs'
  | 'RetransSegs' | 'InErrs' | 'OutRsts' | 'InCsumErrors' | 'CurrEstab';

export type TcpCounterName = `tcp${TcpCounterSuffix}` | `tcp6${TcpCounterSuffix}`;

export function tcpCounterName(suffix: TcpCounterSuffix, family: 'ipv4' | 'ipv6'): TcpCounterName {
  return family === 'ipv6' ? `tcp6${suffix}` : `tcp${suffix}`;
}

export function tcpCounterTotal(counters: ProtocolCounters, suffix: TcpCounterSuffix): number {
  return counters[`tcp${suffix}`] + counters[`tcp6${suffix}`];
}

export type TcpTotals = Readonly<Record<TcpCounterSuffix, number>>;

export function tcpTotals(counters: ProtocolCounters): TcpTotals {
  return {
    ActiveOpens: tcpCounterTotal(counters, 'ActiveOpens'),
    PassiveOpens: tcpCounterTotal(counters, 'PassiveOpens'),
    AttemptFails: tcpCounterTotal(counters, 'AttemptFails'),
    EstabResets: tcpCounterTotal(counters, 'EstabResets'),
    InSegs: tcpCounterTotal(counters, 'InSegs'),
    OutSegs: tcpCounterTotal(counters, 'OutSegs'),
    RetransSegs: tcpCounterTotal(counters, 'RetransSegs'),
    InErrs: tcpCounterTotal(counters, 'InErrs'),
    OutRsts: tcpCounterTotal(counters, 'OutRsts'),
    InCsumErrors: tcpCounterTotal(counters, 'InCsumErrors'),
    CurrEstab: tcpCounterTotal(counters, 'CurrEstab'),
  };
}
