import { RRType } from '@/network/dns/wire/RRType';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

function absolute(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

export function quoteTxt(segments: readonly string[]): string {
  const text = segments.join('');
  return text.startsWith('"') && text.endsWith('"') && text.length >= 2 ? text : `"${text}"`;
}

export function formatRdata(rr: ResourceRecord<ResourceRecordData>): string {
  const data = rr.data;
  switch (data.type) {
    case RRType.A:
    case RRType.AAAA:
      return data.address.toString();
    case RRType.NS:
      return absolute(data.nsdname);
    case RRType.CNAME:
      return absolute(data.cname);
    case RRType.PTR:
      return absolute(data.ptrdname);
    case RRType.MX:
      return `${data.preference} ${absolute(data.exchange)}`;
    case RRType.TXT:
      return quoteTxt(data.text);
    case RRType.SOA:
      return `${absolute(data.mname)} ${absolute(data.rname)} ` +
        `${data.serial} ${data.refresh} ${data.retry} ${data.expire} ${data.minimum}`;
    default:
      return '';
  }
}

export function formatRecordLine(rr: ResourceRecord<ResourceRecordData>): string {
  return `${absolute(rr.name)}\t${rr.ttl}\tIN\t${rrTypeName(rr.data.type)}\t${formatRdata(rr)}`;
}

export function isDisplayableRecord(rr: ResourceRecord<ResourceRecordData>): boolean {
  return rr.data.type !== RRType.OPT;
}
