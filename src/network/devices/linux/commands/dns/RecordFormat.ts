import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

export function rrClassName(rrClass: number): string {
  return rrClass === DnsClass.CH ? 'CH' : rrClass === DnsClass.HS ? 'HS' : 'IN';
}

export function absolute(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

/** Strips a trailing root dot, e.g. for `nslookup`-style non-FQDN display. Never strips a bare `.`. */
export function stripDot(name: string): string {
  return name.endsWith('.') && name !== '.' ? name.slice(0, -1) : name;
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
    case RRType.SRV:
      return `${data.priority} ${data.weight} ${data.port} ${absolute(data.target)}`;
    default:
      return '';
  }
}

export function formatRecordLine(rr: ResourceRecord<ResourceRecordData>): string {
  return `${absolute(rr.name)}\t${rr.ttl}\t${rrClassName(rr.rrClass)}\t${rrTypeName(rr.data.type)}\t${formatRdata(rr)}`;
}

export function isDisplayableRecord(rr: ResourceRecord<ResourceRecordData>): boolean {
  return rr.data.type !== RRType.OPT;
}

/** `nslookup`-style answer formatting (non-interactive `nslookup` and the interactive `>` REPL share this). */
export function formatAnswerLines(
  domain: string,
  records: readonly ResourceRecord<ResourceRecordData>[],
): string[] {
  const lines: string[] = [];
  const addressed: { name: string; address: string }[] = [];

  for (const rr of records) {
    const data = rr.data;
    switch (data.type) {
      case RRType.CNAME:
        lines.push(`${stripDot(rr.name)}\tcanonical name = ${absolute(data.cname)}`);
        break;
      case RRType.A:
      case RRType.AAAA:
        addressed.push({ name: stripDot(rr.name), address: data.address.toString() });
        break;
      case RRType.MX:
        lines.push(`${stripDot(rr.name)}\tmail exchanger = ${data.preference} ${stripDot(data.exchange)}`);
        break;
      case RRType.NS:
        lines.push(`${stripDot(rr.name)}\tnameserver = ${absolute(data.nsdname)}`);
        break;
      case RRType.TXT:
        lines.push(`${stripDot(rr.name)}\ttext = ${quoteTxt(data.text)}`);
        break;
      case RRType.PTR:
        lines.push(`${absolute(rr.name)}\tname = ${absolute(data.ptrdname)}`);
        break;
      case RRType.SOA:
        lines.push(
          stripDot(rr.name),
          `\torigin = ${stripDot(data.mname)}`,
          `\tmail addr = ${stripDot(data.rname)}`,
          `\tserial = ${data.serial}`,
          `\trefresh = ${data.refresh}`,
          `\tretry = ${data.retry}`,
          `\texpire = ${data.expire}`,
          `\tminimum = ${data.minimum}`,
        );
        break;
      case RRType.SRV:
        lines.push(
          `${stripDot(rr.name)}\tSRV service location:`,
          `\t  priority       = ${data.priority}`,
          `\t  weight         = ${data.weight}`,
          `\t  port           = ${data.port}`,
          `\t  svr hostname    = ${absolute(data.target)}`,
        );
        break;
      default:
        break;
    }
  }

  for (const entry of addressed) {
    lines.push(`Name:\t${entry.name}`);
    lines.push(`Address: ${entry.address}`);
  }
  if (lines.length === 0) lines.push(`*** Can't find ${domain}: No answer`);
  return lines;
}
