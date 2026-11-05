import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { NsRecordData, ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { isIPv4Literal, isIPv6Literal, rcodeText, rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import { parseResolvConf } from '../../../nss/ResolvConf';
import { emit, outputOf, type ToolOutput } from '../../../kerberos/Krb5ToolOutput';
import type { HostOptions } from './HostArguments';
import { countDots, formatDnsName, parseDnsNameText, reverseNameOf, type DnsNameText } from './HostNames';
import type { ExchangeFailure, ExchangeOutcome, HostPort } from './HostPort';
import { renderBody, type RenderedMessage, type TransferFilter } from './HostPrinter';

const DEFAULT_PORT = 53;
const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_NAME_WIRE_LENGTH = 255;
const MAX_SERVER_ADDRESSES = 8;
const MAX_NAMESERVERS = 20;
const RESOLV_CONF = '/etc/resolv.conf';
const BARE_SEARCH_LINE = /^\s*(search|domain)\s*$/m;
const IS_TRANSFER = (type: number): boolean => type === RRType.AXFR || type === RRType.IXFR;

interface ServerEntry {
  readonly address: string;
  readonly userArg: string;
}

interface Lookup {
  readonly textname: string;
  readonly rdtype: number;
  readonly rdclass: number;
  readonly originIndex: number | null;
  readonly needSearch: boolean;
  readonly doneAsIs: boolean;
  readonly newSearch: boolean;
  readonly retries: number;
  readonly tcp: boolean;
  readonly recurse: boolean;
  readonly nameserverSearch: boolean;
  readonly traceRoot: boolean;
  readonly servers: readonly ServerEntry[] | null;
}

interface Prepared {
  readonly lookup: Lookup;
  readonly queryName: string;
  readonly labels: readonly string[];
}

class HostExit extends Error {
  constructor(readonly status: number) {
    super('host exit');
  }
}

export class HostSession {
  private readonly out: ToolOutput = outputOf();
  private readonly queue: Lookup[] = [];
  private servers: ServerEntry[] = [];
  private search: string[] = [];
  private ndots = 1;
  private timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;
  private seenError = -1;
  private printedServer = false;
  private useSearch = false;
  private readonly checkRecursionAvailable: boolean;
  private readonly portNumber: number;

  constructor(private readonly options: HostOptions, private readonly port: HostPort) {
    this.checkRecursionAvailable = options.server === null;
    this.portNumber = options.port ?? DEFAULT_PORT;
  }

  private write(text: string): void {
    emit(this.out, 'stdout', text);
  }

  private warn(text: string): void {
    this.write(`;; ${text}\n`);
  }

  private fatal(message: string): never {
    emit(this.out, 'stderr', `host: ${message}\n`);
    throw new HostExit(this.options.fatalExit);
  }

  async run(): Promise<ToolOutput> {
    try {
      await this.configure();
      await this.drain();
      this.out.exitCode = this.seenError === 0 ? 0 : 1;
    } catch (error) {
      if (!(error instanceof HostExit)) throw error;
      this.out.exitCode = error.status;
    }
    return this.out;
  }

  private ipv4Allowed(): boolean {
    return !this.options.ipv6Only;
  }

  private ipv6Allowed(): boolean {
    return this.port.ipv6Available() && !this.options.ipv4Only;
  }

  private async configure(): Promise<void> {
    const text = this.port.resolvConf();
    if (text !== null && BARE_SEARCH_LINE.test(text)) {
      emit(this.out, 'stderr', `host: parse of ${RESOLV_CONF} failed\n`);
      throw new HostExit(1);
    }
    const configuration = parseResolvConf(text ?? '');
    this.search = configuration.search;
    this.ndots = this.options.ndots ?? configuration.ndots;
    const timeoutSeconds = this.options.timeoutSeconds ?? configuration.timeout ?? DEFAULT_TIMEOUT_SECONDS;
    this.timeoutMs = Math.min(MAX_TIMEOUT_MS, timeoutSeconds * 1000);
    this.servers = configuration.nameservers
      .filter((address) => (isIPv6Literal(address) ? this.ipv6Allowed() : isIPv4Literal(address) && this.ipv4Allowed()))
      .map((address) => ({ address, userArg: address }));
    if (this.servers.length === 0) {
      if (this.ipv6Allowed()) this.servers.push({ address: '::1', userArg: '::1' });
      if (this.ipv4Allowed()) this.servers.push({ address: '127.0.0.1', userArg: '127.0.0.1' });
    }
    if (this.options.server !== null) this.servers = await this.namedServers(this.options.server);
    this.queue.push(this.firstLookup());
  }

  private async addressesNamed(name: string): Promise<readonly string[] | null> {
    if (isIPv4Literal(name) || isIPv6Literal(name)) return [name];
    const found = await this.port.addressesOf(name);
    return found === null || found.length === 0 ? null : found.slice(0, MAX_SERVER_ADDRESSES);
  }

  private async namedServers(name: string): Promise<ServerEntry[]> {
    const addresses = await this.addressesNamed(name);
    const usable = (addresses ?? []).filter((address) => (isIPv6Literal(address) ? this.ipv6Allowed() : this.ipv4Allowed()));
    if (usable.length === 0) this.fatal(`couldn't get address for '${name}': not found`);
    return usable.map((address) => ({ address, userArg: name }));
  }

  private firstLookup(): Lookup {
    const reverse = reverseNameOf(this.options.hostname);
    const { options } = this;
    this.useSearch = reverse === null;
    return {
      textname: reverse ?? options.hostname,
      rdtype: reverse === null ? options.rdtype ?? RRType.A : RRType.PTR,
      rdclass: options.rdclass,
      originIndex: null,
      needSearch: false,
      doneAsIs: false,
      newSearch: true,
      retries: options.tries,
      tcp: options.tcp,
      recurse: options.recurse,
      nameserverSearch: options.nameserverSearch,
      traceRoot: options.nameserverSearch,
      servers: null,
    };
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const lookup = this.queue.shift() as Lookup;
      await this.process(lookup);
    }
  }

  private prepare(lookup: Lookup): Prepared | null {
    let current = lookup;
    if (current.newSearch) {
      if (countDots(current.textname) >= this.ndots || !this.useSearch) {
        current = { ...current, originIndex: null, doneAsIs: true, needSearch: this.useSearch };
      } else if (current.originIndex === null && this.useSearch) {
        current = { ...current, originIndex: this.search.length > 0 ? 0 : null, needSearch: false };
      }
    }
    const text = parseDnsNameText(current.textname);
    let labels: readonly string[];
    if (current.originIndex !== null) {
      const origin = parseDnsNameText(this.search[current.originIndex]);
      if ('error' in origin) this.fatal(`'${this.search[current.originIndex]}' is not in legal name syntax (${origin.error})`);
      if ('error' in text) this.fatal(`'${current.textname}' is not in legal name syntax (${text.error})`);
      labels = this.joined(text.name, origin.name);
      if (labels.reduce((total, label) => total + label.length + 1, 1) > MAX_NAME_WIRE_LENGTH) return null;
    } else {
      if ('error' in text) this.fatal(`'${current.textname}' is not a legal name (${text.error})`);
      labels = text.name.labels;
    }
    const queryName = formatDnsName(labels);
    if (this.options.verbose) this.write(`Trying "${queryName}"\n`);
    return { lookup: current, queryName, labels };
  }

  private joined(name: DnsNameText, origin: DnsNameText): readonly string[] {
    return name.absolute ? name.labels : [...name.labels, ...origin.labels];
  }

  private nextOrigin(lookup: Lookup): boolean {
    if (!this.useSearch) return false;
    const parsed = parseDnsNameText(lookup.textname);
    if ('name' in parsed && (parsed.name.absolute || parsed.name.labels.length > this.ndots)) return false;
    let next: Lookup;
    if (lookup.originIndex === null && !lookup.needSearch) return false;
    if (lookup.originIndex === null) {
      next = { ...lookup, originIndex: this.search.length > 0 ? 0 : null, needSearch: false };
    } else {
      const index = lookup.originIndex + 1;
      const following = index < this.search.length ? index : null;
      if (following === null && lookup.doneAsIs) return false;
      next = { ...lookup, originIndex: following };
    }
    this.queue.unshift({ ...next, newSearch: false });
    return true;
  }

  private noServers(): void {
    this.warn('no servers could be reached');
  }

  private socketText(address: string): string {
    return `${address}#${this.portNumber}`;
  }

  private failureText(lookup: Lookup, server: ServerEntry, failure: ExchangeFailure): void {
    if (failure.phase === 'setup') {
      this.warn(
        lookup.tcp || IS_TRANSFER(lookup.rdtype)
          ? `Connection to ${this.socketText(server.address)}(${server.userArg}) for ${lookup.textname} failed: ${failure.reason}.`
          : `UDP setup with ${this.socketText(server.address)}(${server.userArg}) for ${lookup.textname} failed: ${failure.reason}.`,
      );
    } else {
      this.warn(`communications error to ${this.socketText(server.address)}: ${failure.reason}`);
    }
  }

  private async attempt(prepared: Prepared, server: ServerEntry): Promise<ExchangeOutcome> {
    const { lookup } = prepared;
    return this.port.exchange({
      address: server.address,
      port: this.portNumber,
      name: wireNameOf(prepared.labels),
      type: lookup.rdtype,
      rrClass: lookup.rdclass,
      recurse: lookup.recurse && !(lookup.nameserverSearch && !lookup.traceRoot),
      tcp: lookup.tcp,
      timeoutMs: this.timeoutMs,
    });
  }

  private async process(initial: Lookup): Promise<void> {
    const prepared = this.prepare(initial);
    if (prepared === null) return;
    const { lookup } = prepared;
    const servers = lookup.servers ?? this.servers;
    if (lookup.nameserverSearch && !lookup.traceRoot) {
      await this.nameserverSearch(prepared, servers);
      return;
    }
    if (IS_TRANSFER(lookup.rdtype)) {
      await this.transfer(prepared, servers);
      return;
    }
    let retries = lookup.retries;
    let index = 0;
    for (;;) {
      const server = servers[index];
      const outcome = await this.attempt(prepared, server);
      if (outcome.outcome === 'failed') {
        this.failureText(lookup, server, outcome);
        if (outcome.phase === 'setup') {
          if (retries > 1) {
            this.queue.unshift({ ...lookup, retries: retries - 1, newSearch: false });
            this.noServers();
            return;
          }
        } else if (retries > 1) {
          if (lookup.tcp) {
            this.queue.unshift({ ...lookup, retries: retries - 1, newSearch: false });
            return;
          }
          retries -= 1;
          continue;
        }
        if (index + 1 < servers.length) {
          index += 1;
          continue;
        }
        this.noServers();
        return;
      }
      const { message } = outcome;
      if (message.flags.tc && !lookup.tcp) {
        this.queue.unshift({ ...lookup, tcp: true, newSearch: false });
        return;
      }
      const rcode = message.flags.rcode;
      const retryable = (rcode === DnsRcode.SERVFAIL && !this.options.servfailStops)
        || (this.checkRecursionAvailable && !message.flags.ra && lookup.recurse);
      if (retryable && index + 1 < servers.length && (!lookup.nameserverSearch || lookup.traceRoot)) {
        index += 1;
        continue;
      }
      await this.answered(prepared, server, outcome);
      return;
    }
  }

  private async answered(prepared: Prepared, server: ServerEntry, reply: Extract<ExchangeOutcome, { outcome: 'reply' }>): Promise<void> {
    const { lookup } = prepared;
    const { message } = reply;
    const rcode = message.flags.rcode;
    if (rcode === DnsRcode.NXDOMAIN && (lookup.originIndex !== null || lookup.needSearch)) {
      if (!this.nextOrigin(lookup)) {
        this.printMessage(prepared, server, message);
        this.received(reply.size, server, reply.elapsedMs);
      }
    } else if (!lookup.nameserverSearch) {
      this.printMessage(prepared, server, message);
    } else if (lookup.traceRoot) {
      await this.startNameserverSearch(prepared, message);
    } else {
      this.printMessage(prepared, server, message);
    }
    if (rcode === DnsRcode.NOERROR || lookup.originIndex === null) this.received(reply.size, server, reply.elapsedMs);
  }

  private received(size: number, server: ServerEntry, elapsedMs: number): void {
    if (this.options.verbose) {
      this.write(`Received ${size} bytes from ${this.socketText(server.address)} in ${Math.floor(elapsedMs)} ms\n`);
    }
  }

  private filter(lookup: Lookup): TransferFilter {
    const { options } = this;
    return {
      listAddresses: options.listAddresses, listType: options.listType, almostAll: options.listAlmostAll, transfer: lookup.rdtype === RRType.AXFR,
    };
  }

  private printMessage(prepared: Prepared, server: ServerEntry, message: DnsMessage): void {
    const { lookup } = prepared;
    const forceError = this.seenError === 1 ? 1 : 0;
    this.seenError = 1;
    if (this.options.server !== null && !this.printedServer) {
      this.write(`Using domain server:\nName: ${server.userArg}\nAddress: ${this.socketText(server.address)}\nAliases: \n\n`);
      this.printedServer = true;
    }
    const nameserver = lookup.nameserverSearch ? server.address : null;
    if (message.flags.rcode !== DnsRcode.NOERROR) {
      const shown = message.flags.rcode === DnsRcode.NXDOMAIN ? lookup.textname : prepared.queryName;
      const line = `${shown} not found: ${message.flags.rcode}(${rcodeText(message.flags.rcode)})`;
      this.write(nameserver === null ? `Host ${line}\n` : `Nameserver ${nameserver}:\n\t${line}\n`);
      return;
    }
    if (this.options.defaultLookups && lookup.rdtype === RRType.A) this.queueDefaultLookups(prepared, message);
    const view: RenderedMessage = { verbose: this.options.verbose, filter: this.filter(lookup), nameserverPrefix: nameserver };
    this.write(renderBody(message, view));
    if (!this.options.verbose && !this.options.defaultLookups && message.answers.length === 0) {
      this.write(`${prepared.queryName} has no ${rrTypeName(lookup.rdtype)} record\n`);
    }
    this.seenError = forceError;
  }

  private queueDefaultLookups(prepared: Prepared, message: DnsMessage): void {
    const { lookup } = prepared;
    let name = prepared.labels.join('.').toLowerCase();
    let labels = prepared.labels;
    for (let remaining = message.answers.length; remaining > 0; remaining--) {
      const alias = message.answers.find((record) => record.data.type === RRType.CNAME && stripped(record.name) === name);
      if (alias === undefined || alias.data.type !== RRType.CNAME) break;
      name = stripped(alias.data.cname);
      const parsed = parseDnsNameText(name);
      if ('name' in parsed) labels = parsed.name.labels;
    }
    const text = formatDnsName(labels);
    for (const rdtype of [RRType.AAAA, RRType.MX]) {
      this.queue.push({ ...lookup, textname: text, rdtype, originIndex: null, retries: this.options.tries, newSearch: false, servers: null });
    }
  }

  private async transfer(prepared: Prepared, servers: readonly ServerEntry[]): Promise<void> {
    const { lookup } = prepared;
    const retries = lookup.retries;
    let index = 0;
    for (;;) {
      const server = servers[index];
      const outcome = await this.port.transfer({
        address: server.address, port: this.portNumber, name: wireNameOf(prepared.labels), type: lookup.rdtype, rrClass: lookup.rdclass,
        ixfrSerial: this.options.ixfrSerial, timeoutMs: this.timeoutMs,
      });
      if (outcome.outcome === 'failed') {
        this.failureText(lookup, server, outcome);
        if (outcome.phase === 'setup' && retries > 1) {
          this.queue.unshift({ ...lookup, retries: retries - 1, newSearch: false });
          this.noServers();
          return;
        }
        if (outcome.phase === 'exchange' && retries > 1) {
          this.queue.unshift({ ...lookup, retries: retries - 1, newSearch: false });
          return;
        }
        if (index + 1 < servers.length) {
          index += 1;
          continue;
        }
        this.noServers();
        return;
      }
      this.printTransfer(prepared, server, outcome.messages, outcome.sizes, outcome.elapsedMs);
      return;
    }
  }

  private printTransfer(prepared: Prepared, server: ServerEntry, messages: readonly DnsMessage[], sizes: readonly number[], elapsedMs: number): void {
    const { lookup } = prepared;
    const progress = { firstSoa: false, secondRecord: false, firstSerial: 0, secondSerial: 0, firstRepeat: false, axfr: lookup.rdtype === RRType.AXFR };
    for (const [index, message] of messages.entries()) {
      this.printMessage(prepared, server, message);
      const verdict = this.transferVerdict(lookup, message, progress);
      if (verdict === 'failed') return;
      if (verdict === 'done') {
        this.received(sizes[index], server, elapsedMs);
        return;
      }
    }
  }

  private transferVerdict(
    lookup: Lookup,
    message: DnsMessage,
    progress: { firstSoa: boolean; secondRecord: boolean; firstSerial: number; secondSerial: number; firstRepeat: boolean; axfr: boolean },
  ): 'more' | 'done' | 'failed' {
    if (message.answers.length === 0) {
      this.write('; Transfer failed.\n');
      return 'failed';
    }
    for (const record of message.answers) {
      if (!progress.firstSoa && record.data.type !== RRType.SOA) {
        this.write('; Transfer failed.  Didn\'t start with SOA answer.\n');
        return 'failed';
      }
      if (!progress.secondRecord && record.data.type !== RRType.SOA) {
        progress.secondRecord = true;
        progress.secondSerial = 0;
        progress.axfr = true;
        continue;
      }
      if (record.data.type !== RRType.SOA) continue;
      const serial = (record.data as SoaRecordData).serial;
      if (!progress.firstSoa) {
        progress.firstSoa = true;
        progress.firstSerial = serial;
        if (lookup.rdtype === RRType.IXFR && serialAtLeast(this.options.ixfrSerial, serial)) return 'done';
        continue;
      }
      if (progress.axfr) return 'done';
      if (!progress.secondRecord) {
        if (progress.firstSerial === serial) return 'done';
        progress.secondRecord = true;
        progress.secondSerial = serial;
        continue;
      }
      if (progress.firstSerial === serial) {
        if (!progress.firstRepeat) {
          progress.firstRepeat = true;
          continue;
        }
        return 'done';
      }
    }
    return 'more';
  }

  private async startNameserverSearch(prepared: Prepared, message: DnsMessage): Promise<void> {
    const { lookup } = prepared;
    this.useSearch = false;
    const followed = await this.nameserverTargets(message.answers, true) ?? await this.nameserverTargets(message.authorities, false);
    if (followed === null || followed.length === 0) return;
    this.queue.unshift({ ...lookup, rdtype: RRType.SOA, traceRoot: false, recurse: false, servers: followed, newSearch: false });
  }

  private async nameserverTargets(records: readonly ResourceRecord<ResourceRecordData>[], fromAnswer: boolean): Promise<ServerEntry[] | null> {
    const entries: ServerEntry[] = [];
    let found = false;
    let failure: string | null = null;
    for (const record of records) {
      if (!fromAnswer && record.data.type === RRType.SOA) return [];
      if (record.data.type !== RRType.NS) continue;
      found = true;
      if (entries.length >= MAX_NAMESERVERS) break;
      const target = stripped((record.data as NsRecordData).nsdname);
      const addresses = await this.addressesNamed(target);
      if (addresses === null) {
        this.write(`couldn't get address for '${target}': not found\n`);
        failure ??= target;
        continue;
      }
      for (const address of addresses) entries.push({ address, userArg: target });
    }
    if (entries.length === 0 && failure !== null) this.fatal(`couldn't get address for '${failure}': not found`);
    return found ? entries : null;
  }

  private async nameserverSearch(prepared: Prepared, servers: readonly ServerEntry[]): Promise<void> {
    let succeeded = false;
    for (const server of servers) {
      const outcome = await this.attempt(prepared, server);
      if (outcome.outcome === 'failed') {
        this.failureText(prepared.lookup, server, outcome);
        continue;
      }
      succeeded = true;
      this.printMessage(prepared, server, outcome.message);
      if (outcome.message.flags.rcode === DnsRcode.NOERROR || prepared.lookup.originIndex === null) this.received(outcome.size, server, outcome.elapsedMs);
    }
    if (!succeeded) this.warn('NS servers could not be reached');
  }
}

function wireNameOf(labels: readonly string[]): string {
  return labels.length === 0 ? '.' : labels.join('.');
}

function stripped(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function serialAtLeast(left: number, right: number): boolean {
  return ((left - right) | 0) >= 0;
}
