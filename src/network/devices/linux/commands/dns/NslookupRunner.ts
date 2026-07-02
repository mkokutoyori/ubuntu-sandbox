import { RRType } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { rcodeFromWire, ptrQName } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn } from '@/network/dns/compat/DnsWireCompat';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { quoteTxt, isDisplayableRecord } from './RecordFormat';

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

function stripDot(name: string): string {
  return name.endsWith('.') && name !== '.' ? name.slice(0, -1) : name;
}

function absolute(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

function formatAnswerLines(
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

export async function executeNslookup(
  args: string[],
  query: DnsQueryFn,
  resolverIP?: string,
): Promise<string> {
  let domain = '';
  let server = resolverIP ?? '';
  let qtype = 'A';

  for (const arg of args) {
    if (arg.startsWith('-type=') || arg.startsWith('-querytype=') || arg.startsWith('-q=')) {
      qtype = arg.split('=')[1].toUpperCase();
    } else if (arg.startsWith('-')) {
      continue;
    } else if (!domain) {
      domain = arg;
    } else {
      server = arg;
    }
  }

  if (!domain) return 'Usage: nslookup [-type=TYPE] domain [server]';

  const reverse = IPV4_LITERAL.test(domain);
  if (!server) return `** server can't find ${domain}: REFUSED`;

  const message = await query(server, domain, reverse ? 'PTR' : qtype);
  if (!message) return ';; connection timed out; no servers could be reached';

  const lines: string[] = [
    `Server:\t\t${server}`,
    `Address:\t${server}#53`,
    '',
  ];

  if (message.flags.rcode !== DnsRcode.NOERROR) {
    lines.push(`** server can't find ${reverse ? ptrQName(domain) : domain}: ${rcodeFromWire(message.flags.rcode)}`);
    return lines.join('\n');
  }

  const records = message.answers.filter(isDisplayableRecord);
  if (!message.flags.aa && records.length > 0) {
    lines.push('Non-authoritative answer:');
  }
  lines.push(...formatAnswerLines(reverse ? ptrQName(domain) : domain, records));
  return lines.join('\n');
}
