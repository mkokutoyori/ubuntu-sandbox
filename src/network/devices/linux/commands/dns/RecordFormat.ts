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

const MASTER_TAB_WIDTH = 8;
const DEBUG_STYLE_COLUMNS = { ttl: 24, className: 32, type: 40, rdata: 48 } as const;
const QUESTION_STYLE_COLUMNS = { className: 32, type: 40 } as const;

export function masterIndent(current: number, target: number): { text: string; column: number } {
  const to = Math.max(target, current + 1);
  const tabs = Math.floor(to / MASTER_TAB_WIDTH) - Math.floor(current / MASTER_TAB_WIDTH);
  if (tabs > 0) {
    const reached = Math.floor(to / MASTER_TAB_WIDTH) * MASTER_TAB_WIDTH;
    return { text: '\t'.repeat(tabs) + ' '.repeat(to - reached), column: to };
  }
  return { text: ' '.repeat(to - current), column: to };
}

function masterFields(first: string, fields: ReadonlyArray<readonly [number, string]>): string {
  let text = first;
  let column = first.length;
  for (const [target, field] of fields) {
    const gap = masterIndent(column, target);
    text += gap.text + field;
    column = gap.column + field.length;
  }
  return text;
}

export function formatRecordLine(rr: ResourceRecord<ResourceRecordData>): string {
  return masterFields(absolute(rr.name), [
    [DEBUG_STYLE_COLUMNS.ttl, String(rr.ttl)],
    [DEBUG_STYLE_COLUMNS.className, rrClassName(rr.rrClass)],
    [DEBUG_STYLE_COLUMNS.type, rrTypeName(rr.data.type)],
    [DEBUG_STYLE_COLUMNS.rdata, formatRdata(rr)],
  ]);
}

export function formatQuestionLine(name: string, qclass: number, qtype: number): string {
  return `;${masterFields(absolute(name), [
    [QUESTION_STYLE_COLUMNS.className, rrClassName(qclass)],
    [QUESTION_STYLE_COLUMNS.type, rrTypeName(qtype)],
  ])}`;
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
