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

  udpInDatagrams: number;
  udpNoPorts: number;
  udpInErrors: number;
  udpOutDatagrams: number;
}

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
    udpInDatagrams: 0, udpNoPorts: 0, udpInErrors: 0, udpOutDatagrams: 0,
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
