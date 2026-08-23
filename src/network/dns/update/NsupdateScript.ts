import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import {
  makeARecord, makeAaaaRecord, makeCnameRecord, makeMxRecord,
  makePtrRecord, makeTxtRecord,
  type ResourceRecord, type ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';
import type {
  UpdateInstruction, UpdatePrerequisite, DnsUpdateRequest,
} from '@/network/dns/update/DnsUpdate';
import { TsigAlgorithm, type TsigKey } from '@/network/dns/tsig/Tsig';
import { DnsUpdateRcode } from '@/network/dns/update/UpdateResponder';

export interface NsupdateScript {
  server: string | null;
  zone: string | null;
  prerequisites: UpdatePrerequisite[];
  updates: UpdateInstruction[];
}

export const NSUPDATE_RCODE_NAMES = new Map<number, string>([
  [DnsRcode.NOERROR, 'NOERROR'],
  [DnsRcode.FORMERR, 'FORMERR'],
  [DnsRcode.SERVFAIL, 'SERVFAIL'],
  [DnsRcode.NXDOMAIN, 'NXDOMAIN'],
  [DnsRcode.NOTIMP, 'NOTIMP'],
  [DnsRcode.REFUSED, 'REFUSED'],
  [DnsUpdateRcode.YXDOMAIN, 'YXDOMAIN'],
  [DnsUpdateRcode.YXRRSET, 'YXRRSET'],
  [DnsUpdateRcode.NXRRSET, 'NXRRSET'],
  [DnsUpdateRcode.NOTAUTH, 'NOTAUTH'],
  [DnsUpdateRcode.NOTZONE, 'NOTZONE'],
]);

const TYPE_CODES = new Map<string, number>([
  ['A', RRType.A], ['AAAA', RRType.AAAA], ['CNAME', RRType.CNAME],
  ['MX', RRType.MX], ['PTR', RRType.PTR], ['TXT', RRType.TXT], ['ANY', RRType.ANY],
]);

function buildRecord(
  name: string, ttl: number, type: string, rdata: string[],
): ResourceRecord<ResourceRecordData> | null {
  switch (type) {
    case 'A': return makeARecord(name, ttl, rdata[0]);
    case 'AAAA': return makeAaaaRecord(name, ttl, rdata[0]);
    case 'CNAME': return makeCnameRecord(name, ttl, rdata[0]);
    case 'PTR': return makePtrRecord(name, ttl, rdata[0]);
    case 'TXT': return makeTxtRecord(name, ttl, rdata.join(' '));
    case 'MX': return makeMxRecord(name, ttl, Number(rdata[0]), rdata[1]);
    default: return null;
  }
}

export function parseNsupdateKeyOption(spec: string): TsigKey | string {
  const parts = spec.split(':');
  if (parts.length === 3) {
    const algorithm = parts[0].endsWith('.') ? parts[0] : `${parts[0]}.`;
    return { name: parts[1], algorithm, secret: parts[2] };
  }
  if (parts.length === 2) {
    return { name: parts[0], algorithm: TsigAlgorithm.HMAC_SHA256, secret: parts[1] };
  }
  return `nsupdate: could not read key from ${spec}`;
}

export function parseNsupdateLine(line: string, script: NsupdateScript): string | null {
  const words = line.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return null;
  const verb = words[0].toLowerCase();

  if (verb === 'server') { script.server = words[1] ?? null; return null; }
  if (verb === 'zone') { script.zone = words[1] ?? null; return null; }

  if (verb === 'prereq') {
    const kind = (words[1] ?? '').toLowerCase();
    const name = words[2] ?? '';
    if (kind === 'nxdomain') { script.prerequisites.push({ kind: 'name-not-in-use', name }); return null; }
    if (kind === 'yxdomain') { script.prerequisites.push({ kind: 'name-in-use', name }); return null; }
    const type = TYPE_CODES.get((words[3] ?? '').toUpperCase());
    if (type === undefined) return `nsupdate: unknown type '${words[3] ?? ''}'`;
    if (kind === 'nxrrset') { script.prerequisites.push({ kind: 'rrset-absent', name, type }); return null; }
    if (kind === 'yxrrset') {
      const rdata = words.slice(4);
      if (rdata.length === 0) { script.prerequisites.push({ kind: 'rrset-exists', name, type }); return null; }
      const record = buildRecord(name, 0, (words[3] ?? '').toUpperCase(), rdata);
      if (!record) return `nsupdate: unknown type '${words[3] ?? ''}'`;
      script.prerequisites.push({ kind: 'rrset-exists-value', record });
      return null;
    }
    return `nsupdate: unknown prerequisite '${kind}'`;
  }

  if (verb === 'update') {
    const action = (words[1] ?? '').toLowerCase();
    if (action === 'add') {
      const name = words[2] ?? '';
      const ttl = Number(words[3]);
      if (!Number.isFinite(ttl)) return 'nsupdate: an added record needs a TTL';
      const type = (words[4] ?? '').toUpperCase();
      const record = buildRecord(name, ttl, type, words.slice(5));
      if (!record) return `nsupdate: unknown type '${words[4] ?? ''}'`;
      script.updates.push({ kind: 'add', record });
      return null;
    }
    if (action === 'delete' || action === 'del') {
      const name = words[2] ?? '';
      if (words.length === 3) { script.updates.push({ kind: 'delete-name', name }); return null; }
      const typeWord = (words[3] ?? '').toUpperCase();
      const type = TYPE_CODES.get(typeWord);
      if (type === undefined) return `nsupdate: unknown type '${words[3] ?? ''}'`;
      if (words.length === 4) { script.updates.push({ kind: 'delete-rrset', name, type }); return null; }
      const record = buildRecord(name, 0, typeWord, words.slice(4));
      if (!record) return `nsupdate: unknown type '${typeWord}'`;
      script.updates.push({ kind: 'delete-record', record });
      return null;
    }
    return `nsupdate: unknown update action '${action}'`;
  }

  if (verb === 'send' || verb === 'answer' || verb === 'show' || verb === 'quit') return null;
  return `nsupdate: unknown command '${verb}'`;
}

export function nsupdateZoneOf(script: NsupdateScript): string | null {
  if (script.zone) return script.zone;
  const first = script.updates[0];
  if (!first) return null;
  const name = first.kind === 'add' || first.kind === 'delete-record'
    ? first.record.name : first.name;
  const dot = name.indexOf('.');
  return dot === -1 ? null : name.slice(dot + 1);
}


export function emptyNsupdateScript(): NsupdateScript {
  return { server: null, zone: null, prerequisites: [], updates: [] };
}

export function nsupdateRequest(script: NsupdateScript): DnsUpdateRequest | null {
  const zone = nsupdateZoneOf(script);
  if (!zone) return null;
  return {
    zone, zoneClass: DnsClass.IN,
    prerequisites: script.prerequisites, updates: script.updates,
  };
}

export function nsupdateRcodeName(rcode: number): string {
  return NSUPDATE_RCODE_NAMES.get(rcode) ?? `RCODE${rcode}`;
}

export function nsupdateNamesAFile(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-y' || a === '-k') { i++; continue; }
    if (a.startsWith('-')) continue;
    return true;
  }
  return false;
}
