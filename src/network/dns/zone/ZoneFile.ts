import { Zone } from '@/network/dns/zone/Zone';
import type { ResourceRecord, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import {
  makeARecord, makeAaaaRecord, makeNsRecord, makeCnameRecord, makePtrRecord,
  makeMxRecord, makeTxtRecord, makeSrvRecord, makeSoaRecord,
} from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';

export class ZoneFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneFileError';
  }
}

const CLASS_KEYWORD = /^(IN|CH|HS|ANY)$/i;
const DIGITS_ONLY = /^\d+$/;

function preprocess(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;
  let parenDepth = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      i++;
      continue;
    }
    if (!inQuotes && ch === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (!inQuotes && ch === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (!inQuotes && ch === ')') {
      parenDepth--;
      i++;
      continue;
    }
    if (ch === '\n') {
      if (parenDepth > 0) {
        current += ' ';
      } else {
        lines.push(current);
        current = '';
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  if (current.trim().length > 0) lines.push(current);
  return lines;
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return tokens;
}

function normalizeOrigin(token: string): string {
  return token.endsWith('.') ? token.slice(0, -1) : token;
}

function resolveName(token: string, origin: string): string {
  if (token === '@') return origin;
  if (token.endsWith('.')) return token.slice(0, -1);
  return `${token}.${origin}`;
}

export function parseZoneFile(text: string, defaultOrigin?: string): Zone {
  const lines = preprocess(text);

  let origin: string | null = defaultOrigin ? normalizeOrigin(defaultOrigin) : null;
  let defaultTtl: number | undefined;
  let soaMinimum: number | undefined;
  let lastOwner: string | null = null;
  let zone: Zone | null = null;
  const pendingRecords: ResourceRecord[] = [];

  for (const rawLine of lines) {
    const hasLeadingWhitespace = /^[ \t]/.test(rawLine);
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;

    const tokens = tokenize(trimmed);

    if (tokens[0].startsWith('$')) {
      const directive = tokens[0].toUpperCase();
      if (directive === '$ORIGIN') {
        origin = normalizeOrigin(tokens[1]);
      } else if (directive === '$TTL') {
        defaultTtl = parseInt(tokens[1], 10);
      } else {
        throw new ZoneFileError(`unsupported zone file directive "${tokens[0]}"`);
      }
      continue;
    }

    let owner: string;
    let rest: string[];
    if (hasLeadingWhitespace) {
      if (lastOwner === null) {
        throw new ZoneFileError(`record line has no owner name and none precedes it: "${trimmed}"`);
      }
      owner = lastOwner;
      rest = tokens;
    } else {
      if (origin === null) {
        throw new ZoneFileError('a $ORIGIN directive (or a default origin) is required before any record');
      }
      owner = resolveName(tokens[0], origin);
      rest = tokens.slice(1);
    }
    lastOwner = owner;

    if (origin === null) {
      throw new ZoneFileError('a $ORIGIN directive (or a default origin) is required before any record');
    }

    let ttl: number | undefined;
    let idx = 0;
    while (idx < rest.length) {
      if (DIGITS_ONLY.test(rest[idx])) {
        ttl = parseInt(rest[idx], 10);
        idx++;
        continue;
      }
      if (CLASS_KEYWORD.test(rest[idx])) {
        idx++;
        continue;
      }
      break;
    }
    if (ttl === undefined) ttl = defaultTtl ?? soaMinimum;
    if (ttl === undefined) {
      throw new ZoneFileError(`record for owner "${owner}" has no TTL and no $TTL default is in scope`);
    }

    const typeToken = rest[idx];
    idx++;
    if (!typeToken) {
      throw new ZoneFileError(`record for owner "${owner}" is missing its record type`);
    }
    const rdata = rest.slice(idx);
    const type = typeToken.toUpperCase();

    let rr: ResourceRecord;
    switch (type) {
      case 'A':
        rr = makeARecord(owner, ttl, rdata[0]);
        break;
      case 'AAAA':
        rr = makeAaaaRecord(owner, ttl, rdata[0]);
        break;
      case 'NS':
        rr = makeNsRecord(owner, ttl, resolveName(rdata[0], origin));
        break;
      case 'CNAME':
        rr = makeCnameRecord(owner, ttl, resolveName(rdata[0], origin));
        break;
      case 'PTR':
        rr = makePtrRecord(owner, ttl, resolveName(rdata[0], origin));
        break;
      case 'MX':
        rr = makeMxRecord(owner, ttl, parseInt(rdata[0], 10), resolveName(rdata[1], origin));
        break;
      case 'TXT':
        rr = makeTxtRecord(owner, ttl, rdata.length === 1 ? rdata[0] : rdata);
        break;
      case 'SRV':
        rr = makeSrvRecord(owner, ttl, {
          priority: parseInt(rdata[0], 10),
          weight: parseInt(rdata[1], 10),
          port: parseInt(rdata[2], 10),
          target: resolveName(rdata[3], origin),
        });
        break;
      case 'SOA': {
        const soaData = makeSoaRecord(owner, ttl, {
          mname: resolveName(rdata[0], origin),
          rname: resolveName(rdata[1], origin),
          serial: parseInt(rdata[2], 10),
          refresh: parseInt(rdata[3], 10),
          retry: parseInt(rdata[4], 10),
          expire: parseInt(rdata[5], 10),
          minimum: parseInt(rdata[6], 10),
        });
        soaMinimum = (soaData.data as SoaRecordData).minimum;
        rr = soaData;
        break;
      }
      default:
        throw new ZoneFileError(`unrecognized record type "${typeToken}" for owner "${owner}"`);
    }

    if (rr.data.type === RRType.SOA) {
      if (zone) throw new ZoneFileError('a zone file may only contain one SOA record');
      zone = new Zone(origin, rr as ResourceRecord<SoaRecordData>);
      for (const pendingRecord of pendingRecords) zone.addRecord(pendingRecord);
      pendingRecords.length = 0;
    } else if (zone) {
      zone.addRecord(rr);
    } else {
      pendingRecords.push(rr);
    }
  }

  if (!zone) {
    throw new ZoneFileError('zone file does not contain an SOA record');
  }
  return zone;
}
