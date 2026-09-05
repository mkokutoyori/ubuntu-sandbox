import type { DnsCacheRecordView } from '@/network/dns/resolver/DnsCache';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { applyCimCriteria, cimNotFound } from './cimQuery';
import { matchEnumValue } from './netIpAddress';

export type DnsCacheStatus = 'Success' | 'NotExist' | 'NoRecords';
export type DnsCacheSection = 'Answer' | 'Authority' | 'Additional';
export type DnsCacheRecordType = 'A' | 'NS' | 'CNAME' | 'SOA' | 'PTR' | 'MX' | 'AAAA' | 'SRV';

export const DNS_CACHE_STATUSES: readonly DnsCacheStatus[] = ['Success', 'NotExist', 'NoRecords'];
export const DNS_CACHE_SECTIONS: readonly DnsCacheSection[] = ['Answer', 'Authority', 'Additional'];
export const DNS_CACHE_RECORD_TYPES: readonly DnsCacheRecordType[] =
  ['A', 'NS', 'CNAME', 'SOA', 'PTR', 'MX', 'AAAA', 'SRV'];

export const DNS_CACHE_CIM_CLASS = 'MSFT_DNSClientCache';

export const DNS_RECORD_TYPE_NUMBER: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33,
};

export function dnsRdataLength(type: string, value: string): number {
  const upper = type.toUpperCase();
  if (upper === 'A') return 4;
  if (upper === 'AAAA') return 16;
  if (upper === 'TXT') return value.length + 1;
  return value.length + 2;
}

export interface DnsCacheRow {
  entry: string;
  recordName: string;
  recordType: string;
  status: DnsCacheStatus;
  section: DnsCacheSection;
  timeToLive: number;
  dataLength: number;
  data: string;
}

export interface DnsCacheSelection {
  entry?: string[];
  name?: string[];
  type?: string[];
  status?: string[];
  section?: string[];
  timeToLive?: string[];
  dataLength?: string[];
  data?: string[];
}

export function selectDnsCacheEntries<T extends DnsCacheRow>(
  rows: readonly T[], selection: DnsCacheSelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.entry, r => r.entry],
    [selection.name, r => r.recordName],
    [selection.type, r => r.recordType],
    [selection.status, r => r.status],
    [selection.section, r => r.section],
    [selection.timeToLive, r => String(r.timeToLive)],
    [selection.dataLength, r => String(r.dataLength)],
    [selection.data, r => r.data],
  ]);
}

export function dnsCacheSelectionIsEmpty(selection: DnsCacheSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingDnsCacheEntry(selection: DnsCacheSelection): string {
  return cimNotFound(DNS_CACHE_CIM_CLASS, [
    ['Entry', selection.entry],
    ['Name', selection.name],
    ['Type', selection.type],
    ['Status', selection.status],
    ['Section', selection.section],
    ['Data', selection.data],
  ]);
}

const DNS_CACHE_ENUMS: ReadonlyArray<readonly [keyof DnsCacheSelection, string, readonly string[]]> = [
  ['type', 'Type', DNS_CACHE_RECORD_TYPES],
  ['status', 'Status', DNS_CACHE_STATUSES],
  ['section', 'Section', DNS_CACHE_SECTIONS],
];

export function dnsCacheEnumProblem(selection: DnsCacheSelection): string | null {
  for (const [key, label, table] of DNS_CACHE_ENUMS) {
    for (const given of selection[key] ?? []) {
      if (matchEnumValue(table, given) === null) {
        return `Cannot validate argument on parameter '${label}'. The argument "${given}" does not belong to the set "${table.join(',')}".`;
      }
    }
  }
  return null;
}

export function dnsCacheRowsOf(views: readonly DnsCacheRecordView[]): DnsCacheRow[] {
  return views.map((v) => ({
    entry: v.entry,
    recordName: v.name,
    recordType: v.type,
    status: v.negative
      ? (v.rcode === DnsRcode.NXDOMAIN ? 'NotExist' : 'NoRecords')
      : 'Success',
    section: v.negative ? 'Authority' : 'Answer',
    timeToLive: v.ttl,
    dataLength: v.negative ? 0 : dnsRdataLength(v.type, v.data),
    data: v.data,
  }));
}

const DISPLAY_DNS_HEADER = 'Windows IP Configuration';

export function renderDisplayDns(rows: readonly DnsCacheRow[]): string {
  if (rows.length === 0) {
    return `${DISPLAY_DNS_HEADER}\n\n  Record Name . . . . . : (no entries)`;
  }
  const out: string[] = [`${DISPLAY_DNS_HEADER}\n`];
  for (const r of rows) {
    out.push(`    ${r.entry}`);
    out.push(`    ----------------------------------------`);
    out.push(`    Record Name . . . . . : ${r.recordName}`);
    out.push(`    Record Type . . . . . : ${DNS_RECORD_TYPE_NUMBER[r.recordType.toUpperCase()] ?? 0}`);
    out.push(`    Time To Live  . . . . : ${r.timeToLive}`);
    out.push(`    Data Length . . . . . : ${r.dataLength}`);
    out.push(`    Section . . . . . . . : ${r.section}`);
    if (!r.data) { out.push(''); continue; }
    const valueLabel = (r.recordType === 'A' || r.recordType === 'AAAA') ? 'Record' : 'Data';
    out.push(`    ${r.recordType} (Host) ${valueLabel}  . . . : ${r.data}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
