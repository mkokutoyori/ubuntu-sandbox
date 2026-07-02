import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { rrTypeFromName, rrTypeName, rcodeFromWire } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn, DnsQueryOptions } from '@/network/dns/compat/DnsWireCompat';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { formatRdata, formatRecordLine, isDisplayableRecord } from './RecordFormat';

interface DigInvocation {
  server: string;
  domain: string;
  qtype: string;
  reverse: boolean;
  short: boolean;
  noAll: boolean;
  showAnswer: boolean;
  tcp: boolean;
  recurse: boolean;
  dnssec: boolean;
  bufsize: number | null;
  timeoutSeconds: number;
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const DEFAULT_TIMEOUT_SECONDS = 5;

function parseDigArgs(args: string[], resolverIP: string | undefined): DigInvocation {
  const invocation: DigInvocation = {
    server: resolverIP ?? '',
    domain: '',
    qtype: 'A',
    reverse: false,
    short: false,
    noAll: false,
    showAnswer: false,
    tcp: false,
    recurse: true,
    dnssec: false,
    bufsize: null,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('@')) invocation.server = arg.slice(1);
    else if (arg === '+short') invocation.short = true;
    else if (arg === '+tcp' || arg === '+vc') invocation.tcp = true;
    else if (arg === '+noall') invocation.noAll = true;
    else if (arg === '+answer') invocation.showAnswer = true;
    else if (arg === '+norecurse') invocation.recurse = false;
    else if (arg === '+recurse') invocation.recurse = true;
    else if (arg === '+dnssec') invocation.dnssec = true;
    else if (arg.startsWith('+bufsize=')) invocation.bufsize = parseInt(arg.slice(9), 10) || null;
    else if (arg.startsWith('+time=')) invocation.timeoutSeconds = parseInt(arg.slice(6), 10) || DEFAULT_TIMEOUT_SECONDS;
    else if (arg.startsWith('+tries=')) continue;
    else if (arg === '-x') invocation.reverse = true;
    else if (arg === '-t' && args[i + 1]) {
      invocation.qtype = args[++i].toUpperCase();
    } else if (arg.startsWith('+') || arg.startsWith('-')) continue;
    else if (!invocation.domain) invocation.domain = arg;
    else if (rrTypeFromName(arg) !== null) invocation.qtype = arg.toUpperCase();
  }

  if (invocation.reverse) {
    const target = args.find((a) => IPV4_LITERAL.test(a));
    if (target) invocation.domain = target;
    invocation.qtype = 'PTR';
  }
  if (invocation.qtype === 'AXFR' || invocation.qtype === 'IXFR') invocation.tcp = true;
  return invocation;
}

function noServersLine(banner: string): string {
  return `; <<>> DiG <<>> ${banner}\n;; connection timed out; no servers could be reached`;
}

function shortOutput(answers: readonly ResourceRecord<ResourceRecordData>[]): string {
  return answers.filter(isDisplayableRecord).map(formatRdata).join('\n');
}

function transferOutput(invocation: DigInvocation, message: DnsMessage): string {
  const lines: string[] = [
    `; <<>> DiG <<>> @${invocation.server} ${invocation.domain} ${invocation.qtype}`,
    ';; global options: +cmd',
  ];
  const records = message.answers.filter(isDisplayableRecord);
  if (message.flags.rcode !== DnsRcode.NOERROR || records.length === 0) {
    lines.push('; Transfer failed.');
    return lines.join('\n');
  }
  for (const rr of records) lines.push(formatRecordLine(rr));
  lines.push(`;; Query time: ${Math.floor(Math.random() * 10) + 1} msec`);
  lines.push(`;; SERVER: ${invocation.server}#53(${invocation.server})`);
  lines.push(`;; WHEN: ${new Date().toUTCString()}`);
  lines.push(`;; XFR size: ${records.length} records (messages 1, bytes ${encodeDnsMessage(message).length})`);
  return lines.join('\n');
}

function headerFlags(message: DnsMessage): string {
  const flags: string[] = [];
  if (message.flags.qr) flags.push('qr');
  if (message.flags.aa) flags.push('aa');
  if (message.flags.tc) flags.push('tc');
  if (message.flags.rd) flags.push('rd');
  if (message.flags.ra) flags.push('ra');
  if (message.flags.ad) flags.push('ad');
  if (message.flags.cd) flags.push('cd');
  return flags.join(' ');
}

function pushSection(
  lines: string[],
  title: string,
  records: readonly ResourceRecord<ResourceRecordData>[],
): void {
  const displayable = records.filter(isDisplayableRecord);
  if (displayable.length === 0) return;
  lines.push(`;; ${title} SECTION:`);
  for (const rr of displayable) lines.push(formatRecordLine(rr));
  lines.push('');
}

function fullOutput(invocation: DigInvocation, message: DnsMessage): string {
  const lines: string[] = [
    `; <<>> DiG <<>> @${invocation.server} ${invocation.domain} ${invocation.qtype}`,
    ';; global options: +cmd',
    ';; Got answer:',
    `;; ->>HEADER<<- opcode: QUERY, status: ${rcodeFromWire(message.flags.rcode)}, id: ${message.id}`,
    `;; flags: ${headerFlags(message)}; QUERY: ${message.questions.length}, ` +
      `ANSWER: ${message.answers.length}, AUTHORITY: ${message.authorities.length}, ` +
      `ADDITIONAL: ${message.additionals.length}`,
  ];
  if (invocation.recurse && !message.flags.ra) {
    lines.push(';; WARNING: recursion requested but not available');
  }
  lines.push('');

  const opt = findOpt(message);
  if (opt) {
    lines.push(';; OPT PSEUDOSECTION:');
    const doFlag = opt.data.dnssecOk ? 'flags: do;' : 'flags:;';
    lines.push(`; EDNS: version: ${opt.data.version}, ${doFlag} udp: ${opt.data.udpPayloadSize}`);
    lines.push('');
  }

  lines.push(';; QUESTION SECTION:');
  for (const question of message.questions) {
    const qname = question.qname.endsWith('.') ? question.qname : `${question.qname}.`;
    lines.push(`;${qname}\t\t\tIN\t${rrTypeName(question.qtype)}`);
  }
  lines.push('');

  pushSection(lines, 'ANSWER', message.answers);
  pushSection(lines, 'AUTHORITY', message.authorities);
  pushSection(lines, 'ADDITIONAL', message.additionals);

  lines.push(`;; Query time: ${Math.floor(Math.random() * 10) + 1} msec`);
  lines.push(`;; SERVER: ${invocation.server}#53(${invocation.server})`);
  lines.push(`;; WHEN: ${new Date().toUTCString()}`);
  lines.push(`;; MSG SIZE  rcvd: ${encodeDnsMessage(message).length}`);
  return lines.join('\n');
}

export async function executeDig(
  args: string[],
  query: DnsQueryFn,
  resolverIP?: string,
): Promise<string> {
  const invocation = parseDigArgs(args, resolverIP);
  const banner = invocation.server
    ? `@${invocation.server} ${invocation.domain}`
    : invocation.domain;

  if (!invocation.server || !IPV4_LITERAL.test(invocation.server)) {
    return noServersLine(banner);
  }

  const options: DnsQueryOptions = {
    recursionDesired: invocation.recurse,
    tcp: invocation.tcp,
    dnssecOk: invocation.dnssec,
    udpPayloadSize: invocation.bufsize ?? (invocation.dnssec ? 4096 : undefined),
  };
  const message = await query(
    invocation.server, invocation.domain, invocation.qtype,
    invocation.timeoutSeconds * 1000, options,
  );
  if (!message) return noServersLine(banner);

  if (invocation.qtype === 'AXFR' || invocation.qtype === 'IXFR') {
    return transferOutput(invocation, message);
  }
  if (invocation.short) return shortOutput(message.answers);
  if (invocation.noAll && invocation.showAnswer) {
    return message.answers.filter(isDisplayableRecord).map(formatRecordLine).join('\n');
  }
  return fullOutput(invocation, message);
}
