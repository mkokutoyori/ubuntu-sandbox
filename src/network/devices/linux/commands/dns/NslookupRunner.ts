import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { rcodeFromWire, ptrQName, isIpLiteral } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn } from '@/network/dns/compat/DnsWireCompat';
import { isDisplayableRecord, formatAnswerLines } from './RecordFormat';

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

  const reverse = isIpLiteral(domain);
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
