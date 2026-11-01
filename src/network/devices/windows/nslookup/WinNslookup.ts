import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import {
  buildLegacyQueryMessage, isIpLiteral, ptrQName, rrTypeFromName,
  type DnsQueryFn, type DnsQueryOptions,
} from '@/network/dns/compat/DnsWireCompat';
import type { NslookupInterpreter, NslookupReply } from '@/network/dns/tools/NslookupInterpreter';
import { PortNumber } from '@/network/core/ports/PortNumber';
import {
  addressBlockLines, bareName, debugPacketLines, renderRecords,
  type AddressBlock, type NslookupRecord,
} from './WinNslookupFormat';

export interface WinNslookupEnvironment {
  readonly query: DnsQueryFn;
  readonly defaultServer: () => string;
  readonly primarySuffix: () => string;
  readonly searchList: () => readonly string[];
}

const FLAG_NAMES = ['debug', 'd2', 'defname', 'search', 'recurse', 'vc', 'ignoretc', 'msxfr'] as const;
type FlagName = (typeof FLAG_NAMES)[number];

const QUERY_CLASSES: ReadonlyMap<string, number> = new Map([
  ['IN', DnsClass.IN], ['CHAOS', DnsClass.CH], ['CH', DnsClass.CH],
  ['HESIOD', DnsClass.HS], ['HS', DnsClass.HS], ['ANY', DnsClass.ANY],
]);

const CLASS_LABELS: ReadonlyMap<number, string> = new Map([
  [DnsClass.IN, 'IN'], [DnsClass.CH, 'CHAOS'], [DnsClass.HS, 'HESIOD'], [DnsClass.ANY, 'ANY'],
]);

const ADDRESS_TYPES_LABEL = 'A+AAAA';
const ADDRESS_TYPES: readonly string[] = ['AAAA', 'A'];
const DEFAULT_TIMEOUT_SECONDS = 2;
const DEFAULT_RETRIES = 1;
const DEFAULT_ROOT = 'A.ROOT-SERVERS.NET.';
const UNKNOWN_SERVER = 'UnKnown';
const LOOPBACK_V6 = '::1';
const DNS_PORT = PortNumber.of(53);

const HELP_LINES = [
  'Commands:   (identifiers are shown in uppercase, [] means optional)',
  'NAME            - print info about the host/domain NAME using default server',
  'NAME1 NAME2     - as above, but use NAME2 as server',
  'help or ?       - print info on common commands',
  'set OPTION      - set an option',
  '    all                 - print options, current server and host',
  '    [no]debug           - print debugging information',
  '    [no]d2              - print exhaustive debugging information',
  '    [no]defname         - append domain name to each query',
  '    [no]recurse         - ask for recursive answer to query',
  '    [no]search          - use domain search list',
  '    [no]vc              - always use a virtual circuit',
  '    domain=NAME         - set default domain name to NAME',
  '    srchlist=N1[/N2/.../N6] - set domain to N1 and search list to N1,N2, etc.',
  '    root=NAME           - set root server to NAME',
  '    retry=X             - set number of retries to X',
  '    timeout=X           - set initial time-out interval to X seconds',
  '    type=X              - set query type (ex. A,AAAA,A+AAAA,ANY,CNAME,MX,',
  '                          NS,PTR,SOA,SRV)',
  '    querytype=X         - same as type',
  '    class=X             - set query class (ex. IN (Internet), ANY)',
  '    [no]msxfr           - use MS fast zone transfer',
  '    ixfrver=X           - current version to use in IXFR transfer request',
  'server NAME     - set default server to NAME, using current default server',
  'lserver NAME    - set default server to NAME, using initial server',
  'root            - set current default server to the root',
  'exit            - exit the program',
];

interface Settings {
  flags: Record<FlagName, boolean>;
  port: PortNumber;
  types: readonly string[];
  typeLabel: string;
  queryClass: number;
  timeoutSeconds: number;
  retries: number;
  root: string;
  domain: string;
  searchList: readonly string[];
  ixfrVersion: number;
}

type Exchange =
  | { readonly kind: 'message'; readonly message: DnsMessage }
  | { readonly kind: 'failure'; readonly reason: 'timeout' | 'refused' };

type Ask =
  | { readonly kind: 'messages'; readonly name: string; readonly messages: readonly DnsMessage[] }
  | { readonly kind: 'failure'; readonly reason: 'timeout' | 'refused' };

function notOpt(record: NslookupRecord): boolean {
  return record.data.type !== RRType.OPT;
}

function rcodeText(rcode: number): string {
  switch (rcode) {
    case DnsRcode.NXDOMAIN: return 'Non-existent domain';
    case DnsRcode.SERVFAIL: return 'Server failed';
    case DnsRcode.REFUSED: return 'Query refused';
    case DnsRcode.FORMERR: return 'Format error';
    case DnsRcode.NOTIMP: return 'Not implemented';
    default: return 'Unspecified error';
  }
}

function parentsOf(domain: string): string[] {
  const labels = domain.split('.').filter((label) => label !== '');
  const list: string[] = [];
  for (let start = 0; labels.length - start >= 2; start++) list.push(labels.slice(start).join('.'));
  return list;
}

export class WinNslookup implements NslookupInterpreter {
  private server: string;
  private serverLabel: string | null = null;
  private readonly initialServer: string;
  private readonly settings: Settings;

  constructor(private readonly environment: WinNslookupEnvironment) {
    this.initialServer = environment.defaultServer();
    this.server = this.initialServer;
    const searchList = environment.searchList();
    const domain = environment.primarySuffix() || searchList[0] || '';
    this.settings = {
      flags: { debug: false, d2: false, defname: true, search: true, recurse: true, vc: false, ignoretc: false, msxfr: true },
      port: DNS_PORT,
      types: ADDRESS_TYPES,
      typeLabel: ADDRESS_TYPES_LABEL,
      queryClass: DnsClass.IN,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      retries: DEFAULT_RETRIES,
      root: DEFAULT_ROOT,
      domain,
      searchList,
      ixfrVersion: 1,
    };
  }

  async bannerLines(): Promise<string[]> {
    return this.serverBlock('Default Server');
  }

  async runCommandLine(args: readonly string[]): Promise<string> {
    const out: string[] = [];
    const positional: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg.length > 1) {
        const problem = this.applyOption(arg.slice(1));
        if (problem !== null) out.push(problem);
      } else {
        positional.push(arg);
      }
    }
    const [target, serverSpec] = positional;
    if (serverSpec !== undefined && !(await this.switchServer(serverSpec, true, out))) return out.join('\n');
    if (target === undefined || target === '-') {
      out.push(...(await this.serverBlock('Default Server')), '> ');
      return out.join('\n');
    }
    out.push(...(await this.serverBlock('Server')));
    await this.lookup(target, out);
    return out.join('\n');
  }

  async interpret(line: string): Promise<NslookupReply> {
    const text = line.trim();
    if (text === '') return { lines: [], exit: false };
    const [first, ...rest] = text.split(/\s+/);
    const word = first.toLowerCase();
    const out: string[] = [];
    if (word === 'exit') return { lines: [], exit: true };
    if (word === 'help' || word === '?') return { lines: [...HELP_LINES], exit: false };
    if (word === 'set') {
      for (const option of rest) {
        if (option.toLowerCase() === 'all') out.push(...(await this.optionLines()));
        else {
          const problem = this.applyOption(option);
          if (problem !== null) out.push(problem);
        }
      }
      return { lines: out, exit: false };
    }
    if (word === 'server' || word === 'lserver') {
      if (rest[0] === undefined) return { lines: [`*** Invalid option: ${text}`], exit: false };
      if (await this.switchServer(rest[0], word === 'lserver', out)) out.push(...(await this.serverBlock('Default Server')));
      return { lines: out, exit: false };
    }
    if (word === 'root') {
      if (await this.switchServer(this.settings.root, true, out)) out.push(...(await this.serverBlock('Default Server')));
      return { lines: out, exit: false };
    }
    const name = first.startsWith('\\') ? first.slice(1) : first;
    const kept = { server: this.server, label: this.serverLabel };
    if (rest[0] !== undefined && !(await this.switchServer(rest[0], false, out))) return { lines: out, exit: false };
    out.push(...(await this.serverBlock('Server')));
    await this.lookup(name, out);
    this.server = kept.server;
    this.serverLabel = kept.label;
    return { lines: out, exit: false };
  }

  private async serverBlock(title: string): Promise<string[]> {
    const lines: string[] = [];
    const label = await this.labelOfServer(lines);
    lines.push(`${title}:  ${label}`, `Address:  ${this.server === '' ? LOOPBACK_V6 : this.server}`, '');
    return lines;
  }

  private async labelOfServer(out: string[]): Promise<string> {
    if (this.serverLabel !== null) return this.serverLabel;
    let label = UNKNOWN_SERVER;
    if (this.server !== '') {
      const exchange = await this.exchange(ptrQName(this.server), 'PTR', 1, out);
      if (exchange.kind === 'message') {
        const pointer = exchange.message.answers.find((record) => record.data.type === RRType.PTR);
        if (pointer !== undefined && pointer.data.type === RRType.PTR) label = bareName(pointer.data.ptrdname);
      }
    }
    this.serverLabel = label;
    return label;
  }

  private async exchange(name: string, type: string, attempts: number, out: string[]): Promise<Exchange> {
    const settings = this.settings;
    if (this.server === '') return { kind: 'failure', reason: 'refused' };
    for (let attempt = 0; attempt < attempts; attempt++) {
      let refused = false;
      const options: DnsQueryOptions = {
        recursionDesired: settings.flags.recurse,
        tcp: settings.flags.vc,
        port: settings.port.value,
        qclass: settings.queryClass,
        onTransportFailure: () => { refused = true; },
      };
      if (settings.flags.d2) this.dumpQuery(name, type, options, out);
      const message = await this.environment.query(this.server, name, type, settings.timeoutSeconds * 1000, options);
      if (message !== null) {
        this.dumpAnswer(message, out);
        return { kind: 'message', message };
      }
      if (refused) return { kind: 'failure', reason: 'refused' };
      out.push('DNS request timed out.', `    timeout was ${settings.timeoutSeconds} seconds.`);
    }
    return { kind: 'failure', reason: 'timeout' };
  }

  private dumpQuery(name: string, type: string, options: DnsQueryOptions, out: string[]): void {
    const query = buildLegacyQueryMessage(0, name, type, options);
    if (query === null) return;
    out.push('------------', `SendRequest(), len ${encodeDnsMessage(query).length}`, ...debugPacketLines(query), '------------');
  }

  private dumpAnswer(message: DnsMessage, out: string[]): void {
    if (!this.settings.flags.debug) return;
    const heading = this.settings.flags.d2 ? `Got answer (${encodeDnsMessage(message).length} bytes):` : 'Got answer:';
    out.push('------------', heading, ...debugPacketLines(message), '------------');
  }

  private candidates(typed: string): string[] {
    const { flags, searchList } = this.settings;
    if (typed.endsWith('.')) return [typed];
    const expanded = searchList.map((suffix) => `${typed}.${suffix}`);
    if (!typed.includes('.')) return flags.defname ? [...expanded, typed] : [typed];
    return flags.search ? [typed, ...expanded] : [typed];
  }

  private async ask(name: string, types: readonly string[], out: string[]): Promise<Ask> {
    const messages: DnsMessage[] = [];
    for (const type of types) {
      const exchange = await this.exchange(name, type, this.settings.retries + 1, out);
      if (exchange.kind === 'failure') return exchange;
      messages.push(exchange.message);
    }
    return { kind: 'messages', name, messages };
  }

  private async lookup(typed: string, out: string[]): Promise<void> {
    const label = await this.labelOfServer(out);
    const addressLike = this.settings.types.every((type) => type === 'A' || type === 'AAAA' || type === 'PTR');
    if (isIpLiteral(typed) && addressLike) {
      const ask = await this.ask(ptrQName(typed), ['PTR'], out);
      this.render(typed, typed, ask, label, out);
      return;
    }
    let last: Ask | null = null;
    for (const candidate of this.candidates(typed)) {
      const ask = await this.ask(candidate, this.settings.types, out);
      last = ask;
      if (ask.kind === 'failure' || this.carriesData(ask)) break;
    }
    if (last !== null) this.render(typed, null, last, label, out);
  }

  private carriesData(ask: Ask): boolean {
    return ask.kind === 'messages' && ask.messages.some((message) => message.answers.some(notOpt));
  }

  private render(typed: string, reverseOf: string | null, ask: Ask, label: string, out: string[]): void {
    if (ask.kind === 'failure') {
      out.push(ask.reason === 'timeout'
        ? `*** Request to ${label} timed-out`
        : `*** ${label} can't find ${typed}: No response from server`);
      return;
    }
    const answers = ask.messages.flatMap((message) => message.answers).filter(notOpt);
    const answered = ask.messages.find((message) => message.answers.some(notOpt)) ?? ask.messages[0];
    if (answers.length === 0) {
      this.renderNegative(typed, ask.messages, label, out);
      return;
    }
    if (!answered.flags.aa) out.push('Non-authoritative answer:');
    const block = reverseOf !== null ? this.pointerBlock(reverseOf, answers) : this.addressBlock(ask.name, answers);
    if (block !== null && (reverseOf !== null || this.settings.types.every((type) => type === 'A' || type === 'AAAA'))) {
      out.push(...addressBlockLines(block), '');
      return;
    }
    out.push(...renderRecords(answers));
    const extra = ask.messages.flatMap((message) => [...message.authorities, ...message.additionals]).filter(notOpt);
    if (extra.length > 0) out.push('', ...renderRecords(extra));
    out.push('');
  }

  private renderNegative(typed: string, messages: readonly DnsMessage[], label: string, out: string[]): void {
    const refusing = messages.find((message) => message.flags.rcode !== DnsRcode.NOERROR && message.flags.rcode !== DnsRcode.NXDOMAIN);
    const missing = messages.every((message) => message.flags.rcode === DnsRcode.NXDOMAIN);
    if (missing) {
      out.push(`*** ${label} can't find ${typed}: ${rcodeText(DnsRcode.NXDOMAIN)}`);
      return;
    }
    if (refusing !== undefined) {
      out.push(`*** ${label} can't find ${typed}: ${rcodeText(refusing.flags.rcode)}`);
      return;
    }
    const authority = messages.flatMap((message) => message.authorities).filter(notOpt);
    if (authority.length === 0) {
      out.push(`*** ${label} can't find ${typed}: No records`);
      return;
    }
    out.push(...renderRecords(authority), '');
  }

  private pointerBlock(address: string, answers: readonly NslookupRecord[]): AddressBlock | null {
    const pointer = answers.find((record) => record.data.type === RRType.PTR);
    if (pointer === undefined || pointer.data.type !== RRType.PTR) return null;
    return { name: pointer.data.ptrdname, addresses: [address], aliases: [] };
  }

  private addressBlock(startName: string, answers: readonly NslookupRecord[]): AddressBlock | null {
    const targets = new Map<string, string>();
    for (const record of answers) {
      if (record.data.type === RRType.CNAME) targets.set(bareName(record.name).toLowerCase(), bareName(record.data.cname));
    }
    const aliases: string[] = [];
    let current = bareName(startName);
    const visited = new Set<string>();
    while (targets.has(current.toLowerCase()) && !visited.has(current.toLowerCase())) {
      visited.add(current.toLowerCase());
      aliases.push(current);
      current = targets.get(current.toLowerCase()) as string;
    }
    const owned = answers.filter((record) => (record.data.type === RRType.A || record.data.type === RRType.AAAA)
      && bareName(record.name).toLowerCase() === current.toLowerCase());
    const addresses = [
      ...owned.filter((record) => record.data.type === RRType.AAAA),
      ...owned.filter((record) => record.data.type === RRType.A),
    ].map((record) => (record.data as { address: { toString(): string } }).address.toString());
    return addresses.length === 0 ? null : { name: current, addresses, aliases };
  }

  private async switchServer(spec: string, viaInitial: boolean, out: string[]): Promise<boolean> {
    if (isIpLiteral(spec)) {
      this.useServer(spec);
      return true;
    }
    const previous = this.server;
    if (viaInitial) this.server = this.initialServer;
    this.serverLabel = null;
    let address: string | null = null;
    let failure = rcodeText(DnsRcode.NXDOMAIN);
    for (const candidate of this.candidates(spec)) {
      const ask = await this.ask(candidate, ['A'], out);
      if (ask.kind === 'failure') {
        failure = ask.reason === 'timeout' ? 'Timed out' : 'No response from server';
        break;
      }
      const record = ask.messages.flatMap((message) => message.answers).find((answer) => answer.data.type === RRType.A);
      if (record !== undefined && record.data.type === RRType.A) {
        address = record.data.address.toString();
        break;
      }
      const code = ask.messages[0].flags.rcode;
      failure = code === DnsRcode.NOERROR ? 'No records' : rcodeText(code);
    }
    if (address === null) {
      this.server = previous;
      this.serverLabel = null;
      out.push(`*** Can't find address for server ${spec}: ${failure}`);
      return false;
    }
    this.useServer(address);
    return true;
  }

  private useServer(address: string): void {
    this.server = address;
    this.serverLabel = null;
  }

  private applyOption(spec: string): string | null {
    const equals = spec.indexOf('=');
    const key = (equals === -1 ? spec : spec.slice(0, equals)).toLowerCase();
    const value = equals === -1 ? null : spec.slice(equals + 1);
    if (value === null) return this.applyFlag(key, spec);
    return this.applyValue(key, value, spec);
  }

  private applyFlag(key: string, spec: string): string | null {
    const negative = key.startsWith('no');
    const name = (negative ? key.slice(2) : key) as FlagName;
    if (!(FLAG_NAMES as readonly string[]).includes(name)) return `*** Invalid option: ${spec}`;
    const flags = this.settings.flags;
    flags[name] = !negative;
    if (name === 'd2' && !negative) flags.debug = true;
    if (name === 'debug' && negative) flags.d2 = false;
    return null;
  }

  private applyValue(key: string, value: string, spec: string): string | null {
    const invalid = `*** Invalid option: ${spec}`;
    const settings = this.settings;
    switch (key) {
      case 'type':
      case 'querytype':
      case 'q': {
        const upper = value.toUpperCase();
        if (upper === ADDRESS_TYPES_LABEL) {
          settings.types = ADDRESS_TYPES;
          settings.typeLabel = ADDRESS_TYPES_LABEL;
          return null;
        }
        if (rrTypeFromName(upper) === null) return invalid;
        settings.types = [upper];
        settings.typeLabel = upper;
        return null;
      }
      case 'class': {
        const code = QUERY_CLASSES.get(value.toUpperCase());
        if (code === undefined) return invalid;
        settings.queryClass = code;
        return null;
      }
      case 'timeout':
      case 'retry':
      case 'ixfrver':
      case 'ixfrversion': {
        if (!/^\d+$/.test(value)) return invalid;
        const count = Number(value);
        if (key === 'timeout') settings.timeoutSeconds = count;
        else if (key === 'retry') settings.retries = count;
        else settings.ixfrVersion = count;
        return null;
      }
      case 'port': {
        const port = PortNumber.tryParse(value);
        if (port === null) return invalid;
        settings.port = port;
        return null;
      }
      case 'domain':
        settings.domain = value;
        settings.searchList = parentsOf(value);
        return null;
      case 'srchlist': {
        const names = value.split('/').filter((name) => name !== '');
        settings.domain = names[0] ?? settings.domain;
        settings.searchList = names;
        return null;
      }
      case 'root':
        settings.root = value;
        return null;
      default:
        return invalid;
    }
  }

  private async optionLines(): Promise<string[]> {
    const { flags, port, typeLabel, queryClass, timeoutSeconds, retries, root, domain, searchList, ixfrVersion } = this.settings;
    const state = (flag: boolean, name: string): string => `  ${flag ? '' : 'no'}${name}`;
    return [
      ...(await this.serverBlock('Default Server')),
      'Set options:',
      state(flags.debug, 'debug'),
      state(flags.defname, 'defname'),
      state(flags.search, 'search'),
      state(flags.recurse, 'recurse'),
      state(flags.d2, 'd2'),
      state(flags.vc, 'vc'),
      state(flags.ignoretc, 'ignoretc'),
      `  port=${port.value}`,
      `  type=${typeLabel}`,
      `  class=${CLASS_LABELS.get(queryClass) ?? 'IN'}`,
      `  timeout=${timeoutSeconds}`,
      `  retry=${retries}`,
      `  root=${root}`,
      `  domain=${domain}`,
      state(flags.msxfr, 'MSxfr'),
      `  IXFRversion=${ixfrVersion}`,
      `  srchlist=${searchList.join('/')}`,
    ];
  }
}
