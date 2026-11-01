import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsUpdateRcode } from '@/network/dns/update/UpdateResponder';
import { TsigErrorCode } from '@/network/dns/tsig/Tsig';
import { serialGreaterThan } from '@/network/dns/zone/SerialNumber';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';
import type { TsigRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsPacketEvent } from '@/network/dns/transport/DnsPacketObserver';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import type { DnsServerStatistics, StatisticsCounter, ZoneTransferKind } from './DnsServerStatistics';

const TKEY_QUERY_TYPE = 249;

const RESPONSE_CODE_COUNTERS: ReadonlyMap<number, StatisticsCounter<'ErrorStatistics'>> = new Map([
  [DnsRcode.NOERROR, 'NoError'],
  [DnsRcode.FORMERR, 'FormError'],
  [DnsRcode.SERVFAIL, 'ServFail'],
  [DnsRcode.NXDOMAIN, 'NxDomain'],
  [DnsRcode.NOTIMP, 'NotImpl'],
  [DnsRcode.REFUSED, 'Refused'],
  [DnsUpdateRcode.YXDOMAIN, 'YxDomain'],
  [DnsUpdateRcode.YXRRSET, 'YxRRSet'],
  [DnsUpdateRcode.NXRRSET, 'NxRRSet'],
  [DnsUpdateRcode.NOTAUTH, 'NotAuthoritative'],
  [DnsUpdateRcode.NOTZONE, 'NotZone'],
]);

const TSIG_ERROR_COUNTERS: ReadonlyMap<number, StatisticsCounter<'ErrorStatistics'>> = new Map([
  [TsigErrorCode.BADSIG, 'BadSig'],
  [TsigErrorCode.BADKEY, 'BadKey'],
  [TsigErrorCode.BADTIME, 'BadTime'],
]);

const UPDATE_REJECTION_COUNTERS: ReadonlyMap<number, StatisticsCounter<'UpdateStatistics'>> = new Map([
  [DnsRcode.FORMERR, 'FormError'],
  [DnsRcode.NXDOMAIN, 'NxDomain'],
  [DnsRcode.NOTIMP, 'NotImplemented'],
  [DnsRcode.REFUSED, 'Refused'],
  [DnsUpdateRcode.YXDOMAIN, 'YxDomain'],
  [DnsUpdateRcode.YXRRSET, 'YxRRset'],
  [DnsUpdateRcode.NXRRSET, 'NxRRset'],
  [DnsUpdateRcode.NOTAUTH, 'NotAuthoritative'],
  [DnsUpdateRcode.NOTZONE, 'NotZone'],
]);

export type MasterRefusal = 'RefuseNotAuth' | 'RefuseSecurity' | 'RefuseShutdown';

export type UpdateRefusal = 'RefusedNonSecure' | 'RefusedAccessDenied';

export interface UpdateFacts {
  zone: string | null;
  signed: boolean;
  verified: boolean;
  refusal: UpdateRefusal | null;
  empty: boolean;
  changed: boolean;
}

export interface NotifyFacts {
  readonly wellFormed: boolean;
  readonly zoneType: 'Primary' | 'Secondary' | 'Forwarder' | null;
  readonly fromMaster: boolean;
  readonly localSerial: number | null;
  readonly announcedSerial: number | null;
}

const QUERY_TYPE_COUNTERS: ReadonlyMap<number, StatisticsCounter<'Query2Statistics'>> = new Map([
  [RRType.A, 'TypeA'],
  [RRType.NS, 'TypeNs'],
  [RRType.SOA, 'TypeSoa'],
  [RRType.MX, 'TypeMx'],
  [RRType.PTR, 'TypePtr'],
  [RRType.SRV, 'TypeSrv'],
  [RRType.ANY, 'TypeAll'],
  [RRType.IXFR, 'TypeIxfr'],
  [RRType.AXFR, 'TypeAxfr'],
]);

function isRequest(event: DnsPacketEvent, direction: DnsPacketEvent['direction']): boolean {
  return event.direction === direction && !event.message.flags.qr;
}

function isResponse(event: DnsPacketEvent, direction: DnsPacketEvent['direction']): boolean {
  return event.direction === direction && event.message.flags.qr;
}

function countRequestKind(statistics: DnsServerStatistics, message: DnsMessage): void {
  const { opcode } = message.flags;
  if (opcode === DnsOpcode.NOTIFY) statistics.add('Query2Statistics', 'Notify');
  if (opcode === DnsOpcode.UPDATE) statistics.add('Query2Statistics', 'Update');
  if (opcode !== DnsOpcode.QUERY) return;
  statistics.add('Query2Statistics', 'Standard');
  const qtype = message.questions[0]?.qtype;
  if (qtype === TKEY_QUERY_TYPE) statistics.add('Query2Statistics', 'TKeyNego');
  else statistics.add('Query2Statistics', QUERY_TYPE_COUNTERS.get(qtype) ?? 'TypeOther');
}

function countResponseCode(statistics: DnsServerStatistics, message: DnsMessage): void {
  const tsig = message.additionals.find(record => record.data.type === RRType.TSIG)?.data as TsigRecordData | undefined;
  const tsigCounter = tsig === undefined ? undefined : TSIG_ERROR_COUNTERS.get(tsig.error);
  if (tsigCounter !== undefined) {
    statistics.add('ErrorStatistics', tsigCounter);
    if (tsigCounter === 'BadSig') statistics.add('SecurityStatistics', 'SecurityTSigVerifyFailed');
    if (tsigCounter === 'BadKey') statistics.add('SecurityStatistics', 'SecurityTSigBadKey');
    return;
  }
  if ((findOpt(message)?.data.extendedRcodeHigh ?? 0) > 0) {
    statistics.add('ErrorStatistics', 'Max');
    return;
  }
  statistics.add('ErrorStatistics', RESPONSE_CODE_COUNTERS.get(message.flags.rcode) ?? 'UnknownError');
}

export function countServicePacket(statistics: DnsServerStatistics, event: DnsPacketEvent): void {
  const udp = event.transport === 'udp';
  if (isRequest(event, 'receive')) {
    statistics.add('QueryStatistics', udp ? 'UdpQueries' : 'TcpQueries');
    statistics.add('Query2Statistics', 'TotalQueries');
    countRequestKind(statistics, event.message);
  }
  if (isResponse(event, 'send') && statistics.firstOf(event.exchange, 'response')) {
    statistics.add('QueryStatistics', udp ? 'UdpResponses' : 'TcpResponses');
    countResponseCode(statistics, event.message);
  }
}

function recursionResponseCounter(message: DnsMessage): StatisticsCounter<'RecursionStatistics'> {
  const { rcode } = message.flags;
  if (rcode === DnsRcode.NXDOMAIN) return 'ResponseNameError';
  if (rcode !== DnsRcode.NOERROR) return 'ResponseRCode';
  if (message.answers.length > 0) return 'ResponseAnswer';
  const referral = !message.flags.aa && message.authorities.some(record => record.data.type === RRType.NS);
  return referral ? 'ResponseDelegation' : 'ResponseEmpty';
}

export function countRecursionPacket(statistics: DnsServerStatistics, event: DnsPacketEvent, viaForwarder: boolean): void {
  const udp = event.transport === 'udp';
  if (isRequest(event, 'send')) {
    statistics.add('QueryStatistics', udp ? 'UdpQueriesSent' : 'TcpQueriesSent');
    statistics.add('RecursionStatistics', 'Sends');
    if (viaForwarder) statistics.add('RecursionStatistics', 'Forwards');
    if (!udp) {
      statistics.add('RecursionStatistics', 'TcpTry');
      statistics.add('RecursionStatistics', 'TcpQuery');
      statistics.add('PrivateStatistics', 'TcpQuery');
    }
  }
  if (isRequest(event, 'timeout')) statistics.add('RecursionStatistics', 'TimedoutQueries');
  if (isResponse(event, 'receive')) {
    statistics.add('QueryStatistics', udp ? 'UdpResponsesReceived' : 'TcpResponsesReceived');
    statistics.add('RecursionStatistics', 'Responses');
    if (!udp) {
      statistics.add('RecursionStatistics', 'TcpResponse');
      statistics.add('RecursionStatistics', 'TcpConnect');
      statistics.add('RecursionStatistics', 'TcpDisconnect');
      statistics.add('PrivateStatistics', 'TcpConnect');
      statistics.add('PrivateStatistics', 'TcpDisconnect');
    }
    if (viaForwarder) statistics.add('RecursionStatistics', 'ResponseFromForwarder');
    statistics.add('RecursionStatistics', event.message.flags.aa ? 'ResponseAuthoritative' : 'ResponseNotAuthoritative');
    statistics.add('RecursionStatistics', recursionResponseCounter(event.message));
  }
}

function secondaryTransferKind(qtype: number | undefined): ZoneTransferKind | null {
  if (qtype === RRType.AXFR) return 'AXFR';
  return qtype === RRType.IXFR ? 'IXFR' : null;
}

function countSecondaryResponse(statistics: DnsServerStatistics, event: DnsPacketEvent, zone: string): void {
  const { message } = event;
  const qtype = message.questions[0]?.qtype;
  const kind = secondaryTransferKind(qtype);
  if (qtype === RRType.SOA) {
    const valid = message.flags.rcode === DnsRcode.NOERROR && message.answers.some(record => record.data.type === RRType.SOA);
    statistics.add('SecondaryStatistics', valid ? 'SoaResponse' : 'SoaResponseInvalid');
    return;
  }
  if (kind === null || !statistics.firstOf(event.exchange, 'transfer')) return;
  const { rcode } = message.flags;
  if (kind === 'AXFR') {
    statistics.add('SecondaryStatistics', 'AxfrResponse');
    if (rcode === DnsRcode.NOERROR) statistics.add('SecondaryStatistics', 'AxfrSuccess');
    else statistics.add('SecondaryStatistics', rcode === DnsRcode.REFUSED ? 'AxfrRefused' : 'AxfrInvalid');
  } else {
    statistics.add('SecondaryStatistics', 'IxfrTcpResponse');
    if (rcode === DnsRcode.NOERROR) statistics.add('SecondaryStatistics', 'IxfrTcpSuccess');
    else if (rcode === DnsRcode.REFUSED) statistics.add('SecondaryStatistics', 'IxfrTcpRefused');
    else statistics.add('SecondaryStatistics', rcode === DnsRcode.FORMERR ? 'IxfrTcpFormError' : 'IxfrTcpInvalid');
  }
  if (statistics.hasZone(zone)) {
    statistics.zoneTransfer(zone, kind, 'responseReceived');
    if (rcode === DnsRcode.NOERROR) statistics.zoneTransfer(zone, kind, 'successReceived');
  }
}

export function countSecondaryPacket(statistics: DnsServerStatistics, event: DnsPacketEvent): void {
  const udp = event.transport === 'udp';
  const zone = normalizeDnsName(event.message.questions[0]?.qname ?? '');
  if (isRequest(event, 'send')) {
    statistics.add('QueryStatistics', udp ? 'UdpQueriesSent' : 'TcpQueriesSent');
    const qtype = event.message.questions[0]?.qtype;
    if (qtype === RRType.SOA) statistics.add('SecondaryStatistics', 'SoaRequest');
    const kind = secondaryTransferKind(qtype);
    if (kind === 'AXFR') statistics.add('SecondaryStatistics', 'AxfrRequest');
    if (kind === 'IXFR') statistics.add('SecondaryStatistics', 'IxfrTcpRequest');
    if (kind !== null && statistics.hasZone(zone)) statistics.zoneTransfer(zone, kind, 'requestSent');
  }
  if (isResponse(event, 'receive')) {
    statistics.add('QueryStatistics', udp ? 'UdpResponsesReceived' : 'TcpResponsesReceived');
    countSecondaryResponse(statistics, event, zone);
  }
}

export function countNotifyPacket(statistics: DnsServerStatistics, event: DnsPacketEvent): void {
  if (isRequest(event, 'send') && event.message.flags.opcode === DnsOpcode.NOTIFY) {
    statistics.add('MasterStatistics', 'NotifySent');
  }
}

export function countUpdate(statistics: DnsServerStatistics, rcode: number, facts: UpdateFacts): void {
  statistics.add('UpdateStatistics', 'Received');
  if (facts.empty) statistics.add('UpdateStatistics', 'Empty');
  if (facts.verified) statistics.add('SecurityStatistics', 'SecurityTSigVerifySuccess');
  if (rcode === DnsRcode.NOERROR) {
    statistics.add('UpdateStatistics', 'Completed');
    if (!facts.changed) statistics.add('UpdateStatistics', 'NoOps');
    if (facts.verified) statistics.add('UpdateStatistics', 'SecureSuccess');
  } else {
    statistics.add('UpdateStatistics', 'Rejected');
    const counter = UPDATE_REJECTION_COUNTERS.get(rcode);
    if (counter !== undefined) statistics.add('UpdateStatistics', counter);
    if (facts.refusal !== null) statistics.add('UpdateStatistics', facts.refusal);
    if (facts.signed) statistics.add('UpdateStatistics', 'SecureFailure');
  }
  if (facts.zone !== null && statistics.hasZone(facts.zone)) statistics.zoneUpdate(facts.zone, rcode !== DnsRcode.NOERROR);
}

export function countNotifyReceived(statistics: DnsServerStatistics, facts: NotifyFacts): void {
  statistics.add('SecondaryStatistics', 'NotifyReceived');
  if (!facts.wellFormed) {
    statistics.add('SecondaryStatistics', 'NotifyInvalid');
    return;
  }
  if (facts.zoneType === 'Primary') {
    statistics.add('SecondaryStatistics', 'NotifyPrimary');
    return;
  }
  if (facts.zoneType !== 'Secondary') {
    statistics.add('SecondaryStatistics', 'NotifyNoVersion');
    return;
  }
  statistics.add('SecondaryStatistics', 'NotifyNonPrimary');
  if (!facts.fromMaster) {
    statistics.add('SecondaryStatistics', 'NotifyMasterUnknown');
    return;
  }
  if (facts.localSerial === null) {
    statistics.add('SecondaryStatistics', 'NotifyNoVersion');
    return;
  }
  if (facts.announcedSerial === null) return;
  if (facts.announcedSerial === facts.localSerial) statistics.add('SecondaryStatistics', 'NotifyCurrentVersion');
  else statistics.add('SecondaryStatistics', serialGreaterThan(facts.announcedSerial, facts.localSerial) ? 'NotifyNewVersion' : 'NotifyOldVersion');
}

export function countValidation(
  statistics: DnsServerStatistics, result: { readonly security?: DnssecStatus; readonly fromCache: boolean },
): void {
  if (result.fromCache) return;
  if (result.security === 'secure') statistics.add('DnssecStatistics', 'SuccessfulValidations');
  if (result.security === 'bogus') statistics.add('DnssecStatistics', 'FailedValidations');
}
