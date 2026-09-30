import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { parseZoneFile, renderZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';
import { ZoneError } from '@/network/dns/zone/Zone';
import { SecondaryZoneRefresher, notifyZoneTargets, serveZoneTransfer } from '@/network/dns/transfer/ZoneTransferHosting';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { DnsClass } from '@/network/dns/wire/RRType';
import { IPAddress } from '@/network/core/types';
import { makeTxtRecord } from '@/network/dns/wire/ResourceRecord';
import { formatRecordLine } from '../commands/dns/RecordFormat';
import { normalizeDnsName, parentName } from '@/network/dns/wire/DnsName';
import {
  isTransferQuery, refuseTransfer,
} from '@/network/dns/transfer/AxfrSession';
import { isNotify, makeNotifyAck } from '@/network/dns/transfer/NotifyProtocol';
import { isUpdateMessage } from '@/network/dns/update/DnsUpdate';
import type { DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';
import {
  authorizeUpdate, evaluateUpdate, parseOrFormerr, signIfKeyed, updateResponse, DnsUpdateRcode,
} from '@/network/dns/update/UpdateResponder';
import { TsigKeyring, tsigKeyFromBase64, canonicalKeyName } from '@/network/dns/tsig/Tsig';
import { serialAdd } from '@/network/dns/zone/SerialNumber';
import { RRType } from '@/network/dns/wire/RRType';
import { makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { updatePolicyPermits } from './NamedUpdatePolicy';
import {
  bindDnsUdpServer, unbindDnsUdpServer, DNS_PORT,
} from '@/network/dns/transport/DnsUdpTransport';
import {
  bindDnsTcpServer, unbindDnsTcpServer,
} from '@/network/dns/transport/DnsTcpTransport';
import { parseNamedConf } from './NamedConfParser';
import { NamedConfSyntaxError } from './NamedConfLexer';
import { buildNamedConfig } from './NamedConfig';
import { NamedConfigError } from './NamedConfigError';
import { Bind9Logging } from './Bind9Logging';
import { RndcChannel } from './RndcChannel';
import { RndcServer } from './RndcServer';
import type { NamedConfig, NamedZone } from './NamedConfig';
import type { RndcWireEnvelope } from './RndcWireCodec';
import type { AclHostEnvironment } from './NamedAcl';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { EndHost } from '@/network/devices/EndHost';
import type { OperationResult } from '../LinuxServiceManager';

export interface Bind9Files {
  read(path: string): string | null;
  append(path: string, content: string): void;
  write(path: string, content: string): void;
}

export interface ZoneReloadResult extends OperationResult {
  changed?: boolean;
}

type ConfigLoadResult =
  | { ok: true; config: NamedConfig }
  | { ok: false; error: string };

export const NAMED_CONF_PATH = '/etc/bind/named.conf';
const PROCESS_NAME = 'named';
const LOOPBACK = '127.0.0.1';

export class Bind9Service {
  private config: NamedConfig | null = null;
  private store: ZoneStore | null = null;
  private authoritative: AuthoritativeServer | null = null;
  private resolvers: RecursiveResolver[] = [];
  private readonly cache = new DnsCache();
  private readonly loadedZones = new Map<string, number>();
  private readonly failedZones = new Set<string>();
  private readonly secondaries: SecondaryZoneRefresher;
  private readonly frozenZones = new Set<string>();
  private keyring = new TsigKeyring();
  private readonly logging: Bind9Logging;
  private readonly readFile: (path: string) => string | null;
  private queryLogEnabled = false;
  private dnssecValidationEnabled = true;
  private running = false;
  private activePort = DNS_PORT;
  private readonly rndcChannel: RndcChannel;
  private rndcServer: RndcServer | null = null;

  constructor(
    private readonly host: EndHost,
    private readonly files: Bind9Files,
    private readonly configPath: string = NAMED_CONF_PATH,
  ) {
    this.readFile = (path) => this.files.read(path);
    this.logging = new Bind9Logging((path, content) => this.files.append(path, content));
    this.rndcChannel = new RndcChannel(this);
    this.secondaries = new SecondaryZoneRefresher(host, (name, force) => {
      const zone = this.config?.zones.find((z) => z.name === name && z.type === 'secondary');
      if (zone) void this.refreshSecondaryZone(zone, force);
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Loopback fast-path for the local `rndc` CLI — see RndcServer.handleLoopbackRequest. Null if no rndc control channel is configured/running. */
  dispatchRndcLocally(envelope: RndcWireEnvelope): RndcWireEnvelope | null {
    return this.rndcServer?.handleLoopbackRequest(envelope) ?? null;
  }

  zoneSerial(name: string): number | undefined {
    return this.loadedZones.get(normalizeDnsName(name));
  }

  zoneCount(): number {
    return this.loadedZones.size;
  }

  isQueryLogEnabled(): boolean {
    return this.queryLogEnabled;
  }

  setQueryLog(enabled: boolean): void {
    this.queryLogEnabled = enabled;
  }

  isDnssecValidationEnabled(): boolean {
    return this.dnssecValidationEnabled;
  }

  setDnssecValidation(enabled: boolean): void {
    this.dnssecValidationEnabled = enabled;
  }

  /** `rndc dumpdb [-all]` — dumps every loaded zone's records, real `named_dump.db`-style, via the existing Bind9Files API. */
  dumpDatabase(): OperationResult {
    if (!this.running || !this.store) return { ok: false, error: 'not running' };
    const lines: string[] = [';', `; Dumped at ${new Date().toUTCString()}`, ';'];
    for (const zone of this.store.listZones()) {
      lines.push(`; Zone dump of '${zone.origin || '.'}'`);
      for (const rr of zone.allRecords()) lines.push(formatRecordLine(rr));
      lines.push('');
    }
    this.files.append('/var/cache/bind/named_dump.db', lines.join('\n') + '\n');
    return { ok: true };
  }

  /**
   * `rndc secroots` — dumps the resolver's DNSSEC trust anchors. This
   * simulator doesn't yet wire a live trust-anchor set into
   * Bind9Service's resolver (RecursiveResolver's DNSSEC validation
   * support already exists and is exercised directly in dns-dnssec.test.ts,
   * just not threaded through named.conf here) — the dump honestly
   * reports that instead of fabricating anchors.
   */
  secureRootsReport(): OperationResult {
    if (!this.running) return { ok: false, error: 'not running' };
    const lines = [
      ';', `; Secure roots as of ${new Date().toUTCString()}`, ';',
      this.dnssecValidationEnabled
        ? ' (no trust anchors configured)'
        : ' DNSSEC validation is disabled; no secure roots.',
    ];
    this.files.append('/var/cache/bind/named.secroots', lines.join('\n') + '\n');
    return { ok: true };
  }

  flushCache(): void {
    this.cache.flush();
  }

  freezeZone(name: string): OperationResult {
    const zone = this.primaryZone(name);
    if (!zone) return { ok: false, error: 'not found' };
    if (this.isDynamic(zone)) this.syncZone(zone.name);
    this.frozenZones.add(zone.name);
    return { ok: true };
  }

  thawZone(name: string): ZoneReloadResult {
    const zone = this.primaryZone(name);
    if (!zone) return { ok: false, error: 'not found' };
    this.frozenZones.delete(zone.name);
    return this.reloadZone(name, true);
  }

  reloadZone(name: string, thawing = false): ZoneReloadResult {
    const zone = this.primaryZone(name);
    if (!zone) return { ok: false, error: 'not found' };
    if (this.frozenZones.has(zone.name)) return { ok: false, error: 'frozen' };
    if (this.isDynamic(zone) && !thawing) return { ok: false, error: 'dynamic zone' };
    if (zone.file === null || this.store === null) return { ok: false, error: 'not loaded' };

    const content = this.readFile(zone.file);
    if (content === null) {
      return { ok: false, error: `loading from master file ${zone.file} failed: file not found` };
    }
    try {
      const parsed = parseZoneFile(content, zone.name);
      if (this.loadedZones.get(zone.name) === parsed.soa.data.serial) {
        return { ok: true, changed: false };
      }
      this.store.removeZone(zone.name);
      this.store.addZone(parsed);
      this.loadedZones.set(zone.name, parsed.soa.data.serial);
      this.failedZones.delete(zone.name);
      this.notifySecondaries(zone.name);
      return { ok: true, changed: true };
    } catch (error) {
      if (error instanceof ZoneFileError || error instanceof ZoneError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  private primaryZone(name: string): NamedZone | null {
    const normalized = normalizeDnsName(name);
    const zone = this.config?.zones.find((z) => z.name === normalized);
    return zone && zone.type === 'primary' ? zone : null;
  }

  checkConfig(): OperationResult {
    const loaded = this.loadConfig();
    return loaded.ok ? { ok: true } : loaded;
  }

  start(): OperationResult {
    if (this.running) return { ok: true };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;

    this.applyConfig(loaded.config);
    const port = loaded.config.options.listenOnPort;
    try {
      bindDnsUdpServer(this.host, this.handleUdpQuery, port, PROCESS_NAME);
    } catch {
      return { ok: false, error: `could not listen on UDP socket: address already in use` };
    }
    try {
      bindDnsTcpServer(this.host, this.handleTcpQuery, port);
    } catch {
      unbindDnsUdpServer(this.host, port);
      return { ok: false, error: `could not listen on TCP socket: address already in use` };
    }
    this.activePort = port;
    this.running = true;
    this.startRndc(loaded.config);
    this.refreshAllSecondaryZones();
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    unbindDnsUdpServer(this.host, this.activePort);
    unbindDnsTcpServer(this.host, this.activePort);
    this.stopRndc();
    this.running = false;
  }

  restart(): OperationResult {
    this.stop();
    return this.start();
  }

  reload(): OperationResult {
    if (!this.running) return { ok: false, error: 'named is not running' };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    const previousSerials = new Map(this.loadedZones);
    this.applyConfig(loaded.config);
    if (loaded.config.options.listenOnPort !== this.activePort) {
      this.stop();
      return this.start();
    }
    this.stopRndc();
    this.startRndc(loaded.config);
    for (const [name, serial] of this.loadedZones) {
      if (previousSerials.get(name) !== serial) this.notifySecondaries(name);
    }
    this.refreshAllSecondaryZones();
    return { ok: true };
  }

  private loadConfig(): ConfigLoadResult {
    const source = this.readFile(this.configPath);
    if (source === null) {
      return { ok: false, error: `open: ${this.configPath}: file not found` };
    }
    try {
      const statements = parseNamedConf(source, {
        file: this.configPath,
        readInclude: this.readFile,
      });
      return { ok: true, config: buildNamedConfig(statements) };
    } catch (error) {
      if (error instanceof NamedConfSyntaxError || error instanceof NamedConfigError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  private applyConfig(config: NamedConfig): void {
    const store = new ZoneStore();
    this.loadedZones.clear();
    this.failedZones.clear();

    for (const zone of config.zones) {
      if (zone.type === 'secondary') {
        this.failedZones.add(zone.name);
        continue;
      }
      if (zone.type !== 'primary') continue;
      const content = zone.file === null ? null : this.readFile(zone.file);
      if (content === null) {
        this.failedZones.add(zone.name);
        continue;
      }
      try {
        const parsed = parseZoneFile(content, zone.name);
        store.addZone(parsed);
        this.loadedZones.set(zone.name, parsed.soa.data.serial);
      } catch (error) {
        if (error instanceof ZoneFileError || error instanceof ZoneError) {
          this.failedZones.add(zone.name);
          continue;
        }
        throw error;
      }
    }

    this.keyring = new TsigKeyring();
    for (const key of config.keys.values()) {
      const tsigKey = tsigKeyFromBase64(key.name, key.algorithm, key.secret);
      if (tsigKey) this.keyring.add(tsigKey);
    }
    this.config = config;
    this.store = store;
    this.authoritative = new AuthoritativeServer(store);
    this.resolvers = this.buildResolvers(config);
    this.queryLogEnabled = config.options.queryLog;
    this.dnssecValidationEnabled = config.options.dnssecValidation !== 'no';
  }

  private buildResolvers(config: NamedConfig): RecursiveResolver[] {
    if (!config.options.recursion) return [];
    const resolvers: RecursiveResolver[] = [];
    const forwarders: IPAddress[] = [];
    for (const forwarder of config.options.forwarders) {
      const parsed = IPAddress.tryParse(forwarder);
      if (parsed) forwarders.push(parsed);
    }
    if (forwarders.length > 0) {
      resolvers.push(new RecursiveResolver(this.host, forwarders, this.cache, { forwardRecursively: true }));
    }
    const hints: IPAddress[] = [];
    for (const zone of config.zones) {
      if (zone.type !== 'hint' || zone.file === null) continue;
      const content = this.readFile(zone.file);
      if (content !== null) hints.push(...collectHintAddresses(content));
    }
    if (hints.length > 0) resolvers.push(new RecursiveResolver(this.host, hints, this.cache));
    return resolvers;
  }

  private aclEnvironment(): AclHostEnvironment {
    const localAddresses: string[] = [];
    const localNetworks: { address: string; prefix: number }[] = [];
    for (const port of this.host.getInterfaces()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      localAddresses.push(ip.toString());
      localNetworks.push({
        address: IPAddress.fromUint32((ip.toUint32() & mask.toUint32()) >>> 0).toString(),
        prefix: mask.toCIDR(),
      });
    }
    return { localAddresses, localNetworks };
  }

  /** Opens the real `rndc` control channel(s) declared by `controls{}` — a no-op if none are configured. */
  private startRndc(config: NamedConfig): void {
    if (config.controls.length === 0) return;
    this.rndcServer = new RndcServer(
      this.host, this.rndcChannel, config.controls, config.keys, () => this.aclEnvironment(),
    );
    this.rndcServer.start();
  }

  private stopRndc(): void {
    this.rndcServer?.stop();
    this.rndcServer = null;
  }

  /**
   * BIND9's built-in CHAOS-class identification names (RFC 4892 §2.1,
   * `named(8)` "Built-in Zones"): `version.bind`/`authors.bind` are answered
   * from the running version regardless of any configured zone, and
   * `hostname.bind`/`id.server` report this server's identity.
   */
  private chaosAnswer(query: DnsMessage): DnsMessage | null {
    const question = query.questions[0];
    if (!question || question.qclass !== DnsClass.CH) return null;
    const qname = normalizeDnsName(question.qname);
    let text: string;
    if (qname === 'version.bind' || qname === 'authors.bind') text = 'bind-simulator';
    else if (qname === 'hostname.bind' || qname === 'id.server') text = this.host.getHostname();
    else return null;

    return {
      id: query.id,
      flags: {
        qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false,
        rd: query.flags.rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: query.questions,
      answers: [{ ...makeTxtRecord(question.qname, 0, [text]), rrClass: DnsClass.CH }],
      authorities: [],
      additionals: [],
    };
  }

  private zoneFor(qname: string): NamedZone | null {
    const zones = this.config?.zones ?? [];
    let candidate: string | null = normalizeDnsName(qname);
    while (candidate !== null) {
      const zone = zones.find((z) => z.name === candidate);
      if (zone) return zone;
      candidate = parentName(candidate);
    }
    return null;
  }

  private readonly handleUdpQuery = (
    query: DnsMessage, sourceIP?: IPAddress, sourcePort?: number, raw?: Uint8Array,
  ): DnsMessage | Promise<DnsMessage> =>
    this.answerQuery(query, 'udp', sourceIP, sourcePort, raw);

  private readonly handleTcpQuery = (
    query: DnsMessage, sourceIP?: IPAddress, sourcePort?: number, raw?: Uint8Array,
  ): DnsMessage | Promise<DnsMessage> =>
    this.answerQuery(query, 'tcp', sourceIP, sourcePort, raw);

  private answerQuery(
    query: DnsMessage,
    transport: 'udp' | 'tcp',
    sourceIP?: IPAddress,
    sourcePort?: number,
    raw?: Uint8Array,
  ): DnsMessage | Promise<DnsMessage> {
    const config = this.config!;

    if (isNotify(query)) {
      return this.handleNotify(query, sourceIP);
    }
    if (isUpdateMessage(query)) {
      return this.handleUpdate(query, sourceIP, raw);
    }
    const env = this.aclEnvironment();
    const source = sourceIP?.toString() ?? LOOPBACK;
    const recursionAllowed =
      config.options.recursion && config.options.allowRecursion.matches(source, env);

    if (!config.options.allowQuery.matches(source, env)) {
      return this.refuse(query, recursionAllowed);
    }

    const chaos = this.chaosAnswer(query);
    if (chaos) return chaos;

    const question = query.questions[0];
    if (this.queryLogEnabled && question) {
      this.logging.logQuery(config, {
        clientIP: source,
        clientPort: sourcePort ?? 0,
        qname: question.qname,
        qtype: question.qtype,
        serverIP: env.localAddresses[0] ?? LOOPBACK,
      });
    }
    if (question && isTransferQuery(query)) {
      const transferAcl = this.zoneFor(question.qname)?.allowTransfer
        ?? config.options.allowTransfer;
      if (!transferAcl.matches(source, env)) {
        return this.refuse(query, recursionAllowed);
      }
      return transport === 'udp' ? refuseTransfer(query) : this.serveTransfer(query);
    }

    const response = this.authoritative!.answer(query);
    if (response.flags.rcode === DnsRcode.REFUSED && this.queryHitsFailedZone(query)) {
      return {
        ...response,
        flags: { ...response.flags, rcode: DnsRcode.SERVFAIL, ra: recursionAllowed },
      };
    }

    const outsideAuthority = !response.flags.aa && response.flags.rcode === DnsRcode.REFUSED;
    if (outsideAuthority && question && query.flags.rd && recursionAllowed && this.resolvers.length > 0) {
      return this.recurse(query);
    }
    return { ...response, flags: { ...response.flags, ra: recursionAllowed } };
  }

  private handleUpdate(query: DnsMessage, sourceIP?: IPAddress, raw?: Uint8Array): DnsMessage {
    const now = Math.floor(Date.now() / 1000);
    const auth = authorizeUpdate(raw, 'none', this.keyring, now);
    const reply = (rcode: number): DnsMessage =>
      signIfKeyed(updateResponse(query, rcode), auth, now);
    if (auth.rcode !== DnsRcode.NOERROR) return reply(auth.rcode);

    const request = parseOrFormerr(query);
    if (!request) return reply(DnsRcode.FORMERR);

    const named = this.primaryZone(request.zone);
    const zone = named ? this.store?.getZone(named.name) ?? null : null;
    if (!named || !zone) return reply(DnsUpdateRcode.NOTAUTH);

    const signer = auth.key ? canonicalKeyName(auth.key.name) : null;
    const source = sourceIP?.toString() ?? LOOPBACK;
    if (named.updatePolicy === null && !named.allowUpdate.matches(source, this.aclEnvironment(), signer)) {
      return reply(DnsRcode.REFUSED);
    }
    if (this.frozenZones.has(named.name)) return reply(DnsRcode.SERVFAIL);

    const verdict = evaluateUpdate(zone, request);
    if (verdict.rcode !== DnsRcode.NOERROR) return reply(verdict.rcode);
    if (named.updatePolicy !== null && !this.policyPermits(named.updatePolicy, signer, zone, request)) {
      return reply(DnsRcode.REFUSED);
    }

    const { additions, removals, soa } = verdict.applied;
    for (const rr of removals) zone.removeRecord(rr);
    for (const rr of additions) zone.addRecord(rr);
    if (additions.length > 0 || removals.length > 0 || soa) {
      const base = soa ?? zone.soa;
      zone.updateSoa(makeSoaRecord(base.name, base.ttl, {
        ...base.data, serial: soa ? soa.data.serial : serialAdd(zone.soa.data.serial, 1),
      }));
      this.loadedZones.set(named.name, zone.soa.data.serial);
      this.notifySecondaries(named.name);
    }
    return reply(DnsRcode.NOERROR);
  }

  private policyPermits(
    rules: NonNullable<NamedZone['updatePolicy']>,
    signer: string | null,
    zone: NonNullable<ReturnType<ZoneStore['getZone']>>,
    request: DnsUpdateRequest,
  ): boolean {
    const allowed = (name: string, type: number): boolean =>
      updatePolicyPermits(rules, signer, zone.origin, name, type);
    for (const update of request.updates) {
      if (update.kind === 'add' || update.kind === 'delete-record') {
        if (!allowed(update.record.name, update.record.data.type as number)) return false;
      } else if (update.kind === 'delete-rrset') {
        if (!allowed(update.name, update.type as number)) return false;
      } else {
        const name = normalizeDnsName(update.name);
        const present = new Set<number>();
        for (const rr of zone.allRecords()) {
          if (normalizeDnsName(rr.name) === name) present.add(rr.data.type as number);
        }
        for (const type of present) if (!allowed(update.name, type)) return false;
      }
    }
    return true;
  }

  private isDynamic(zone: NamedZone): boolean {
    return zone.updatePolicy !== null || !zone.allowUpdate.grantsNothing();
  }

  syncZone(name: string): OperationResult {
    const named = this.primaryZone(name);
    const zone = named ? this.store?.getZone(named.name) ?? null : null;
    if (!named || !zone || named.file === null) return { ok: false, error: 'not found' };
    if (!this.isDynamic(named)) return { ok: false, error: 'not dynamic' };
    this.files.write(named.file, renderZoneFile(zone));
    return { ok: true };
  }

  private serveTransfer(query: DnsMessage): DnsMessage {
    return serveZoneTransfer(this.store, query) ?? this.refuse(query, false);
  }

  private handleNotify(query: DnsMessage, sourceIP?: IPAddress): DnsMessage {
    const qname = normalizeDnsName(query.questions[0]?.qname ?? '');
    const zone = this.config?.zones.find((z) => z.name === qname && z.type === 'secondary');
    const source = sourceIP?.toString();
    if (zone && source && zone.primaries.includes(source)) {
      void this.refreshSecondaryZone(zone);
    }
    return makeNotifyAck(query);
  }

  private refreshAllSecondaryZones(): void {
    for (const zone of this.config?.zones ?? []) {
      if (zone.type === 'secondary') void this.refreshSecondaryZone(zone);
    }
  }

  retransferZone(name: string): OperationResult {
    const normalized = normalizeDnsName(name);
    const zone = this.config?.zones.find((z) => z.name === normalized && z.type === 'secondary');
    if (!zone) return { ok: false, error: 'not found' };
    void this.refreshSecondaryZone(zone, true);
    return { ok: true };
  }

  private async refreshSecondaryZone(zone: NamedZone, force = false): Promise<boolean> {
    if (!this.running || this.store === null) return false;
    const primaries = zone.primaries
      .map((primary) => IPAddress.tryParse(primary))
      .filter((ip): ip is IPAddress => ip !== null);
    const { zone: fetched } = await this.secondaries.refresh(this.store, zone.name, primaries, force);
    if (!fetched) return false;
    this.loadedZones.set(zone.name, fetched.soa.data.serial);
    this.failedZones.delete(zone.name);
    return true;
  }

  private notifySecondaries(zoneName: string): void {
    const zone = this.config?.zones.find((z) => z.name === zoneName && z.type === 'primary');
    const loaded = this.store?.findZone(zoneName);
    if (!zone || !loaded || loaded.origin !== zoneName) return;
    const targets = zone.alsoNotify
      .map((target) => IPAddress.tryParse(target))
      .filter((ip): ip is IPAddress => ip !== null);
    notifyZoneTargets(this.host, loaded, targets);
  }

  private async recurse(query: DnsMessage): Promise<DnsMessage> {
    const question = query.questions[0];
    let result = await this.resolvers[0].resolve(question.qname, question.qtype);
    for (const next of this.resolvers.slice(1)) {
      if (result.status !== 'SERVFAIL') break;
      result = await next.resolve(question.qname, question.qtype);
    }
    const rcode =
      result.status === 'NOERROR' ? DnsRcode.NOERROR :
      result.status === 'NXDOMAIN' ? DnsRcode.NXDOMAIN :
      DnsRcode.SERVFAIL;
    return {
      id: query.id,
      flags: {
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: query.flags.rd, ra: true, ad: false, cd: false, rcode,
      },
      questions: [question],
      answers: [...result.answers],
      authorities: [],
      additionals: [],
    };
  }

  private refuse(query: DnsMessage, recursionAllowed: boolean): DnsMessage {
    return {
      id: query.id,
      flags: {
        qr: true, opcode: query.flags.opcode, aa: false, tc: false,
        rd: query.flags.rd, ra: recursionAllowed, ad: false, cd: false,
        rcode: DnsRcode.REFUSED,
      },
      questions: query.questions,
      answers: [],
      authorities: [],
      additionals: [],
    };
  }

  private queryHitsFailedZone(query: DnsMessage): boolean {
    const question = query.questions[0];
    if (!question) return false;
    let candidate: string | null = normalizeDnsName(question.qname);
    while (candidate !== null) {
      if (this.failedZones.has(candidate)) return true;
      candidate = parentName(candidate);
    }
    return false;
  }
}

const HINT_ADDRESS_PATTERN = /\bA\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$/;

function collectHintAddresses(content: string): IPAddress[] {
  const addresses: IPAddress[] = [];
  for (const line of content.split('\n')) {
    const stripped = line.split(';')[0].trimEnd();
    const match = HINT_ADDRESS_PATTERN.exec(stripped);
    if (!match) continue;
    const parsed = IPAddress.tryParse(match[1]);
    if (parsed) addresses.push(parsed);
  }
  return addresses;
}
