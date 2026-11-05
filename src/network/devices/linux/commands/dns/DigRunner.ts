import { simulationDate } from '@/network/core/SystemClock';

import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { PathClock } from '@/network/core/time/PathClock';
import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { rrTypeFromName, rcodeFromWire, isIpLiteral } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn, DnsQueryOptions } from '@/network/dns/compat/DnsWireCompat';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { pemToCertChain, pemToPrivateKey } from '@/network/pki/pem';
import { privateKeyPairsWith } from '@/network/pki/keyPairing';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type {
  ARecordData, NsRecordData, ResourceRecord, ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { formatQuestionLine, formatRdata, formatRecordLine, headerFlags, isDisplayableRecord } from './RecordFormat';
import { bindVersion } from './BindVersion';
import { parseResolvConf, searchCandidates } from '../../nss/ResolvConf';
import type { ResolvConfOptions } from '../../nss/ResolvConf';

interface DigDisplay {
  cmd: boolean;
  comments: boolean;
  question: boolean;
  answer: boolean;
  authority: boolean;
  additional: boolean;
  stats: boolean;
}

const DISPLAY_FLAGS = ['cmd', 'comments', 'question', 'answer', 'authority', 'additional', 'stats'] as const;
const DISPLAY_OPTION = /^\+(no)?(cmd|comments|question|answer|authority|additional|stats)$/;
const DEFAULT_EDNS_BUFFER = 1232;

interface DigInvocation {
  server: string;
  domain: string;
  qtype: string;
  qclass: number;
  reverse: boolean;
  short: boolean;
  display: DigDisplay;
  serverGiven: boolean;
  noEdns: boolean;
  tcp: boolean;
  ignoreTruncation: boolean;
  search: boolean;
  /** `+tls` — DNS-over-TLS (RFC 7858), port 853 par défaut. */
  tls: boolean;
  /** `+https[=chemin]`, `+https-get[=chemin]` — DNS-over-HTTPS (RFC 8484), port 443 par défaut. */
  https: { readonly path: string; readonly method: 'GET' | 'POST'; readonly plain: boolean } | null;
  /** `+tls-ca[=fichier]` — authentifie le serveur ; sans fichier, les ancres du système. */
  tlsCa: { readonly file: string | null } | null;
  /** `+tls-hostname=nom` — nom présenté (SNI) et vérifié dans le certificat. */
  tlsHostname: string | null;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  recurse: boolean;
  dnssec: boolean;
  bufsize: number | null;
  port: number | null;
  tries: number;
  timeoutSeconds: number;
  trace: boolean;
  typedArguments: string;
}

const DEFAULT_DOH_PATH = '/dns-query';
const DEFAULT_TIMEOUT_SECONDS = 5;
const DEFAULT_TRIES = 3;

const CLASS_NAMES: Readonly<Record<string, number>> = {
  IN: DnsClass.IN, CH: DnsClass.CH, CHAOS: DnsClass.CH, HS: DnsClass.HS,
};

function newInvocation(): DigInvocation {
  return {
    server: '',
    domain: '',
    qtype: 'A',
    qclass: DnsClass.IN,
    reverse: false,
    short: false,
    display: { cmd: true, comments: true, question: true, answer: true, authority: true, additional: true, stats: true },
    serverGiven: false,
    noEdns: false,
    tcp: false,
    ignoreTruncation: false,
    search: false,
    tls: false,
    https: null,
    tlsCa: null,
    tlsHostname: null,
    tlsCertFile: null,
    tlsKeyFile: null,
    recurse: true,
    dnssec: false,
    bufsize: null,
    port: null,
    tries: DEFAULT_TRIES,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    trace: false,
    typedArguments: '',
  };
}

/**
 * Parses one dig invocation into one or more query groups: `@server` and
 * `+`/most `-` options are global (apply to every group), but each bare
 * `name [type] [class]` positional run starts its own group — real dig's
 * `dig www.example.com MX mail.example.com A` runs two lookups.
 */
function parseDigInvocations(args: string[], resolverIP: string | undefined): DigInvocation[] {
  let server = resolverIP ?? '';
  let short = false;
  let serverGiven = false;
  let noEdns = false;
  const display = newInvocation().display;
  const setDisplay = (state: boolean, keys: readonly (keyof DigDisplay)[]): void => {
    for (const key of keys) display[key] = state;
  };
  let tcp = false;
  let ignoreTruncation = false;
  let search = false;
  let tls = false;
  let https: DigInvocation['https'] = null;
  let tlsCa: DigInvocation['tlsCa'] = null;
  let tlsHostname: string | null = null;
  let tlsCertFile: string | null = null;
  let tlsKeyFile: string | null = null;
  let recurse = true;
  let dnssec = false;
  let bufsize: number | null = null;
  let port: number | null = null;
  let tries = DEFAULT_TRIES;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let trace = false;
  let globalReverse = false;
  let pendingQtype = 'A';
  let pendingQclass: number = DnsClass.IN;

  const groups: DigInvocation[] = [];
  let current: DigInvocation | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const displayOption = DISPLAY_OPTION.exec(arg);
    if (arg.startsWith('@')) { server = arg.slice(1); serverGiven = true; }
    else if (arg === '+short') {
      short = true;
      setDisplay(false, DISPLAY_FLAGS);
      display.answer = true;
    }
    else if (arg === '+noshort') short = false;
    else if (arg === '+all' || arg === '+noall') setDisplay(arg === '+all', DISPLAY_FLAGS);
    else if (displayOption) display[displayOption[2] as keyof DigDisplay] = displayOption[1] === undefined;
    else if (arg === '+noedns') noEdns = true;
    else if (arg === '+edns' || arg.startsWith('+edns=')) noEdns = false;
    else if (arg === '+tcp' || arg === '+vc') tcp = true;
    else if (arg === '+search') search = true;
    else if (arg === '+nosearch') search = false;
    else if (arg === '+ignore') ignoreTruncation = true;
    else if (arg === '+noignore') ignoreTruncation = false;
    else if (arg === '+tls') tls = true;
    else if (arg === '+notls') tls = false;
    else if (/^\+https(-post)?(=|$)/.test(arg)) https = { path: optionValue(arg) ?? DEFAULT_DOH_PATH, method: 'POST', plain: false };
    else if (/^\+https-get(=|$)/.test(arg)) https = { path: optionValue(arg) ?? DEFAULT_DOH_PATH, method: 'GET', plain: false };
    else if (/^\+http-plain(-post)?(=|$)/.test(arg)) https = { path: optionValue(arg) ?? DEFAULT_DOH_PATH, method: 'POST', plain: true };
    else if (/^\+http-plain-get(=|$)/.test(arg)) https = { path: optionValue(arg) ?? DEFAULT_DOH_PATH, method: 'GET', plain: true };
    else if (arg === '+nohttps' || arg === '+nohttp-plain') https = null;
    else if (/^\+tls-ca(=|$)/.test(arg)) { tlsCa = { file: optionValue(arg) }; tls = true; }
    else if (arg === '+notls-ca') tlsCa = null;
    else if (arg.startsWith('+tls-hostname=')) { tlsHostname = optionValue(arg); tls = true; }
    else if (arg === '+notls-hostname') tlsHostname = null;
    else if (arg.startsWith('+tls-certfile=')) { tlsCertFile = optionValue(arg); tls = true; }
    else if (arg === '+notls-certfile') tlsCertFile = null;
    else if (arg.startsWith('+tls-keyfile=')) { tlsKeyFile = optionValue(arg); tls = true; }
    else if (arg === '+notls-keyfile') tlsKeyFile = null;
    else if (arg === '+norecurse') recurse = false;
    else if (arg === '+recurse') recurse = true;
    else if (arg === '+dnssec') dnssec = true;
    else if (arg === '+trace') { trace = true; recurse = false; }
    else if (arg.startsWith('+bufsize=')) bufsize = parseInt(arg.slice(9), 10) || null;
    else if (arg.startsWith('+time=')) timeoutSeconds = parseInt(arg.slice(6), 10) || DEFAULT_TIMEOUT_SECONDS;
    else if (arg.startsWith('+tries=')) tries = parseInt(arg.slice(7), 10) || DEFAULT_TRIES;
    else if (arg === '-x') globalReverse = true;
    else if (arg === '-p' && args[i + 1]) {
      port = parseInt(args[++i], 10) || null;
    } else if (arg === '-c' && args[i + 1]) {
      pendingQclass = CLASS_NAMES[args[++i].toUpperCase()] ?? DnsClass.IN;
      if (current) current.qclass = pendingQclass;
    } else if (arg === '-t' && args[i + 1]) {
      pendingQtype = args[++i].toUpperCase();
      if (current) current.qtype = pendingQtype;
    } else if (arg.startsWith('+') || arg.startsWith('-')) continue;
    else if (current && rrTypeFromName(arg) !== null) current.qtype = arg.toUpperCase();
    // `dig AAAA example.com` — le vrai dig reconnaît un type avant le nom.
    // Sans ceci, `AAAA` devenait le nom cherché et la requête partait en A.
    else if (!current && rrTypeFromName(arg) !== null) pendingQtype = arg.toUpperCase();
    else if (current && CLASS_NAMES[arg.toUpperCase()] !== undefined) current.qclass = CLASS_NAMES[arg.toUpperCase()];
    else {
      if (current) groups.push(current);
      current = newInvocation();
      current.domain = arg;
      current.qtype = pendingQtype;
      current.qclass = pendingQclass;
    }
  }
  if (current) groups.push(current);
  if (groups.length === 0) {
    const empty = newInvocation();
    empty.qtype = pendingQtype;
    empty.qclass = pendingQclass;
    groups.push(empty);
  }

  for (const g of groups) {
    g.server = server;
    g.short = short;
    g.display = { ...display };
    g.serverGiven = serverGiven;
    g.noEdns = noEdns;
    g.tcp = tcp;
    g.ignoreTruncation = ignoreTruncation;
    g.search = search;
    g.tls = tls;
    g.https = https;
    g.tlsCa = tlsCa;
    g.tlsHostname = tlsHostname;
    g.tlsCertFile = tlsCertFile;
    g.tlsKeyFile = tlsKeyFile;
    g.recurse = recurse;
    g.dnssec = dnssec;
    g.bufsize = bufsize;
    g.port = port;
    g.tries = tries;
    g.timeoutSeconds = timeoutSeconds;
    g.trace = trace;
    g.typedArguments = args.join(' ');
    if (globalReverse && isIpLiteral(g.domain)) {
      g.reverse = true;
      g.qtype = 'PTR';
    }
    if (g.qtype === 'AXFR' || g.qtype === 'IXFR') g.tcp = true;
  }
  return groups;
}

function optionValue(arg: string): string | null {
  const separator = arg.indexOf('=');
  return separator === -1 ? null : arg.slice(separator + 1);
}

function digPort(invocation: DigInvocation): number {
  return invocation.port ?? (invocation.https !== null ? (invocation.https.plain ? 80 : 443) : invocation.tls ? 853 : 53);
}

function commandLines(invocation: DigInvocation): string[] {
  if (!invocation.display.cmd) return [];
  return [
    '',
    `; <<>> DiG ${bindVersion()} <<>> ${invocation.typedArguments}`,
    ...(invocation.serverGiven ? ['; (1 server found)'] : []),
    ';; global options: +cmd',
  ];
}

function digDate(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const day = date.toUTCString().slice(0, 3);
  const month = date.toUTCString().slice(8, 11);
  return `${day} ${month} ${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC ${date.getUTCFullYear()}`;
}

/** The one diagnostic dig writes to stderr when no server answered. */
export const DIG_NO_SERVERS = ';; no servers could be reached';

/**
 * What a terminal shows when nothing answered. `+short` suppresses the
 * banner and every comment line from stdout, but the diagnostic is a
 * stderr line: a tty still displays it, `2>/dev/null` or a capture does
 * not. `digStreams()` is what separates the two for callers that care.
 */
function noServersLine(invocation: DigInvocation, communications: readonly string[] = []): string {
  const banner = commandLines({ ...invocation, display: { ...invocation.display, cmd: true } });
  return [...communications, ...banner, DIG_NO_SERVERS].join('\n');
}

function shortOutput(answers: readonly ResourceRecord<ResourceRecordData>[]): string {
  return answers.filter(isDisplayableRecord).map(formatRdata).join('\n');
}

function transferOutput(invocation: DigInvocation, message: DnsMessage, elapsedMs: number): string {
  const lines: string[] = commandLines(invocation);
  const records = message.answers.filter(isDisplayableRecord);
  if (message.flags.rcode !== DnsRcode.NOERROR || records.length === 0) {
    lines.push('; Transfer failed.');
    return lines.join('\n');
  }
  for (const rr of records) lines.push(formatRecordLine(rr));
  lines.push(`;; Query time: ${Math.round(elapsedMs)} msec`);
  lines.push(serverLine(invocation));
  lines.push(`;; WHEN: ${digDate(simulationDate())}`);
  lines.push(`;; XFR size: ${records.length} records (messages 1, bytes ${encodeDnsMessage(message).length})`);
  return lines.join('\n');
}

function pushSection(
  lines: string[],
  display: DigDisplay,
  title: string,
  shown: boolean,
  records: readonly ResourceRecord<ResourceRecordData>[],
): void {
  const displayable = records.filter(isDisplayableRecord);
  if (!shown || displayable.length === 0) return;
  if (display.comments) lines.push(`;; ${title} SECTION:`);
  for (const rr of displayable) lines.push(formatRecordLine(rr));
  if (display.comments) lines.push('');
}

function transportName(invocation: DigInvocation): string {
  if (invocation.https !== null) {
    const base = invocation.https.plain ? 'HTTP' : 'HTTPS';
    return invocation.https.method === 'GET' ? `${base}-GET` : base;
  }
  return invocation.tls ? 'TLS' : invocation.tcp ? 'TCP' : 'UDP';
}

function serverLine(invocation: DigInvocation): string {
  return `;; SERVER: ${invocation.server}#${digPort(invocation)}(${invocation.server}) (${transportName(invocation)})`;
}

function fullOutput(invocation: DigInvocation, message: DnsMessage, elapsedMs: number): string {
  const { display } = invocation;
  const lines: string[] = commandLines(invocation);
  if (display.comments) {
    lines.push(
      ';; Got answer:',
      `;; ->>HEADER<<- opcode: QUERY, status: ${rcodeFromWire(message.flags.rcode)}, id: ${message.id}`,
      `;; flags: ${headerFlags(message)}; QUERY: ${message.questions.length}, ` +
        `ANSWER: ${message.answers.length}, AUTHORITY: ${message.authorities.length}, ` +
        `ADDITIONAL: ${message.additionals.length}`,
    );
    if (invocation.recurse && !message.flags.ra) {
      lines.push(';; WARNING: recursion requested but not available');
    }
    lines.push('');
    const opt = findOpt(message);
    if (opt) {
      const doFlag = opt.data.dnssecOk ? 'flags: do;' : 'flags:;';
      lines.push(';; OPT PSEUDOSECTION:', `; EDNS: version: ${opt.data.version}, ${doFlag} udp: ${opt.data.udpPayloadSize}`);
    }
  }
  if (display.question) {
    if (display.comments) lines.push(';; QUESTION SECTION:');
    for (const question of message.questions) lines.push(formatQuestionLine(question.qname, question.qclass, question.qtype));
    if (display.comments) lines.push('');
  }
  pushSection(lines, display, 'ANSWER', display.answer, message.answers);
  pushSection(lines, display, 'AUTHORITY', display.authority, message.authorities);
  pushSection(lines, display, 'ADDITIONAL', display.additional, message.additionals);
  if (display.stats) {
    lines.push(
      `;; Query time: ${Math.round(elapsedMs)} msec`,
      serverLine(invocation),
      `;; WHEN: ${digDate(simulationDate())}`,
      `;; MSG SIZE  rcvd: ${encodeDnsMessage(message).length}`,
      '',
    );
  }
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

  const response = await query(referenceServer, nsName, 'A', timeoutMs, { recursionDesired: true });
  const a = response?.answers.find((rr): rr is ResourceRecord<ARecordData> => rr.data.type === RRType.A);
  return a ? a.data.address.toString() : null;
}

/** Prints one `+trace` hop (the delegation or final answer received from one server) dig-trace style. */
function pushTraceHop(
  lines: string[], server: string, port: number, message: DnsMessage, elapsedMs: number,
): void {
  const records = (message.answers.length > 0 ? message.answers : message.authorities).filter(isDisplayableRecord);
  for (const rr of records) lines.push(formatRecordLine(rr));
  for (const rr of message.additionals.filter(isDisplayableRecord)) lines.push(formatRecordLine(rr));
  lines.push(
    `;; Received ${encodeDnsMessage(message).length} bytes from ${server}#${port}(${server}) in ` +
      `${Math.round(elapsedMs)} ms`,
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
  const lines: string[] = commandLines(invocation);
  const timeoutMs = invocation.timeoutSeconds * 1000;
  const port = invocation.port ?? 53;
  let server = invocation.server;

  const rootStartedAt = PathClock.now();
  const rootMessage = await query(server, '.', 'NS', timeoutMs, { recursionDesired: false, port: invocation.port });
  const rootElapsedMs = PathClock.now() - rootStartedAt;
  let nsRecords: ResourceRecord<NsRecordData>[] = [];
  let glue: readonly ResourceRecord<ResourceRecordData>[] = [];
  if (rootMessage && (rootMessage.answers.length > 0 || rootMessage.authorities.length > 0)) {
    pushTraceHop(lines, server, port, rootMessage, rootElapsedMs);
    nsRecords = [...rootMessage.answers, ...rootMessage.authorities]
      .filter((rr): rr is ResourceRecord<NsRecordData> => rr.data.type === RRType.NS);
    glue = rootMessage.additionals;
  }

  for (let hop = 0; hop < MAX_TRACE_HOPS; hop++) {
    if (nsRecords.length > 0) {
      let nextServer: string | null = null;
      for (const ns of nsRecords) {
        nextServer = await resolveNsAddress(ns.data.nsdname, glue, invocation.server, query, timeoutMs);
        if (nextServer) break;
      }
      if (!nextServer) {
        lines.push(';; connection timed out; no servers could be reached');
        return lines.join('\n');
      }
      server = nextServer;
    }

    const hopStartedAt = PathClock.now();
    const message = await query(
      server, invocation.domain, invocation.qtype, timeoutMs,
      { recursionDesired: false, port: invocation.port ?? undefined },
    );
    const hopElapsedMs = PathClock.now() - hopStartedAt;
    if (!message) {
      lines.push(';; connection timed out; no servers could be reached');
      return lines.join('\n');
    }
    pushTraceHop(lines, server, port, message, hopElapsedMs);

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

const STREAM_FAILURE_TEXT: Readonly<Record<'refused' | 'alpn' | 'tls', string>> = {
  refused: 'connection refused',
  alpn: 'ALPN for HTTP/2 failed',
  tls: 'TLS error',
};

interface Exchange {
  readonly bareFailure: boolean;
  readonly message: DnsMessage | null;
  readonly startedAt: number;
  readonly communications: readonly string[];
  readonly retriedOverTcp: boolean;
  readonly tlsFailure: string | null;
}

async function exchangeWith(invocation: DigInvocation, query: DnsQueryFn, options: DnsQueryOptions): Promise<Exchange> {
  let message: DnsMessage | null = null;
  let startedAt = PathClock.now();
  const communications: string[] = [];
  let refused = false;
  let answeredWithError = false;
  let bareFailure = false;
  let tlsFailure: string | null = null;
  const attemptOptions: DnsQueryOptions = {
    ...options,
    onTransportFailure: () => {
      refused = true;
      communications.push(`;; communications error to ${invocation.server}#${digPort(invocation)}: connection refused`);
    },
    onTlsVerifyFailure: (text) => { tlsFailure = text; },
    onStreamFailure: (failure) => {
      answeredWithError = true;
      const where = `${invocation.server}#${digPort(invocation)}`;
      if (failure === 'eof') {
        communications.push(`;; communications error to ${where}: end of file`);
        return;
      }
      bareFailure = true;
      communications.push(
        `;; Connection to ${where}(${invocation.server}) for ${invocation.domain} failed: ${STREAM_FAILURE_TEXT[failure]}.`,
        DIG_NO_SERVERS,
      );
    },
    onHttpFailure: () => {
      answeredWithError = true;
      communications.push(`;; communications error to ${invocation.server}#${digPort(invocation)}: failure`);
    },
  };
  for (let attempt = 0; attempt < Math.max(1, invocation.tries); attempt++) {
    startedAt = PathClock.now();
    refused = false;
    answeredWithError = false;
    message = await query(
      invocation.server, invocation.domain, invocation.qtype,
      invocation.timeoutSeconds * 1000, attemptOptions,
    );
    if (message || tlsFailure !== null) break;
    if (!refused && !answeredWithError) communications.push(`;; communications error to ${invocation.server}#${digPort(invocation)}: timed out`);
  }
  if (!message) return { message, startedAt, communications, retriedOverTcp: false, tlsFailure, bareFailure };

  let retriedOverTcp = false;
  if (message.flags.tc && !options.tcp && !options.tls && !options.https && !invocation.ignoreTruncation) {
    const tcpMessage = await query(
      invocation.server, invocation.domain, invocation.qtype,
      invocation.timeoutSeconds * 1000, { ...options, tcp: true },
    );
    if (tcpMessage) {
      message = tcpMessage;
      retriedOverTcp = true;
    }
  }
  return { message, startedAt, communications, retriedOverTcp, tlsFailure, bareFailure };
}

async function executeSingleQuery(
  invocation: DigInvocation, query: DnsQueryFn, searchList: ResolvConfOptions, tls: DigTlsContext,
): Promise<string> {
  if (!invocation.server || !isIpLiteral(invocation.server)) {
    return noServersLine(invocation);
  }

  if (invocation.trace) {
    return traceOutput(invocation, query);
  }

  if ((invocation.tlsCertFile === null) !== (invocation.tlsKeyFile === null)) return TLS_IDENTITY_INCOMPLETE;
  const authentication = tlsAuthentication(invocation, tls);
  if (authentication === 'context') return TLS_CONTEXT_FAILURE;
  const identity = tlsClientIdentity(invocation, tls);
  if (identity === 'context') return TLS_CONTEXT_FAILURE;

  const options: DnsQueryOptions = {
    recursionDesired: invocation.recurse,
    tcp: invocation.tcp,
    tls: invocation.tls && invocation.https === null,
    ...(invocation.https === null ? {} : { https: invocation.https }),
    ...(authentication === null ? { tlsVerify: false } : { tlsVerify: true, tlsAnchors: authentication.anchors, serverName: authentication.serverName }),
    ...(identity === null ? {} : { tlsClientIdentity: identity }),
    dnssecOk: invocation.dnssec,
    udpPayloadSize: invocation.bufsize ?? (invocation.dnssec ? 4096 : invocation.noEdns ? undefined : DEFAULT_EDNS_BUFFER),
    port: invocation.port ?? undefined,
    qclass: invocation.qclass,
  };
  const candidates = invocation.search ? searchCandidates(invocation.domain, searchList.search, searchList.ndots) : [invocation.domain];
  let asked = { ...invocation, domain: candidates[0] };
  let exchange = await exchangeWith(asked, query, options);
  for (let index = 1; index < candidates.length && exchange.message !== null && exchange.message.flags.rcode === DnsRcode.NXDOMAIN; index++) {
    asked = { ...invocation, domain: candidates[index] };
    exchange = await exchangeWith(asked, query, options);
  }
  const { startedAt, retriedOverTcp } = exchange;
  const message = exchange.message;
  if (!message && exchange.tlsFailure !== null) {
    return `;; TLS peer certificate verification for ${asked.server}#${digPort(asked)} failed: ${exchange.tlsFailure}`;
  }
  if (!message && exchange.bareFailure) return exchange.communications.join('\n');
  if (!message) return noServersLine(asked, exchange.communications);
  if (asked.qtype === 'AXFR' || asked.qtype === 'IXFR') {
    return transferOutput(asked, message, PathClock.now() - startedAt);
  }
  if (asked.short) return asked.display.answer ? shortOutput(message.answers) : '';
  const printed = fullOutput(retriedOverTcp ? { ...asked, tcp: true } : asked, message, PathClock.now() - startedAt);
  return retriedOverTcp && asked.display.comments ? `;; Truncated, retrying in TCP mode.\n${printed}` : printed;
}

export interface DigTlsContext {
  readonly readFile?: (path: string) => string | null;
  readonly systemAnchors?: () => readonly X509Certificate[];
}

const TLS_CONTEXT_FAILURE = ';; TLS context cannot be created';
const TLS_IDENTITY_INCOMPLETE = ';; both TLS client certificate and key file must be specified a the same time';

function tlsClientIdentity(invocation: DigInvocation, tls: DigTlsContext): NonNullable<DnsQueryOptions['tlsClientIdentity']> | 'context' | null {
  const secure = invocation.tls || invocation.https !== null;
  if (!secure || invocation.tlsCertFile === null || invocation.tlsKeyFile === null) return null;
  const certificates = pemToCertChain(tls.readFile?.(invocation.tlsCertFile) ?? '');
  const key = pemToPrivateKey(tls.readFile?.(invocation.tlsKeyFile) ?? '');
  if (certificates.length === 0 || key === null || !privateKeyPairsWith(certificates[0].publicKey, key)) return 'context';
  return { certificate: certificates[0], chain: certificates.slice(1), privateKey: key };
}

function tlsAuthentication(
  invocation: DigInvocation, tls: DigTlsContext,
): { anchors: readonly X509Certificate[]; serverName: string } | 'context' | null {
  const secure = invocation.tls || invocation.https !== null;
  if (!secure || (invocation.tlsCa === null && invocation.tlsHostname === null && invocation.tlsCertFile === null)) return null;
  const file = invocation.tlsCa?.file ?? null;
  let anchors: readonly X509Certificate[];
  if (file === null) {
    anchors = tls.systemAnchors?.() ?? [];
  } else {
    const text = tls.readFile?.(file) ?? null;
    anchors = text === null ? [] : pemToCertChain(text);
    if (anchors.length === 0) return 'context';
  }
  return { anchors, serverName: invocation.tlsHostname ?? invocation.server };
}

/** Reads a `dig -f <file>` batch file: one query per non-empty, non-comment line. */
function batchLines(content: string): string[] {
  return content.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(';'));
}

export async function executeDig(
  args: string[],
  query: DnsQueryFn,
  resolverIP?: string,
  readFile?: (path: string) => string | null,
  systemAnchors?: () => readonly X509Certificate[],
): Promise<string> {
  const fIndex = args.findIndex((a) => a === '-f');
  if (fIndex !== -1 && args[fIndex + 1] !== undefined) {
    const path = args[fIndex + 1];
    if (!readFile) return `dig: batch mode (-f) is not supported here`;
    const content = readFile(path);
    if (content === null) return `dig: couldn't open ${path}: No such file or directory`;

    const globalArgs = [...args.slice(0, fIndex), ...args.slice(fIndex + 2)];
    const outputs: string[] = [];
    for (const line of batchLines(content)) {
      outputs.push(await executeDig([...globalArgs, ...line.split(/\s+/)], query, resolverIP, readFile, systemAnchors));
    }
    return outputs.join('\n');
  }

  const invocations = parseDigInvocations(args, resolverIP);
  const searchList = parseResolvConf(readFile?.('/etc/resolv.conf') ?? '');
  const outputs: string[] = [];
  for (const invocation of invocations) {
    outputs.push(await executeSingleQuery(invocation, query, searchList, { readFile, systemAnchors }));
  }
  return outputs.join('\n');
}
