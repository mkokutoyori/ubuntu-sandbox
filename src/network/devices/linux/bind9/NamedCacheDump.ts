import { RRType } from '@/network/dns/wire/RRType';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import type { CachedNegative, CachedRecordSet, DnsCacheSnapshot, DnsTrust } from '@/network/dns/resolver/DnsCache';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import { absolute, formatRdata, masterIndent } from '../commands/dns/RecordFormat';

const TTL_COLUMN = 24;
const TYPE_COLUMN = 32;
const RDATA_COLUMN = 40;
const TAB_WIDTH = 8;
const SOA_NUMBER_WIDTH = 10;
const SECONDS_PER_UNIT: ReadonlyArray<readonly [string, number]> = [
  ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
];

interface Row {
  readonly name: string;
  readonly order: number;
  readonly dumpOrder: number;
  readonly trust: DnsTrust;
  readonly lines: (owner: string | null, classPrinted: boolean) => string[];
}

const NEGATIVE_SET_TYPE = 0;

function dumpOrder(type: number): number {
  if (type === RRType.SOA) return 0;
  if (type === RRType.NS) return 1;
  return type + 2;
}

function describeInterval(seconds: number): string {
  if (seconds === 0) return '0 seconds';
  const parts: string[] = [];
  let remaining = seconds;
  for (const [unit, size] of SECONDS_PER_UNIT) {
    const count = Math.floor(remaining / size);
    remaining -= count * size;
    if (count > 0) parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
  }
  return parts.join(' ');
}

function soaBlock(data: SoaRecordData): string {
  const margin = '\t'.repeat(RDATA_COLUMN / TAB_WIDTH);
  const number = (value: number, label: string) => `${margin}${String(value).padEnd(SOA_NUMBER_WIDTH)} ; ${label}`;
  return [
    `${absolute(data.mname)} ${absolute(data.rname)} (`,
    number(data.serial, 'serial'),
    number(data.refresh, `refresh (${describeInterval(data.refresh)})`),
    number(data.retry, `retry (${describeInterval(data.retry)})`),
    number(data.expire, `expire (${describeInterval(data.expire)})`),
    number(data.minimum, `minimum (${describeInterval(data.minimum)})`),
    `${margin})`,
  ].join('\n');
}

function recordLine(owner: string | null, ttl: number, className: string | null, typeText: string, rdata: string): string {
  let text = owner ?? '';
  let column = text.length;
  const put = (target: number, field: string) => {
    const gap = masterIndent(column, target);
    text += gap.text + field;
    column = gap.column + field.length;
  };
  put(TTL_COLUMN, String(ttl));
  if (className !== null) put(TYPE_COLUMN, className);
  put(TYPE_COLUMN, typeText);
  put(RDATA_COLUMN, rdata);
  return text;
}

function rdataOf(rr: ResourceRecord<ResourceRecordData>): string {
  return rr.data.type === RRType.SOA ? soaBlock(rr.data) : formatRdata(rr);
}

function recordSetRow(set: CachedRecordSet, order: number): Row | null {
  const printable = set.records.filter((rr) => rdataOf(rr) !== '');
  if (printable.length === 0) return null;
  const ttl = Math.min(...printable.map((rr) => rr.ttl));
  return {
    name: set.name, order, dumpOrder: dumpOrder(set.type), trust: set.trust,
    lines: (owner, classPrinted) => printable.map((rr, index) =>
      recordLine(index === 0 ? owner : null, ttl, classPrinted || index > 0 ? null : 'IN', rrTypeName(rr.data.type), rdataOf(rr))),
  };
}

function negativeRow(negative: CachedNegative, order: number): Row {
  const nameError = negative.coveredType === RRType.ANY;
  const covered = nameError ? 'ANY' : rrTypeName(negative.coveredType);
  const soa = negative.soa;
  return {
    name: negative.name, order, dumpOrder: dumpOrder(NEGATIVE_SET_TYPE), trust: 'answer',
    lines: (owner, classPrinted) => [
      recordLine(owner, negative.ttl, classPrinted ? null : 'IN', `\\-${covered}`, nameError ? ';-$NXDOMAIN' : ';-$NXRRSET'),
      `; ${absolute(soa.name)} SOA ${formatRdata(soa)}`,
    ],
  };
}

function canonicalOrder(left: string, right: string): number {
  const labels = (name: string) => (normalizeDnsName(name) === '' ? [] : normalizeDnsName(name).split('.').reverse());
  const a = labels(left);
  const b = labels(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

function rowsOf(snapshot: DnsCacheSnapshot): Row[] {
  const rows: Row[] = [];
  const held = new Set(snapshot.recordSets.map((set) => `${normalizeDnsName(set.name)}|${set.type}`));
  const push = (row: Row | null) => { if (row !== null) rows.push(row); };
  let order = 0;
  for (const set of snapshot.recordSets) push(recordSetRow(set, order++));
  for (const delegation of snapshot.delegations) {
    const nameServers: CachedRecordSet = {
      name: delegation.zone, type: RRType.NS, records: delegation.nameServers, trust: 'glue', storedAtMs: delegation.storedAtMs,
    };
    if (!held.has(`${normalizeDnsName(delegation.zone)}|${RRType.NS}`)) push(recordSetRow(nameServers, order++));
    for (const address of delegation.addresses) {
      const key = `${normalizeDnsName(address.name)}|${RRType.A}`;
      if (held.has(key)) continue;
      held.add(key);
      const glue = delegation.addresses.filter((rr) => normalizeDnsName(rr.name) === normalizeDnsName(address.name));
      push(recordSetRow({ name: address.name, type: RRType.A, records: glue, trust: 'glue', storedAtMs: delegation.storedAtMs }, order++));
    }
  }
  for (const negative of snapshot.negatives) push(negativeRow(negative, order++));
  return rows;
}

export function renderCacheBody(snapshot: DnsCacheSnapshot): string[] {
  const rows = rowsOf(snapshot);
  const byName = new Map<string, Row[]>();
  for (const row of rows) {
    const key = normalizeDnsName(row.name);
    byName.set(key, [...(byName.get(key) ?? []), row]);
  }
  for (const group of byName.values()) group.sort((a, b) => a.dumpOrder - b.dumpOrder || a.order - b.order);
  const lines: string[] = [];
  let classPrinted = false;
  for (const name of [...byName.keys()].sort(canonicalOrder)) {
    const owner = name === '' ? '.' : absolute(byName.get(name)![0].name);
    byName.get(name)!.forEach((row, index) => {
      lines.push(`; ${row.trust}`, ...row.lines(index === 0 ? owner : null, classPrinted));
      classPrinted = true;
    });
  }
  return lines;
}

function dateStamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}`;
}

const ADDRESS_DATABASE = [
  ';', '; Address database dump', ';', '; [edns success/timeout]', '; [plain success/timeout]', ';', ';', '; Unassociated entries', ';',
];
const BAD_CACHE = [';', '; Bad cache', ';'];
const SERVFAIL_CACHE = [';', '; SERVFAIL cache', ';'];

export interface DumpSections {
  readonly cache: boolean;
  readonly addressDatabase: boolean;
  readonly badCache: boolean;
  readonly servfailCache: boolean;
}

export function renderViewDump(name: string, snapshot: DnsCacheSnapshot | null, sections: DumpSections, now: Date): string[] {
  const lines = [';', `; Start view ${name}`, ';'];
  if (sections.cache) {
    lines.push(';', `; Cache dump of view '${name}' (cache ${name})`, ';', '; using a 0 second stale ttl', `$DATE ${dateStamp(now)}`);
    if (snapshot !== null) lines.push(...renderCacheBody(snapshot));
  }
  if (sections.addressDatabase) lines.push(...ADDRESS_DATABASE);
  if (sections.badCache) lines.push(...BAD_CACHE);
  if (sections.servfailCache) lines.push(...SERVFAIL_CACHE);
  return lines;
}
