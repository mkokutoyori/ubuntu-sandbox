import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import {
  makeEmptyRecord, isEmptyRecordData,
  type ResourceRecord, type ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';

export const DnsClassNone = 254;

export type UpdatePrerequisite =
  | { readonly kind: 'rrset-exists'; readonly name: string; readonly type: RRType | number }
  | { readonly kind: 'rrset-exists-value'; readonly record: ResourceRecord<ResourceRecordData> }
  | { readonly kind: 'rrset-absent'; readonly name: string; readonly type: RRType | number }
  | { readonly kind: 'name-in-use'; readonly name: string }
  | { readonly kind: 'name-not-in-use'; readonly name: string };

export type UpdateInstruction =
  | { readonly kind: 'add'; readonly record: ResourceRecord<ResourceRecordData> }
  | { readonly kind: 'delete-rrset'; readonly name: string; readonly type: RRType | number }
  | { readonly kind: 'delete-name'; readonly name: string }
  | { readonly kind: 'delete-record'; readonly record: ResourceRecord<ResourceRecordData> };

export interface DnsUpdateRequest {
  readonly zone: string;
  readonly zoneClass: DnsClass | number;
  readonly prerequisites: readonly UpdatePrerequisite[];
  readonly updates: readonly UpdateInstruction[];
}

function prerequisiteRecord(
  p: UpdatePrerequisite, zoneClass: DnsClass | number,
): ResourceRecord<ResourceRecordData> {
  switch (p.kind) {
    case 'rrset-exists':
      return makeEmptyRecord(p.name, p.type, DnsClass.ANY);
    case 'rrset-exists-value':
      return { ...p.record, ttl: 0, rrClass: zoneClass };
    case 'rrset-absent':
      return makeEmptyRecord(p.name, p.type, DnsClassNone);
    case 'name-in-use':
      return makeEmptyRecord(p.name, RRType.ANY, DnsClass.ANY);
    case 'name-not-in-use':
      return makeEmptyRecord(p.name, RRType.ANY, DnsClassNone);
  }
}

function updateRecord(
  u: UpdateInstruction, zoneClass: DnsClass | number,
): ResourceRecord<ResourceRecordData> {
  switch (u.kind) {
    case 'add':
      return { ...u.record, rrClass: zoneClass };
    case 'delete-rrset':
      return makeEmptyRecord(u.name, u.type, DnsClass.ANY);
    case 'delete-name':
      return makeEmptyRecord(u.name, RRType.ANY, DnsClass.ANY);
    case 'delete-record':
      return { ...u.record, ttl: 0, rrClass: DnsClassNone };
  }
}

export function buildUpdateMessage(request: DnsUpdateRequest, id: number): DnsMessage {
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.UPDATE, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: 0,
    },
    questions: [{ qname: request.zone, qtype: RRType.SOA, qclass: request.zoneClass }],
    answers: request.prerequisites.map((p) => prerequisiteRecord(p, request.zoneClass)),
    authorities: request.updates.map((u) => updateRecord(u, request.zoneClass)),
    additionals: [],
  };
}

export function isUpdateMessage(message: DnsMessage): boolean {
  return !message.flags.qr && message.flags.opcode === DnsOpcode.UPDATE;
}

export class DnsUpdateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsUpdateFormatError';
  }
}

function wireTypeOf(rr: ResourceRecord<ResourceRecordData>): RRType | number {
  return isEmptyRecordData(rr.data) ? rr.data.wireType : rr.data.type;
}

function readPrerequisite(rr: ResourceRecord<ResourceRecordData>): UpdatePrerequisite {
  const type = wireTypeOf(rr);
  const empty = isEmptyRecordData(rr.data);

  if (rr.rrClass === DnsClass.ANY) {
    if (rr.ttl !== 0 || !empty) throw new DnsUpdateFormatError('prerequisite of class ANY must carry no TTL and no RDATA');
    return type === RRType.ANY
      ? { kind: 'name-in-use', name: rr.name }
      : { kind: 'rrset-exists', name: rr.name, type };
  }
  if (rr.rrClass === DnsClassNone) {
    if (rr.ttl !== 0 || !empty) throw new DnsUpdateFormatError('prerequisite of class NONE must carry no TTL and no RDATA');
    return type === RRType.ANY
      ? { kind: 'name-not-in-use', name: rr.name }
      : { kind: 'rrset-absent', name: rr.name, type };
  }
  if (empty) throw new DnsUpdateFormatError('value-dependent prerequisite must carry RDATA');
  return { kind: 'rrset-exists-value', record: rr };
}

function readInstruction(rr: ResourceRecord<ResourceRecordData>): UpdateInstruction {
  const type = wireTypeOf(rr);
  const empty = isEmptyRecordData(rr.data);

  if (rr.rrClass === DnsClass.ANY) {
    if (rr.ttl !== 0 || !empty) throw new DnsUpdateFormatError('deletion of class ANY must carry no TTL and no RDATA');
    return type === RRType.ANY
      ? { kind: 'delete-name', name: rr.name }
      : { kind: 'delete-rrset', name: rr.name, type };
  }
  if (rr.rrClass === DnsClassNone) {
    if (empty) throw new DnsUpdateFormatError('deletion of a single RR must carry its RDATA');
    return { kind: 'delete-record', record: rr };
  }
  if (empty) throw new DnsUpdateFormatError('addition must carry RDATA');
  return { kind: 'add', record: rr };
}

export function readUpdateMessage(message: DnsMessage): DnsUpdateRequest {
  if (message.questions.length !== 1) {
    throw new DnsUpdateFormatError('an update carries exactly one zone section entry');
  }
  const zone = message.questions[0];
  if (zone.qtype !== RRType.SOA) {
    throw new DnsUpdateFormatError('the zone section entry must be of type SOA');
  }
  return {
    zone: zone.qname,
    zoneClass: zone.qclass,
    prerequisites: message.answers.map(readPrerequisite),
    updates: message.authorities.map(readInstruction),
  };
}
