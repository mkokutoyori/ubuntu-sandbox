import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { rrTypeFromName, rrTypeName, rcodeFromWire, isIpLiteral } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn, DnsQueryOptions } from '@/network/dns/compat/DnsWireCompat';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type {
  ARecordData, NsRecordData, ResourceRecord, ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { formatRdata, formatRecordLine, isDisplayableRecord, rrClassName } from './RecordFormat';

interface DigInvocation {
  server: string;
  domain: string;
  qtype: string;
  qclass: number;
  reverse: boolean;
  short: boolean;
  noAll: boolean;
  showAnswer: boolean;
  tcp: boolean;
  recurse: boolean;
  dnssec: boolean;
  bufsize: number | null;
  port: number | null;
  tries: number;
  timeoutSeconds: number;
  trace: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 5;
const DEFAULT_TRIES = 3;

const CLASS_NAMES: Readonly<Record<string, number>> = {
  IN: DnsClass.IN, CH: DnsClass.CH, CHAOS: DnsClass.CH, HS: DnsClass.HS,
};

function parseDigArgs(args: string[], resolverIP: string | undefined): DigInvocation {
  const invocation: DigInvocation = {
    server: resolverIP ?? '',
    domain: '',
    qtype: 'A',
    qclass: DnsClass.IN,
    reverse: false,
    short: false,
    noAll: false,
    showAnswer: false,
    tcp: false,
    recurse: true,
    dnssec: false,
    bufsize: null,
    port: null,
    tries: DEFAULT_TRIES,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    trace: false,
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
    else if (arg === '+trace') { invocation.trace = true; invocation.recurse = false; }
    else if (arg.startsWith('+bufsize=')) invocation.bufsize = parseInt(arg.slice(9), 10) || null;
    else if (arg.startsWith('+time=')) invocation.timeoutSeconds = parseInt(arg.slice(6), 10) || DEFAULT_TIMEOUT_SECONDS;
    else if (arg.startsWith('+tries=')) invocation.tries = parseInt(arg.slice(7), 10) || DEFAULT_TRIES;
    else if (arg === '-x') invocation.reverse = true;
    else if (arg === '-p' && args[i + 1]) {
      invocation.port = parseInt(args[++i], 10) || null;
    } else if (arg === '-c' && args[i + 1]) {
      invocation.qclass = CLASS_NAMES[args[++i].toUpperCase()] ?? DnsClass.IN;
    } else if (arg === '-t' && args[i + 1]) {
      invocation.qtype = args[++i].toUpperCase();
    } else if (arg.startsWith('+') || arg.startsWith('-')) continue;
    else if (!invocation.domain) invocation.domain = arg;
    else if (rrTypeFromName(arg) !== null) invocation.qtype = arg.toUpperCase();
    else if (CLASS_NAMES[arg.toUpperCase()] !== undefined) invocation.qclass = CLASS_NAMES[arg.toUpperCase()];
  }

  if (invocation.reverse) {
    const target = args.find((a) => isIpLiteral(a));
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
  lines.push(`;; SERVER: ${invocation.server}#${invocation.port ?? 53}(${invocation.server})`);
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
    lines.push(`;${qname}\t\t\t${rrClassName(question.qclass)}\t${rrTypeName(question.qtype)}`);
  }
  lines.push('');

  pushSection(lines, 'ANSWER', message.answers);
  pushSection(lines, 'AUTHORITY', message.authorities);
  pushSection(lines, 'ADDITIONAL', message.additionals);

  lines.push(`;; Query time: ${Math.floor(Math.random() * 10) + 1} msec`);
  lines.push(`;; SERVER: ${invocation.server}#${invocation.port ?? 53}(${invocation.server})`);
  lines.push(`;; WHEN: ${new Date().toUTCString()}`);
  lines.push(`;; MSG SIZE  rcvd: ${encodeDnsMessage(message).length}`);
  return lines.join('\n');
}

const MAX_TRACE_HOPS = 8;

/**
 * Resolves a delegation's next-hop server address: prefer in-bailiwick glue
 * (additionals) exactly like a real resolver, and only fall back to an
 * out-of-band A query for the NS name when no glue was offered.
 */
async function resolveNsAddress(
  nsName: string,
  glue: readonly ResourceRecord<ResourceRecordData>[],
  referenceServer: string,
  query: DnsQueryFn,
  timeoutMs: number,
): Promise<string | null> {
  const normalized = nsName.endsWith('.') ? nsName.slice(0, -1) : nsName;
  const glued = glue.find(
    (rr): rr is ResourceRecord<ARecordData> =>
      rr.data.type === RRType.A && (rr.name.endsWith('.') ? rr.name.slice(0, -1) : rr.name) === normalized,
  );
  if (glued) return glued.data.address.toString();

  const response = await query(referenceServer, nsName, 'A', timeoutMs, { recursionDesired: false });
  const a = response?.answers.find((rr): rr is ResourceRecord<ARecordData> => rr.data.type === RRType.A);
  return a ? a.data.address.toString() : null;
}

/** Prints one `+trace` hop (the delegation or final answer received from one server) dig-trace style. */
function pushTraceHop(lines: string[], server: string, port: number, message: DnsMessage): void {
  const records = (message.answers.length > 0 ? message.answers : message.authorities).filter(isDisplayableRecord);
  for (const rr of records) lines.push(formatRecordLine(rr));
  for (const rr of message.additionals.filter(isDisplayableRecord)) lines.push(formatRecordLine(rr));
  lines.push(
    `;; Received ${encodeDnsMessage(message).length} bytes from ${server}#${port}(${server}) in ` +
      `${Math.floor(Math.random() * 10) + 1} ms`,
  );
  lines.push('');
}

/**
 * `dig +trace`: walks the delegation chain hop by hop instead of asking a
 * single (possibly recursive) server for the final answer — mirroring real
 * `dig(1)`'s iterative trace mode. Built entirely on the same `DnsQueryFn`
 * transport as the rest of `dig` (no dependency on `RecursiveResolver`/
 * `EndHost`, which aren't reachable from this CLI-only module): each hop is
 * just another non-recursive query, exactly like a real iterative resolver
 * would send.
 */
async function traceOutput(invocation: DigInvocation, query: DnsQueryFn): Promise<string> {
  const lines: string[] = [`; <<>> DiG <<>> ${invocation.domain} +trace`, ';; global options: +cmd'];
  const timeoutMs = invocation.timeoutSeconds * 1000;
  const port = invocation.port ?? 53;
  let server = invocation.server;

  const rootMessage = await query(server, '.', 'NS', timeoutMs, { recursionDesired: false, port: invocation.port });
  let nsRecords: ResourceRecord<NsRecordData>[] = [];
  let glue: readonly ResourceRecord<ResourceRecordData>[] = [];
  if (rootMessage && (rootMessage.answers.length > 0 || rootMessage.authorities.length > 0)) {
    pushTraceHop(lines, server, port, rootMessage);
    nsRecords = [...rootMessage.answers, ...rootMessage.authorities]
      .filter((rr): rr is ResourceRecord<NsRecordData> => rr.data.type === RRType.NS);
    glue = rootMessage.additionals;
  }

  for (let hop = 0; hop < MAX_TRACE_HOPS; hop++) {
    if (nsRecords.length > 0) {
      let nextServer: string | null = null;
      for (const ns of nsRecords) {
        nextServer = await resolveNsAddress(ns.data.nsdname, glue, server, query, timeoutMs);
        if (nextServer) break;
      }
      if (!nextServer) {
        lines.push(';; connection timed out; no servers could be reached');
        return lines.join('\n');
      }
      server = nextServer;
    }

    const message = await query(
      server, invocation.domain, invocation.qtype, timeoutMs,
      { recursionDesired: false, port: invocation.port ?? undefined },
    );
    if (!message) {
      lines.push(';; connection timed out; no servers could be reached');
      return lines.join('\n');
    }
    pushTraceHop(lines, server, port, message);

    if (message.answers.length > 0) return lines.join('\n');
    const referral = message.authorities.filter(
      (rr): rr is ResourceRecord<NsRecordData> => rr.data.type === RRType.NS,
    );
    if (referral.length === 0) return lines.join('\n');
    nsRecords = referral;
    glue = message.additionals;
  }
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

  if (!invocation.server || !isIpLiteral(invocation.server)) {
    return noServersLine(banner);
  }

  if (invocation.trace) {
    return traceOutput(invocation, query);
  }

  const options: DnsQueryOptions = {
    recursionDesired: invocation.recurse,
    tcp: invocation.tcp,
    dnssecOk: invocation.dnssec,
    udpPayloadSize: invocation.bufsize ?? (invocation.dnssec ? 4096 : undefined),
    port: invocation.port ?? undefined,
    qclass: invocation.qclass,
  };
  let message: DnsMessage | null = null;
  for (let attempt = 0; attempt < Math.max(1, invocation.tries); attempt++) {
    message = await query(
      invocation.server, invocation.domain, invocation.qtype,
      invocation.timeoutSeconds * 1000, options,
    );
    if (message) break;
  }
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
