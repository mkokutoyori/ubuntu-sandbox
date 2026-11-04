import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { isIPv4Literal, isIpLiteral, ptrQName, rrTypeFromName, rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn } from '@/network/dns/compat/DnsWireCompat';
import { formatRdata, isDisplayableRecord, stripDot } from './RecordFormat';

const USAGE = [
  'Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]',
  '            [-R number] [-m flag] [-p port] hostname [server]',
  '       -a is equivalent to -v -t ANY',
  '       -A is like -a but omits RRSIG, NSEC, NSEC3',
  '       -c specifies query class for non-IN data',
  '       -C compares SOA records on authoritative nameservers',
  '       -d is equivalent to -v',
  '       -l lists all hosts in a domain, using AXFR',
  '       -m set memory debugging flag (trace|record|usage)',
  '       -N changes the number of dots allowed before root lookup is done',
  '       -p specifies the port on the server to query',
  '       -r disables recursive processing',
  '       -R specifies number of retries for UDP packets',
  '       -s a SERVFAIL response should stop query',
  '       -t specifies the query type',
  '       -T enables TCP/IP mode',
  '       -U enables UDP mode',
  '       -v enables verbose output',
  '       -V print version number and exit',
  '       -w specifies to wait forever for a reply',
  '       -W specifies how long to wait for a reply',
  '       -4 use IPv4 query transport only',
  '       -6 use IPv6 query transport only',
].join('\n');

const OPTIONS_WITH_VALUE = new Set(['-c', '-m', '-N', '-p', '-R', '-W']);
const DEFAULT_TYPES = ['A', 'AAAA', 'MX'] as const;
const RCODE_NAMES: ReadonlyMap<number, string> = new Map(Object.entries(DnsRcode).map(([name, code]) => [code, name]));

interface HostInvocation {
  readonly name: string;
  readonly server: string | null;
  readonly types: readonly string[];
  readonly explicitType: boolean;
}

function parseInvocation(args: readonly string[]): HostInvocation | string {
  let requestedType: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-t') {
      requestedType = args[++i] ?? '';
      if (rrTypeFromName(requestedType) === null) return `host: invalid type: ${requestedType}`;
    } else if (OPTIONS_WITH_VALUE.has(arg)) {
      i++;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  if (positional.length === 0) return USAGE;
  const name = positional[0];
  const reverse = isIpLiteral(name);
  return {
    name: !reverse ? name : isIPv4Literal(name) ? `${ptrQName(name)}.` : ptrQName(name),
    server: positional[1] ?? null,
    types: reverse ? ['PTR'] : requestedType !== null ? [requestedType.toUpperCase()] : DEFAULT_TYPES,
    explicitType: reverse || requestedType !== null,
  };
}

function serverBanner(server: string): string {
  return `Using domain server:\nName: ${server}\nAddress: ${server}#53\nAliases: \n\n`;
}

export function formatHostLine(record: ResourceRecord<ResourceRecordData>): string {
  const owner = stripDot(record.name);
  const data = record.data;
  switch (data.type) {
    case RRType.A: return `${owner} has address ${formatRdata(record)}`;
    case RRType.AAAA: return `${owner} has IPv6 address ${formatRdata(record)}`;
    case RRType.CNAME: return `${owner} is an alias for ${formatRdata(record)}`;
    case RRType.MX: return `${owner} mail is handled by ${formatRdata(record)}`;
    case RRType.NS: return `${owner} name server ${formatRdata(record)}`;
    case RRType.PTR: return `${owner} domain name pointer ${formatRdata(record)}`;
    case RRType.TXT: return `${owner} descriptive text ${formatRdata(record)}`;
    default: return `${owner} has ${rrTypeName(data.type)} record ${formatRdata(record)}`;
  }
}

export async function executeHost(args: string[], query: DnsQueryFn, resolverIP?: string): Promise<string> {
  const invocation = parseInvocation(args);
  if (typeof invocation === 'string') return invocation;
  const server = invocation.server ?? resolverIP ?? '';
  const banner = invocation.server === null ? '' : serverBanner(invocation.server);
  if (!server) return `Host ${invocation.name} not found: 5(REFUSED)`;

  const lines: string[] = [];
  for (const type of invocation.types) {
    const message = await query(server, invocation.name, type);
    if (!message) return `${banner};; connection timed out; no servers could be reached`;
    const rcode = message.flags.rcode;
    if (rcode !== DnsRcode.NOERROR) {
      return `${banner}Host ${invocation.name} not found: ${rcode}(${RCODE_NAMES.get(rcode) ?? 'SERVFAIL'})`;
    }
    const answers = message.answers.filter(isDisplayableRecord);
    if (answers.length === 0 && invocation.explicitType) {
      lines.push(`${stripDot(invocation.name)} has no ${type} record`);
    }
    for (const answer of answers) {
      const line = formatHostLine(answer);
      if (!lines.includes(line)) lines.push(line);
    }
  }
  return `${banner}${lines.join('\n')}`;
}
