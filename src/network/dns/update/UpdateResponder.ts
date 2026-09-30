import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { rdataKey } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { Zone } from '@/network/dns/zone/Zone';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import { serialGreaterThan } from '@/network/dns/zone/SerialNumber';
import {
  verifyDnsMessage, signedDnsMessage, tsigErrorCodeFor, TsigErrorCode,
  type TsigKey, type TsigKeyring,
} from '@/network/dns/tsig/Tsig';
import {
  readUpdateMessage, DnsUpdateFormatError,
  type DnsUpdateRequest, type UpdatePrerequisite, type UpdateInstruction,
} from '@/network/dns/update/DnsUpdate';

export const DnsUpdateRcode = {
  YXDOMAIN: 6,
  YXRRSET: 7,
  NXRRSET: 8,
  NOTAUTH: 9,
  NOTZONE: 10,
} as const;

export interface AppliedUpdate {
  readonly additions: readonly ResourceRecord<ResourceRecordData>[];
  readonly removals: readonly ResourceRecord<ResourceRecordData>[];
  readonly refreshed: readonly ResourceRecord<ResourceRecordData>[];
  readonly soa?: ResourceRecord<SoaRecordData>;
}

export type UpdateVerdict =
  | { readonly rcode: 0; readonly applied: AppliedUpdate }
  | { readonly rcode: number; readonly applied?: undefined };

function normalize(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.') ? lower : `${lower}.`;
}

function within(name: string, origin: string): boolean {
  const n = normalize(name);
  const o = normalize(origin);
  return n === o || n.endsWith(`.${o}`);
}

function sameRdata(
  a: ResourceRecord<ResourceRecordData>, b: ResourceRecord<ResourceRecordData>,
): boolean {
  return rdataKey(a.data) === rdataKey(b.data);
}

function checkPrerequisite(zone: Zone, p: UpdatePrerequisite): number {
  switch (p.kind) {
    case 'rrset-exists':
      return zone.getRRSet(p.name, p.type)?.length ? DnsRcode.NOERROR : DnsUpdateRcode.NXRRSET;
    case 'rrset-absent':
      return zone.getRRSet(p.name, p.type)?.length ? DnsUpdateRcode.YXRRSET : DnsRcode.NOERROR;
    case 'name-in-use':
      return zone.hasName(p.name) ? DnsRcode.NOERROR : DnsRcode.NXDOMAIN;
    case 'name-not-in-use':
      return zone.hasName(p.name) ? DnsUpdateRcode.YXDOMAIN : DnsRcode.NOERROR;
    case 'rrset-exists-value':
      return DnsRcode.NOERROR;
  }
}

function checkValuePrerequisites(zone: Zone, prerequisites: readonly UpdatePrerequisite[]): number {
  const wanted = new Map<string, { name: string; type: number; keys: Set<string> }>();
  for (const p of prerequisites) {
    if (p.kind !== 'rrset-exists-value') continue;
    const key = `${normalizeDnsName(p.record.name)}|${p.record.data.type}`;
    const entry = wanted.get(key)
      ?? { name: p.record.name, type: p.record.data.type as number, keys: new Set<string>() };
    entry.keys.add(rdataKey(p.record.data));
    wanted.set(key, entry);
  }
  for (const { name, type, keys } of wanted.values()) {
    const present = new Set((zone.getRRSet(name, type) ?? []).map((rr) => rdataKey(rr.data)));
    if (present.size !== keys.size) return DnsUpdateRcode.NXRRSET;
    for (const key of keys) if (!present.has(key)) return DnsUpdateRcode.NXRRSET;
  }
  return DnsRcode.NOERROR;
}

function cloneZone(zone: Zone): Zone {
  const copy = new Zone(zone.origin, zone.soa);
  for (const rr of zone.allRecords()) {
    if (rr.data.type !== RRType.SOA) copy.addRecord(rr);
  }
  return copy;
}

function isApex(zone: Zone, name: string): boolean {
  return normalizeDnsName(name) === zone.origin;
}

function addInstruction(zone: Zone, rr: ResourceRecord<ResourceRecordData>): boolean {
  const type = rr.data.type;
  const name = normalizeDnsName(rr.name);
  const hasCname = (zone.getRRSet(name, RRType.CNAME)?.length ?? 0) > 0;
  const hasOther = zone.allRecords().some((known) =>
    normalizeDnsName(known.name) === name && known.data.type !== RRType.CNAME);

  if (type === RRType.CNAME) {
    if (hasOther) return false;
    for (const known of zone.getRRSet(name, RRType.CNAME) ?? []) zone.removeRecord(known);
    zone.addRecord(rr);
    return true;
  }
  if (hasCname) return false;
  if (type === RRType.SOA) {
    if (!isApex(zone, name)) return false;
    try {
      if (!serialGreaterThan((rr.data as SoaRecordData).serial, zone.soa.data.serial)) return false;
    } catch {
      return false;
    }
    zone.updateSoa(rr as ResourceRecord<SoaRecordData>);
    return true;
  }
  zone.addRecord(rr);
  return true;
}

function applyInstruction(
  zone: Zone, u: UpdateInstruction, attempted: ResourceRecord<ResourceRecordData>[],
): void {
  switch (u.kind) {
    case 'add':
      if (addInstruction(zone, u.record)) attempted.push(u.record);
      return;
    case 'delete-name': {
      const name = normalizeDnsName(u.name);
      for (const rr of zone.allRecords()) {
        if (normalizeDnsName(rr.name) !== name) continue;
        if (isApex(zone, name) && (rr.data.type === RRType.SOA || rr.data.type === RRType.NS)) continue;
        zone.removeRecord(rr);
      }
      return;
    }
    case 'delete-rrset':
      if (isApex(zone, u.name) && (u.type === RRType.SOA || u.type === RRType.NS)) return;
      for (const rr of zone.getRRSet(u.name, u.type) ?? []) zone.removeRecord(rr);
      return;
    case 'delete-record': {
      const type = u.record.data.type;
      if (type === RRType.SOA) return;
      const set = zone.getRRSet(u.record.name, type) ?? [];
      if (type === RRType.NS && isApex(zone, u.record.name) && set.length <= 1) return;
      for (const rr of set) if (sameRdata(rr, u.record)) zone.removeRecord(rr);
      return;
    }
  }
}

function recordIdentity(rr: ResourceRecord<ResourceRecordData>): string {
  return `${normalizeDnsName(rr.name)}|${rr.data.type}|${rdataKey(rr.data)}`;
}

function diffZones(
  before: Zone, after: Zone, attempted: readonly ResourceRecord<ResourceRecordData>[],
): AppliedUpdate {
  const previous = new Map<string, ResourceRecord<ResourceRecordData>>();
  for (const rr of before.allRecords()) {
    if (rr.data.type !== RRType.SOA) previous.set(recordIdentity(rr), rr);
  }
  const additions: ResourceRecord<ResourceRecordData>[] = [];
  for (const rr of after.allRecords()) {
    if (rr.data.type === RRType.SOA) continue;
    const key = recordIdentity(rr);
    const known = previous.get(key);
    if (!known || known.ttl !== rr.ttl) additions.push(rr);
    previous.delete(key);
  }
  const replaced = new Set(additions.map(recordIdentity));
  const removals = [...previous.entries()]
    .filter(([key]) => !replaced.has(key))
    .map(([, rr]) => rr);
  const added = new Set(additions.map(recordIdentity));
  const refreshed = attempted.filter((rr) =>
    rr.data.type !== RRType.SOA && !added.has(recordIdentity(rr)) && after.getRRSet(rr.name, rr.data.type));
  const soaChanged = after.soa !== before.soa;
  return soaChanged
    ? { additions, removals, refreshed, soa: after.soa }
    : { additions, removals, refreshed };
}

export function evaluateUpdate(zone: Zone, request: DnsUpdateRequest): UpdateVerdict {
  if (request.zoneClass !== DnsClass.IN) return { rcode: DnsRcode.FORMERR };
  if (normalize(request.zone) !== normalize(zone.origin)) return { rcode: DnsUpdateRcode.NOTAUTH };

  for (const p of request.prerequisites) {
    const name = p.kind === 'rrset-exists-value' ? p.record.name : p.name;
    if (!within(name, zone.origin)) return { rcode: DnsUpdateRcode.NOTZONE };
    const verdict = checkPrerequisite(zone, p);
    if (verdict !== DnsRcode.NOERROR) return { rcode: verdict };
  }
  const valueVerdict = checkValuePrerequisites(zone, request.prerequisites);
  if (valueVerdict !== DnsRcode.NOERROR) return { rcode: valueVerdict };

  for (const u of request.updates) {
    const name = u.kind === 'add' || u.kind === 'delete-record' ? u.record.name : u.name;
    if (!within(name, zone.origin)) return { rcode: DnsUpdateRcode.NOTZONE };
  }

  const working = cloneZone(zone);
  const attempted: ResourceRecord<ResourceRecordData>[] = [];
  for (const u of request.updates) applyInstruction(working, u, attempted);
  return { rcode: DnsRcode.NOERROR, applied: diffZones(zone, working, attempted) };
}

export type UpdateSecurityPolicy = 'none' | 'secure';

export interface UpdateAuthorization {
  readonly rcode: number;
  readonly tsigError: number;
  readonly key: TsigKey | null;
  readonly requestMac: Uint8Array | null;
}

export function authorizeUpdate(
  raw: Uint8Array | undefined,
  policy: UpdateSecurityPolicy,
  keyring: TsigKeyring,
  now: number,
): UpdateAuthorization {
  const none: UpdateAuthorization = {
    rcode: DnsRcode.NOERROR, tsigError: 0, key: null, requestMac: null,
  };
  if (!raw) return policy === 'secure' ? refusal(TsigErrorCode.BADKEY) : none;

  const verdict = verifyDnsMessage(raw, { lookup: keyring.lookup, now });
  if (verdict.status === 'absent') {
    return policy === 'secure' ? refusal(TsigErrorCode.BADKEY) : none;
  }
  if (verdict.status === 'ok') {
    return { rcode: DnsRcode.NOERROR, tsigError: 0, key: verdict.key, requestMac: verdict.mac };
  }
  return refusal(tsigErrorCodeFor(verdict.status));
}

function refusal(tsigError: number): UpdateAuthorization {
  return { rcode: DnsUpdateRcode.NOTAUTH, tsigError, key: null, requestMac: null };
}

export function signIfKeyed(
  response: DnsMessage, auth: UpdateAuthorization, now: number,
): DnsMessage {
  if (!auth.key) return response;
  return signedDnsMessage(response, {
    key: auth.key, timeSigned: now, requestMac: auth.requestMac,
  });
}

export function updateResponse(request: DnsMessage, rcode: number): DnsMessage {
  return {
    id: request.id,
    flags: {
      qr: true, opcode: DnsOpcode.UPDATE, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode,
    },
    questions: request.questions,
    answers: [],
    authorities: [],
    additionals: [],
  };
}

export function parseOrFormerr(message: DnsMessage): DnsUpdateRequest | null {
  try {
    return readUpdateMessage(message);
  } catch (error) {
    if (error instanceof DnsUpdateFormatError) return null;
    throw error;
  }
}
