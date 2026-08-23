import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import type { Zone } from '@/network/dns/zone/Zone';
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
  return JSON.stringify(a.data) === JSON.stringify(b.data);
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
    case 'rrset-exists-value': {
      const set = zone.getRRSet(p.record.name, p.record.data.type) ?? [];
      return set.some((rr) => sameRdata(rr, p.record))
        ? DnsRcode.NOERROR : DnsUpdateRcode.NXRRSET;
    }
  }
}

function protectedAtApex(zone: Zone, name: string, type: RRType | number): boolean {
  return normalize(name) === normalize(zone.origin)
    && (type === RRType.SOA || type === RRType.NS);
}

function expand(zone: Zone, u: UpdateInstruction, into: {
  additions: ResourceRecord<ResourceRecordData>[];
  removals: ResourceRecord<ResourceRecordData>[];
}): void {
  switch (u.kind) {
    case 'add':
      into.additions.push(u.record);
      return;
    case 'delete-rrset':
      if (protectedAtApex(zone, u.name, u.type)) return;
      into.removals.push(...(zone.getRRSet(u.name, u.type) ?? []));
      return;
    case 'delete-name':
      for (const rr of zone.allRecords()) {
        if (normalize(rr.name) !== normalize(u.name)) continue;
        if (protectedAtApex(zone, rr.name, rr.data.type)) continue;
        into.removals.push(rr);
      }
      return;
    case 'delete-record': {
      if (protectedAtApex(zone, u.record.name, u.record.data.type)) return;
      const set = zone.getRRSet(u.record.name, u.record.data.type) ?? [];
      for (const rr of set) if (sameRdata(rr, u.record)) into.removals.push(rr);
      return;
    }
  }
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

  const applied = {
    additions: [] as ResourceRecord<ResourceRecordData>[],
    removals: [] as ResourceRecord<ResourceRecordData>[],
  };
  for (const u of request.updates) {
    const name = u.kind === 'add' || u.kind === 'delete-record' ? u.record.name : u.name;
    if (!within(name, zone.origin)) return { rcode: DnsUpdateRcode.NOTZONE };
    expand(zone, u, applied);
  }
  return { rcode: DnsRcode.NOERROR, applied };
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
