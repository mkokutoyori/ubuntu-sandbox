/*
 * Structure — what each DNS packet and each server decision adds to the counters of Get-DnsServerStatistics, for the
 * pure mapping alone (no network): the service (UDP/TCP 53) counts requests received and responses sent per transport,
 * per opcode and question type, per response code (once per exchange, TSIG errors and extended codes apart); the
 * resolvers count the queries they send and the responses they receive, split between forwarders and the iteration from
 * the root; the secondary side counts its SOA and transfer requests and the first response of each transfer; NOTIFY sent
 * and received, dynamic updates and master-side refusals have their own entries. The counter semantics are those of the
 * Windows DNS PowerShell provider classes (DnsServerQueryStatistics, Query2, Error, Update, Master, Secondary,
 * Recursion, Security). Discrimination (run on the tree before the change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { TsigErrorCode } from '@/network/dns/tsig/Tsig';
import { DnsUpdateRcode } from '@/network/dns/update/UpdateResponder';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsPacketEvent } from '@/network/dns/transport/DnsPacketObserver';
import { DnsServerStatistics, SERVER_STATISTICS, type StatisticsGroup } from '@/network/devices/windows/server/dns/DnsServerStatistics';
import {
  countServicePacket, countRecursionPacket, countSecondaryPacket, countNotifyPacket, countUpdate, countNotifyReceived,
  type NotifyFacts, type UpdateFacts,
} from '@/network/devices/windows/server/dns/DnsStatisticsObservers';

const TKEY = 249;

function statistics(): DnsServerStatistics {
  return new DnsServerStatistics({ now: () => 1_000_000, uptimeMs: () => 5_000 });
}

function nonZero(stats: DnsServerStatistics): Record<string, number> {
  const out: Record<string, number> = {};
  const { groups } = stats.snapshot();
  for (const group of Object.keys(SERVER_STATISTICS) as StatisticsGroup[]) {
    for (const [counter, value] of Object.entries(groups[group])) if (value !== 0) out[`${group}.${counter}`] = value;
  }
  return out;
}

interface MessageSpec {
  qr?: boolean;
  opcode?: number;
  rcode?: number;
  aa?: boolean;
  qtype?: number;
  qname?: string;
  answers?: ResourceRecord<ResourceRecordData>[];
  authorities?: ResourceRecord<ResourceRecordData>[];
  additionals?: ResourceRecord<ResourceRecordData>[];
}

function message(spec: MessageSpec = {}): DnsMessage {
  return {
    id: 0x1234,
    flags: {
      qr: spec.qr ?? false, opcode: spec.opcode ?? DnsOpcode.QUERY, aa: spec.aa ?? false, tc: false, rd: true, ra: false,
      ad: false, cd: false, rcode: spec.rcode ?? DnsRcode.NOERROR,
    },
    questions: [{ qname: spec.qname ?? 'host.corp.test', qtype: spec.qtype ?? RRType.A, qclass: DnsClass.IN }],
    answers: spec.answers ?? [], authorities: spec.authorities ?? [], additionals: spec.additionals ?? [],
  };
}

const record = (type: number): ResourceRecord<ResourceRecordData> =>
  ({ name: 'host.corp.test', ttl: 60, rrClass: DnsClass.IN, data: { type } as ResourceRecordData });

const tsigRecord = (error: number): ResourceRecord<ResourceRecordData> =>
  ({ name: 'key', ttl: 0, rrClass: DnsClass.ANY, data: { type: RRType.TSIG, error } as unknown as ResourceRecordData });

function event(direction: 'send' | 'receive', transport: 'udp' | 'tcp', spec: MessageSpec, exchange: object = {}): DnsPacketEvent {
  return { direction, transport, remote: '10.0.1.2', message: message(spec), exchange };
}

describe('the service counts requests received and responses sent', () => {
  const SERVICE_CASES: ReadonlyArray<readonly [string, DnsPacketEvent, Record<string, number>]> = [
    ['an A query over UDP', event('receive', 'udp', { qtype: RRType.A }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeA': 1 }],
    ['an A query over TCP', event('receive', 'tcp', { qtype: RRType.A }),
      { 'QueryStatistics.TcpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeA': 1 }],
    ['an NS query', event('receive', 'udp', { qtype: RRType.NS }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeNs': 1 }],
    ['an SOA query', event('receive', 'udp', { qtype: RRType.SOA }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeSoa': 1 }],
    ['an MX query', event('receive', 'udp', { qtype: RRType.MX }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeMx': 1 }],
    ['a PTR query', event('receive', 'udp', { qtype: RRType.PTR }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypePtr': 1 }],
    ['an SRV query', event('receive', 'udp', { qtype: RRType.SRV }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeSrv': 1 }],
    ['an ANY query', event('receive', 'udp', { qtype: RRType.ANY }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeAll': 1 }],
    ['an IXFR query', event('receive', 'tcp', { qtype: RRType.IXFR }),
      { 'QueryStatistics.TcpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeIxfr': 1 }],
    ['an AXFR query', event('receive', 'tcp', { qtype: RRType.AXFR }),
      { 'QueryStatistics.TcpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeAxfr': 1 }],
    ['an AAAA query (no entry of its own: other)', event('receive', 'udp', { qtype: RRType.AAAA }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeOther': 1 }],
    ['a TKEY request', event('receive', 'udp', { qtype: TKEY }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TKeyNego': 1 }],
    ['a NOTIFY', event('receive', 'udp', { opcode: DnsOpcode.NOTIFY, qtype: RRType.SOA }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Notify': 1 }],
    ['a dynamic update', event('receive', 'udp', { opcode: DnsOpcode.UPDATE, qtype: RRType.SOA }),
      { 'QueryStatistics.UdpQueries': 1, 'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Update': 1 }],
    ['a response received by the service is not a request', event('receive', 'udp', { qr: true }), {}],
    ['a request sent by the service is not a response', event('send', 'udp', {}), {}],
    ['a NOERROR response over UDP', event('send', 'udp', { qr: true }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NoError': 1 }],
    ['a NOERROR response over TCP', event('send', 'tcp', { qr: true }),
      { 'QueryStatistics.TcpResponses': 1, 'ErrorStatistics.NoError': 1 }],
    ['a FORMERR response', event('send', 'udp', { qr: true, rcode: DnsRcode.FORMERR }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.FormError': 1 }],
    ['a SERVFAIL response', event('send', 'udp', { qr: true, rcode: DnsRcode.SERVFAIL }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.ServFail': 1 }],
    ['an NXDOMAIN response', event('send', 'udp', { qr: true, rcode: DnsRcode.NXDOMAIN }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NxDomain': 1 }],
    ['a NOTIMP response', event('send', 'udp', { qr: true, rcode: DnsRcode.NOTIMP }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NotImpl': 1 }],
    ['a REFUSED response', event('send', 'udp', { qr: true, rcode: DnsRcode.REFUSED }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.Refused': 1 }],
    ['a YXDOMAIN response', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.YXDOMAIN }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.YxDomain': 1 }],
    ['a YXRRSET response', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.YXRRSET }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.YxRRSet': 1 }],
    ['a NXRRSET response', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.NXRRSET }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NxRRSet': 1 }],
    ['a NOTAUTH response', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.NOTAUTH }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NotAuthoritative': 1 }],
    ['a NOTZONE response', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.NOTZONE }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NotZone': 1 }],
    ['a response code the table does not know', event('send', 'udp', { qr: true, rcode: 11 }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.UnknownError': 1 }],
    ['a response whose code needs the OPT extension (BADVERS)', event('send', 'udp', { qr: true, additionals: [makeOptRecord(1232, { extendedRcodeHigh: 1 })] }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.Max': 1 }],
    ['a response with a plain OPT record is a NOERROR', event('send', 'udp', { qr: true, additionals: [makeOptRecord(1232)] }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NoError': 1 }],
    ['a TSIG BADSIG answer', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.NOTAUTH, additionals: [tsigRecord(TsigErrorCode.BADSIG)] }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.BadSig': 1, 'SecurityStatistics.SecurityTSigVerifyFailed': 1 }],
    ['a TSIG BADKEY answer', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.NOTAUTH, additionals: [tsigRecord(TsigErrorCode.BADKEY)] }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.BadKey': 1, 'SecurityStatistics.SecurityTSigBadKey': 1 }],
    ['a TSIG BADTIME answer', event('send', 'udp', { qr: true, rcode: DnsUpdateRcode.NOTAUTH, additionals: [tsigRecord(TsigErrorCode.BADTIME)] }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.BadTime': 1 }],
    ['a signed answer without error counts its header code', event('send', 'udp', { qr: true, additionals: [tsigRecord(0)] }),
      { 'QueryStatistics.UdpResponses': 1, 'ErrorStatistics.NoError': 1 }],
  ];

  it.each(SERVICE_CASES)('%s', (_label, packet, expected) => {
    const stats = statistics();
    countServicePacket(stats, packet);
    expect(nonZero(stats)).toEqual(expected);
  });

  it('counts the response of a multi-message TCP exchange once', () => {
    const stats = statistics();
    const exchange = {};
    for (let index = 0; index < 4; index++) countServicePacket(stats, event('send', 'tcp', { qr: true }, exchange));
    expect(nonZero(stats)).toEqual({ 'QueryStatistics.TcpResponses': 1, 'ErrorStatistics.NoError': 1 });
  });

  it('counts two exchanges twice', () => {
    const stats = statistics();
    countServicePacket(stats, event('send', 'udp', { qr: true }));
    countServicePacket(stats, event('send', 'udp', { qr: true }));
    expect(nonZero(stats)).toEqual({ 'QueryStatistics.UdpResponses': 2, 'ErrorStatistics.NoError': 2 });
  });
});

describe('the resolvers count the queries they send and the responses they receive', () => {
  const NS_RECORD = record(RRType.NS);
  const RECURSION_CASES: ReadonlyArray<readonly [string, boolean, DnsPacketEvent, Record<string, number>]> = [
    ['a query sent to a forwarder over UDP', true, event('send', 'udp', {}),
      { 'QueryStatistics.UdpQueriesSent': 1, 'RecursionStatistics.Sends': 1, 'RecursionStatistics.Forwards': 1 }],
    ['a query sent to a forwarder over TCP', true, event('send', 'tcp', {}),
      { 'QueryStatistics.TcpQueriesSent': 1, 'RecursionStatistics.Sends': 1, 'RecursionStatistics.Forwards': 1, 'RecursionStatistics.TcpQuery': 1 }],
    ['a query sent while iterating from the root is not a forward', false, event('send', 'udp', {}),
      { 'QueryStatistics.UdpQueriesSent': 1, 'RecursionStatistics.Sends': 1 }],
    ['an answer from a forwarder', true, event('receive', 'udp', { qr: true, answers: [record(RRType.A)] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseFromForwarder': 1, 'RecursionStatistics.ResponseNotAuthoritative': 1, 'RecursionStatistics.ResponseAnswer': 1 }],
    ['an authoritative answer met while iterating', false, event('receive', 'udp', { qr: true, aa: true, answers: [record(RRType.A)] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseAuthoritative': 1, 'RecursionStatistics.ResponseAnswer': 1 }],
    ['a TCP answer', false, event('receive', 'tcp', { qr: true, aa: true, answers: [record(RRType.A)] }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.TcpResponse': 1, 'RecursionStatistics.ResponseAuthoritative': 1, 'RecursionStatistics.ResponseAnswer': 1 }],
    ['a name error', false, event('receive', 'udp', { qr: true, aa: true, rcode: DnsRcode.NXDOMAIN }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseAuthoritative': 1, 'RecursionStatistics.ResponseNameError': 1 }],
    ['an error other than a name error', false, event('receive', 'udp', { qr: true, rcode: DnsRcode.SERVFAIL }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseNotAuthoritative': 1, 'RecursionStatistics.ResponseRCode': 1 }],
    ['a refusal is an error other than a name error', false, event('receive', 'udp', { qr: true, rcode: DnsRcode.REFUSED }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseNotAuthoritative': 1, 'RecursionStatistics.ResponseRCode': 1 }],
    ['a non-authoritative empty answer with only an SOA in authority is empty, not a delegation', false, event('receive', 'udp', { qr: true, authorities: [record(RRType.SOA)] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseNotAuthoritative': 1, 'RecursionStatistics.ResponseEmpty': 1 }],
    ['a delegation', false, event('receive', 'udp', { qr: true, authorities: [NS_RECORD] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseNotAuthoritative': 1, 'RecursionStatistics.ResponseDelegation': 1 }],
    ['an authoritative empty answer with an NS in authority is not a delegation', false, event('receive', 'udp', { qr: true, aa: true, authorities: [NS_RECORD] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseAuthoritative': 1, 'RecursionStatistics.ResponseEmpty': 1 }],
    ['an empty answer', false, event('receive', 'udp', { qr: true, aa: true }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.Responses': 1, 'RecursionStatistics.ResponseAuthoritative': 1, 'RecursionStatistics.ResponseEmpty': 1 }],
    ['a response sent by the resolver side is ignored', false, event('send', 'udp', { qr: true }), {}],
    ['a request received by the resolver side is ignored', false, event('receive', 'udp', {}), {}],
  ];

  it.each(RECURSION_CASES)('%s', (_label, viaForwarder, packet, expected) => {
    const stats = statistics();
    countRecursionPacket(stats, packet, viaForwarder);
    expect(nonZero(stats)).toEqual(expected);
  });
});

describe('the secondary side counts its requests and the first response of each transfer', () => {
  const ZONE = 'corp.test';
  const SECONDARY_CASES: ReadonlyArray<readonly [string, DnsPacketEvent, Record<string, number>]> = [
    ['an SOA request', event('send', 'udp', { qtype: RRType.SOA, qname: ZONE }),
      { 'QueryStatistics.UdpQueriesSent': 1, 'SecondaryStatistics.SoaRequest': 1 }],
    ['an AXFR request', event('send', 'tcp', { qtype: RRType.AXFR, qname: ZONE }),
      { 'QueryStatistics.TcpQueriesSent': 1, 'SecondaryStatistics.AxfrRequest': 1 }],
    ['an IXFR request', event('send', 'tcp', { qtype: RRType.IXFR, qname: ZONE }),
      { 'QueryStatistics.TcpQueriesSent': 1, 'SecondaryStatistics.IxfrTcpRequest': 1 }],
    ['an A query sent by the secondary side is only a query', event('send', 'udp', { qtype: RRType.A, qname: ZONE }),
      { 'QueryStatistics.UdpQueriesSent': 1 }],
    ['a valid SOA response', event('receive', 'udp', { qr: true, qtype: RRType.SOA, qname: ZONE, answers: [record(RRType.SOA)] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'SecondaryStatistics.SoaResponse': 1 }],
    ['an SOA response without SOA', event('receive', 'udp', { qr: true, qtype: RRType.SOA, qname: ZONE }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'SecondaryStatistics.SoaResponseInvalid': 1 }],
    ['an SOA response with an error code', event('receive', 'udp', { qr: true, qtype: RRType.SOA, qname: ZONE, rcode: DnsRcode.REFUSED, answers: [record(RRType.SOA)] }),
      { 'QueryStatistics.UdpResponsesReceived': 1, 'SecondaryStatistics.SoaResponseInvalid': 1 }],
    ['an accepted AXFR', event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: ZONE }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.AxfrResponse': 1, 'SecondaryStatistics.AxfrSuccess': 1 }],
    ['a refused AXFR', event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: ZONE, rcode: DnsRcode.REFUSED }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.AxfrResponse': 1, 'SecondaryStatistics.AxfrRefused': 1 }],
    ['an invalid AXFR', event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: ZONE, rcode: DnsRcode.SERVFAIL }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.AxfrResponse': 1, 'SecondaryStatistics.AxfrInvalid': 1 }],
    ['an accepted IXFR', event('receive', 'tcp', { qr: true, qtype: RRType.IXFR, qname: ZONE }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.IxfrTcpResponse': 1, 'SecondaryStatistics.IxfrTcpSuccess': 1 }],
    ['a refused IXFR', event('receive', 'tcp', { qr: true, qtype: RRType.IXFR, qname: ZONE, rcode: DnsRcode.REFUSED }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.IxfrTcpResponse': 1, 'SecondaryStatistics.IxfrTcpRefused': 1 }],
    ['an IXFR the primary does not understand', event('receive', 'tcp', { qr: true, qtype: RRType.IXFR, qname: ZONE, rcode: DnsRcode.FORMERR }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.IxfrTcpResponse': 1, 'SecondaryStatistics.IxfrTcpFormError': 1 }],
    ['an invalid IXFR', event('receive', 'tcp', { qr: true, qtype: RRType.IXFR, qname: ZONE, rcode: DnsRcode.SERVFAIL }),
      { 'QueryStatistics.TcpResponsesReceived': 1, 'SecondaryStatistics.IxfrTcpResponse': 1, 'SecondaryStatistics.IxfrTcpInvalid': 1 }],
    ['a response to another question type', event('receive', 'udp', { qr: true, qtype: RRType.A, qname: ZONE }),
      { 'QueryStatistics.UdpResponsesReceived': 1 }],
  ];

  it.each(SECONDARY_CASES)('%s', (_label, packet, expected) => {
    const stats = statistics();
    countSecondaryPacket(stats, packet);
    expect(nonZero(stats)).toEqual(expected);
  });

  it('counts the response of a multi-message transfer once', () => {
    const stats = statistics();
    const exchange = {};
    for (let index = 0; index < 3; index++) countSecondaryPacket(stats, event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: ZONE }, exchange));
    expect(nonZero(stats)).toEqual({
      'QueryStatistics.TcpResponsesReceived': 3, 'SecondaryStatistics.AxfrResponse': 1, 'SecondaryStatistics.AxfrSuccess': 1,
    });
  });

  it('feeds the statistics of a tracked zone and leaves an unknown zone alone', () => {
    const stats = statistics();
    stats.trackZone(ZONE);
    countSecondaryPacket(stats, event('send', 'tcp', { qtype: RRType.AXFR, qname: `${ZONE.toUpperCase()}.` }));
    countSecondaryPacket(stats, event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: ZONE }));
    countSecondaryPacket(stats, event('send', 'tcp', { qtype: RRType.IXFR, qname: ZONE }));
    countSecondaryPacket(stats, event('send', 'tcp', { qtype: RRType.AXFR, qname: 'other.test' }));
    countSecondaryPacket(stats, event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: 'other.test' }));
    countSecondaryPacket(stats, event('send', 'udp', { qtype: RRType.SOA, qname: ZONE }));
    const zone = stats.zoneSnapshot(ZONE)!;
    expect(zone.transfers).toEqual([
      { kind: 'AXFR', requestReceived: 0, requestSent: 1, responseReceived: 1, successReceived: 1, successSent: 0 },
      { kind: 'IXFR', requestReceived: 0, requestSent: 1, responseReceived: 0, successReceived: 0, successSent: 0 },
    ]);
    expect(stats.hasZone('other.test')).toBe(false);
  });

  it('counts a refused transfer as received but not as successful', () => {
    const stats = statistics();
    stats.trackZone(ZONE);
    countSecondaryPacket(stats, event('receive', 'tcp', { qr: true, qtype: RRType.AXFR, qname: ZONE, rcode: DnsRcode.REFUSED }));
    expect(stats.zoneSnapshot(ZONE)!.transfers[0]).toMatchObject({ kind: 'AXFR', responseReceived: 1, successReceived: 0 });
  });
});

describe('NOTIFY sent and received', () => {
  it('counts the NOTIFY messages the server sends', () => {
    const stats = statistics();
    countNotifyPacket(stats, event('send', 'udp', { opcode: DnsOpcode.NOTIFY, qtype: RRType.SOA }));
    countNotifyPacket(stats, event('send', 'udp', { opcode: DnsOpcode.NOTIFY, qtype: RRType.SOA }));
    expect(nonZero(stats)).toEqual({ 'MasterStatistics.NotifySent': 2 });
  });

  it.each([
    ['a response received', event('receive', 'udp', { opcode: DnsOpcode.NOTIFY, qr: true })],
    ['a response sent', event('send', 'udp', { opcode: DnsOpcode.NOTIFY, qr: true })],
    ['a query that is not a NOTIFY', event('send', 'udp', { qtype: RRType.SOA })],
    ['a NOTIFY received', event('receive', 'udp', { opcode: DnsOpcode.NOTIFY })],
  ])('does not count %s as a NOTIFY sent', (_label, packet) => {
    const stats = statistics();
    countNotifyPacket(stats, packet);
    expect(nonZero(stats)).toEqual({});
  });

  const SECONDARY: NotifyFacts = { wellFormed: true, zoneType: 'Secondary', fromMaster: true, localSerial: 10, announcedSerial: 11 };
  const NOTIFY_CASES: ReadonlyArray<readonly [string, NotifyFacts, Record<string, number>]> = [
    ['a newer serial from a known master', SECONDARY,
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyNewVersion': 1 }],
    ['the same serial', { ...SECONDARY, announcedSerial: 10 },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyCurrentVersion': 1 }],
    ['an older serial', { ...SECONDARY, announcedSerial: 9 },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyOldVersion': 1 }],
    ['a serial that wrapped past 2^32 is newer', { ...SECONDARY, localSerial: 0xFFFFFFFE, announcedSerial: 1 },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyNewVersion': 1 }],
    ['a NOTIFY without SOA', { ...SECONDARY, announcedSerial: null },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1 }],
    ['a secondary zone that is not loaded yet', { ...SECONDARY, localSerial: null },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyNoVersion': 1 }],
    ['a sender that is not a master', { ...SECONDARY, fromMaster: false },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyMasterUnknown': 1 }],
    ['a primary zone', { ...SECONDARY, zoneType: 'Primary', fromMaster: false },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyPrimary': 1 }],
    ['a zone the server does not have', { ...SECONDARY, zoneType: null, fromMaster: false, localSerial: null },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNoVersion': 1 }],
    ['a forwarder zone', { ...SECONDARY, zoneType: 'Forwarder', fromMaster: false, localSerial: null },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNoVersion': 1 }],
    ['a malformed NOTIFY', { ...SECONDARY, wellFormed: false },
      { 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyInvalid': 1 }],
  ];

  it.each(NOTIFY_CASES)('%s', (_label, facts, expected) => {
    const stats = statistics();
    countNotifyReceived(stats, facts);
    expect(nonZero(stats)).toEqual(expected);
  });
});

describe('dynamic updates', () => {
  const PLAIN: UpdateFacts = { zone: 'corp.test', signed: false, verified: false, refusal: null, empty: false, changed: true };
  const UPDATE_CASES: ReadonlyArray<readonly [string, number, UpdateFacts, Record<string, number>]> = [
    ['an update that changed the zone', DnsRcode.NOERROR, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Completed': 1 }],
    ['an update that changed nothing', DnsRcode.NOERROR, { ...PLAIN, changed: false },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Completed': 1, 'UpdateStatistics.NoOps': 1 }],
    ['an update without update records', DnsRcode.NOERROR, { ...PLAIN, empty: true, changed: false },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Completed': 1, 'UpdateStatistics.NoOps': 1, 'UpdateStatistics.Empty': 1 }],
    ['a signed update that changed the zone', DnsRcode.NOERROR, { ...PLAIN, signed: true, verified: true },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Completed': 1, 'UpdateStatistics.SecureSuccess': 1, 'SecurityStatistics.SecurityTSigVerifySuccess': 1 }],
    ['an update signed but not verified is no secure success', DnsRcode.NOERROR, { ...PLAIN, signed: true },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Completed': 1 }],
    ['a malformed update', DnsRcode.FORMERR, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.FormError': 1 }],
    ['a prerequisite on a name that does not exist', DnsRcode.NXDOMAIN, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NxDomain': 1 }],
    ['an update the server does not implement', DnsRcode.NOTIMP, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NotImplemented': 1 }],
    ['a refused update', DnsRcode.REFUSED, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.Refused': 1 }],
    ['an unsigned update to a secure zone', DnsUpdateRcode.NOTAUTH, { ...PLAIN, refusal: 'RefusedNonSecure' },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NotAuthoritative': 1, 'UpdateStatistics.RefusedNonSecure': 1 }],
    ['an update that touches a record owned by another principal', DnsRcode.REFUSED, { ...PLAIN, signed: true, verified: true, refusal: 'RefusedAccessDenied' },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.Refused': 1, 'UpdateStatistics.RefusedAccessDenied': 1, 'UpdateStatistics.SecureFailure': 1, 'SecurityStatistics.SecurityTSigVerifySuccess': 1 }],
    ['a name that must not exist', DnsUpdateRcode.YXDOMAIN, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.YxDomain': 1 }],
    ['a record set that must not exist', DnsUpdateRcode.YXRRSET, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.YxRRset': 1 }],
    ['a record set that must exist', DnsUpdateRcode.NXRRSET, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NxRRset': 1 }],
    ['an update for a zone the server is not authoritative for', DnsUpdateRcode.NOTAUTH, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NotAuthoritative': 1 }],
    ['an update whose zone section names another zone', DnsUpdateRcode.NOTZONE, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NotZone': 1 }],
    ['a signed update with a bad signature', DnsUpdateRcode.NOTAUTH, { ...PLAIN, signed: true },
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1, 'UpdateStatistics.NotAuthoritative': 1, 'UpdateStatistics.SecureFailure': 1 }],
    ['a rejection code the table does not know', DnsRcode.SERVFAIL, PLAIN,
      { 'UpdateStatistics.Received': 1, 'UpdateStatistics.Rejected': 1 }],
  ];

  it.each(UPDATE_CASES)('%s', (_label, rcode, facts, expected) => {
    const stats = statistics();
    countUpdate(stats, rcode, facts);
    expect(nonZero(stats)).toEqual(expected);
  });

  it('feeds the statistics of a tracked zone, counting rejections apart', () => {
    const stats = statistics();
    stats.trackZone('corp.test');
    countUpdate(stats, DnsRcode.NOERROR, { zone: 'corp.test', signed: false, verified: false, refusal: null, empty: false, changed: true });
    expect(stats.zoneSnapshot('corp.test')!.update).toEqual({ received: 1, rejected: 0 });
    countUpdate(stats, DnsRcode.REFUSED, { zone: 'corp.test', signed: false, verified: false, refusal: null, empty: false, changed: false });
    countUpdate(stats, DnsRcode.NOERROR, { zone: 'unknown.test', signed: false, verified: false, refusal: null, empty: false, changed: true });
    countUpdate(stats, DnsRcode.FORMERR, { zone: null, signed: false, verified: false, refusal: null, empty: false, changed: false });
    expect(stats.zoneSnapshot('corp.test')!.update).toEqual({ received: 2, rejected: 1 });
    expect(stats.hasZone('unknown.test')).toBe(false);
    expect(nonZero(stats)['UpdateStatistics.Received']).toBe(4);
  });
});
