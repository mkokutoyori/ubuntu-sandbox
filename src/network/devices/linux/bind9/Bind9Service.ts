import { simulationDate, simulationNowMs } from '@/network/core/SystemClock';

import { ZoneStore, type PositiveTrim } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { RecursiveResolver, resolutionFromCache } from '@/network/dns/resolver/RecursiveResolver';
import { DEFAULT_CACHE_LIMITS, DnsCache, type DnsCacheLimits } from '@/network/dns/resolver/DnsCache';
import { loadZoneFile, parseZoneRecords, renderZoneFile, zoneFailureReport, ZoneFileError } from '@/network/dns/zone/ZoneFile';
import { ZoneError } from '@/network/dns/zone/Zone';
import { SecondaryZoneRefresher, notifyZoneTargets, serveZoneTransfer, signTransferResponse, datagramReply } from '@/network/dns/transfer/ZoneTransferHosting';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { DnsClass } from '@/network/dns/wire/RRType';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { makeTxtRecord, makeCnameRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { formatRecordLine } from '../commands/dns/RecordFormat';
import { normalizeDnsName, parentName } from '@/network/dns/wire/DnsName';
import {
  isTransferQuery, refuseTransfer,
} from '@/network/dns/transfer/AxfrSession';
import { isNotify, makeNotifyAck, type NotifyTarget } from '@/network/dns/transfer/NotifyProtocol';
import { isUpdateMessage } from '@/network/dns/update/DnsUpdate';
import type { DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';
import {
  authorizeUpdate, evaluateUpdate, parseOrFormerr, signIfKeyed, updateResponse, DnsUpdateRcode,
} from '@/network/dns/update/UpdateResponder';
import { TsigKeyring, tsigKeyFromBase64, tsigFailureText, canonicalKeyName, type TsigKey } from '@/network/dns/tsig/Tsig';
import { serialAdd } from '@/network/dns/zone/SerialNumber';
import { RRType } from '@/network/dns/wire/RRType';
import { echoedOpt, findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { applyDns64, dns64ReverseTarget } from '@/network/dns/dns64/Dns64';
import type { ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';
import { buildRecursiveResponse, recursiveResolveOptions, type RecursiveEnvelope } from '@/network/dns/resolver/RecursiveResponse';
import { makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { updatePolicyPermits } from './NamedUpdatePolicy';
import { parseNamedConf } from './NamedConfParser';
import { NamedConfSyntaxError } from './NamedConfLexer';
import { buildNamedConfig, DEFAULT_EDNS_UDP_SIZE } from './NamedConfig';
import { NamedConfigError } from './NamedConfigError';
import { Bind9Logging, queryLogFlags } from './Bind9Logging';
import { RndcChannel } from './RndcChannel';
import { bindPackageVersion } from './BindVersion';
import { renderViewDump } from './NamedCacheDump';
import { RndcServer } from './RndcServer';
import { Bind9EncryptedListeners } from './Bind9EncryptedListeners';
import { Bind9PlainListeners } from './Bind9PlainListeners';
import type { Zone } from '@/network/dns/zone/Zone';
import type { ResourceRecord, ResourceRecordData, NsRecordData, ARecordData } from '@/network/dns/wire/ResourceRecord';
import type { ForwardMode, NamedConfig, NamedRemoteServer, NamedZone } from './NamedConfig';
import { DOT_PORT } from '@/network/dns/transport/DnsTlsTransport';
import { DNS_PORT } from '@/network/dns/transport/DnsUdpTransport';
import { timeoutsFromTenths, type DnsStreamTimeouts } from '@/network/dns/transport/DnsStreamTimeouts';
import type { TransferEndpoint, TransferTls } from '@/network/dns/transfer/TransferEndpoint';
import { pemToCertChain } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { RndcWireEnvelope } from './RndcWireCodec';
import type { AclHostEnvironment } from './NamedAcl';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { EndHost } from '@/network/devices/EndHost';
import type { OperationResult } from '../LinuxServiceManager';

export interface Bind9Files {
  read(path: string): string | null;
  append(path: string, content: string): void;
  write(path: string, content: string): void;
  log?(message: string): void;
  systemAnchors?(): readonly X509Certificate[];
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
  private rootHints: { readonly ns: readonly ResourceRecord<NsRecordData>[] } | null = null;
  private forwardZones = new Map<string, { readonly mode: ForwardMode; readonly resolver: RecursiveResolver }>();
  private readonly cache = new DnsCache(() => this.host.getSystemClockMs(), () => this.cacheLimits());
  private readonly loadedZones = new Map<string, number>();
  private readonly loadedFiles = new Map<string, string>();
  private readonly failedZones = new Set<string>();
  private readonly reloadPending = new Set<string>();
  private readonly secondaries: SecondaryZoneRefresher;
  private readonly frozenZones = new Set<string>();
  private keyring = new TsigKeyring();
  private readonly logging: Bind9Logging;
  private encryptedListeners: Bind9EncryptedListeners | null = null;
  private plainListeners: Bind9PlainListeners | null = null;
  private readonly readFile: (path: string) => string | null;
  private queryLogEnabled = false;
  private dnssecValidationEnabled = true;
  private running = false;
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

  dumpDatabase(options: readonly string[] = []): OperationResult {
    if (!this.running || !this.store) return { ok: false, error: 'not running' };
    const wanted = new Set(options.filter((word) => word.startsWith('-')));
    const wholeView = wanted.size === 0 || wanted.has('-all') || wanted.has('-cache') || wanted.has('-expired');
    const sections = {
      cache: wholeView,
      addressDatabase: wholeView || wanted.has('-adb'),
      badCache: wholeView || wanted.has('-bad'),
      servfailCache: wholeView || wanted.has('-fail'),
    };
    const lines: string[] = [];
    if (sections.cache || sections.addressDatabase || sections.badCache || sections.servfailCache) {
      const now = simulationDate();
      lines.push(...renderViewDump('_default', this.cache.snapshot(), sections, now), ...renderViewDump('_bind', null, sections, now), '; Dump complete');
    }
    if (wanted.has('-zones') || wanted.has('-all')) {
      lines.push(';', `; Dumped at ${simulationDate().toUTCString()}`, ';');
      for (const zone of this.store.listZones()) {
        lines.push(`; Zone dump of '${zone.origin || '.'}'`);
        for (const rr of zone.allRecords()) lines.push(formatRecordLine(rr));
        lines.push('');
      }
    }
    this.files.write('/var/cache/bind/named_dump.db', lines.join('\n') + '\n');
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
    const anchors = this.config?.trustAnchors ?? [];
    const lines = [
      ';', `; Secure roots as of ${simulationDate().toUTCString()}`, ';',
      ...(!this.dnssecValidationEnabled
        ? [' DNSSEC validation is disabled; no secure roots.']
        : anchors.length === 0
          ? [' (no trust anchors configured)']
          : anchors.map((anchor) => ` ${anchor.name}/IN DS ${anchor.data.keyTag} ${anchor.data.algorithm} ${anchor.data.digestType} ${anchor.data.digest} ; static`)),
    ];
    this.files.append('/var/cache/bind/named.secroots', lines.join('\n') + '\n');
    return { ok: true };
  }

  flushCache(): void {
    this.cache.flush();
  }

  flushName(name: string): void {
    this.cache.flushName(name);
  }

  flushTree(name: string): void {
    this.cache.flushTree(name);
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
      if (this.loadedFiles.get(zone.name) === content && !this.reloadPending.has(zone.name)) return { ok: true, changed: false };
      const parsed = loadZoneFile(content, zone.name).zone;
      this.store.removeZone(zone.name);
      this.store.addZone(parsed);
      this.loadedZones.set(zone.name, parsed.soa.data.serial);
      this.loadedFiles.set(zone.name, content);
      this.failedZones.delete(zone.name);
      this.reloadPending.delete(zone.name);
      this.notifySecondaries(zone.name);
      return { ok: true, changed: true };
    } catch (error) {
      if (error instanceof ZoneFileError || error instanceof ZoneError) {
        this.reloadPending.add(zone.name);
        this.reportLoadFailure(zone.name, zone.file, error);
        return { ok: true, changed: true };
      }
      throw error;
    }
  }

  private reportLoadFailure(zoneName: string, file: string, error: ZoneFileError | ZoneError): void {
    const lines = error instanceof ZoneFileError
      ? zoneFailureReport(zoneName, file, error)
      : [`zone ${zoneName}/IN: loading from master file ${file} failed: ${error.message}`, `zone ${zoneName}/IN: not loaded due to errors.`];
    for (const line of lines) this.files.log?.(line);
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

    this.cache.flush();
    this.applyConfig(loaded.config);
    const encrypted = this.replaceEncryptedListeners(loaded.config);
    if (!encrypted.ok) return encrypted;
    const plain = this.newPlainListeners();
    const plainBound = plain.rebind(loaded.config.options.plainListens);
    if (!plainBound.ok) {
      this.stopEncryptedListeners();
      return plainBound;
    }
    this.plainListeners = plain;
    this.running = true;
    this.startRndc(loaded.config);
    for (const name of this.loadedZones.keys()) this.notifySecondaries(name);
    this.refreshAllSecondaryZones();
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    this.plainListeners?.stop();
    this.plainListeners = null;
    this.stopEncryptedListeners();
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
    const plainRebound = this.plainListeners?.rebind(loaded.config.options.plainListens) ?? { ok: true as const };
    if (!plainRebound.ok) return plainRebound;
    const encrypted = this.replaceEncryptedListeners(loaded.config);
    if (!encrypted.ok) return encrypted;
    this.stopRndc();
    this.startRndc(loaded.config);
    for (const [name, serial] of this.loadedZones) {
      if (previousSerials.get(name) !== serial) this.notifySecondaries(name);
    }
    this.refreshAllSecondaryZones();
    return { ok: true };
  }

  private streamTimeouts(transport: 'tcp' | 'tls'): DnsStreamTimeouts {
    return timeoutsFromTenths(this.config!.options.tcpTimeouts, transport);
  }

  private newPlainListeners(): Bind9PlainListeners {
    return new Bind9PlainListeners({
      host: this.host,
      processName: PROCESS_NAME,
      udpHandler: this.handleUdpQuery,
      tcpHandler: this.handleTcpQuery,
      timeouts: () => this.streamTimeouts('tcp'),
      environment: () => this.aclEnvironment(),
    });
  }

  private replaceEncryptedListeners(config: NamedConfig): OperationResult {
    const next = new Bind9EncryptedListeners({
      host: this.host,
      processName: PROCESS_NAME,
      handler: this.handleTcpQuery,
      timeouts: () => this.streamTimeouts('tls'),
      readFile: this.readFile,
      log: (message) => this.files.log?.(message),
      environment: () => this.aclEnvironment(),
    });
    const prepared = next.prepare(config.options.listeners);
    if (prepared.ok === false) {
      for (const line of prepared.lines) this.files.log?.(line);
      return { ok: false, error: prepared.error };
    }
    this.stopEncryptedListeners();
    const bound = next.bind(prepared);
    if (!bound.ok) return bound;
    this.encryptedListeners = next;
    return { ok: true };
  }

  private stopEncryptedListeners(): void {
    this.encryptedListeners?.stop();
    this.encryptedListeners = null;
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
    this.loadedFiles.clear();
    this.failedZones.clear();
    this.reloadPending.clear();

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
        const parsed = loadZoneFile(content, zone.name).zone;
        store.addZone(parsed);
        this.loadedZones.set(zone.name, parsed.soa.data.serial);
        this.loadedFiles.set(zone.name, content);
      } catch (error) {
        if (error instanceof ZoneFileError || error instanceof ZoneError) {
          this.failedZones.add(zone.name);
          this.reportLoadFailure(zone.name, zone.file!, error);
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
    this.authoritative = new AuthoritativeServer(store, {
      writesApexNs: () => true,
      trimsPositiveAnswers: (recursionDesired) => this.positiveTrim(recursionDesired),
      ednsPayloadSize: () => this.config?.options.ednsUdpSize ?? DEFAULT_EDNS_UDP_SIZE,
    });
    this.resolvers = this.buildResolvers(config);
    this.forwardZones = this.buildForwardZones(config);
    this.queryLogEnabled = config.options.queryLog;
    this.dnssecValidationEnabled = config.options.dnssecValidation !== 'no';
    for (const warning of config.warnings) this.files.log?.(warning);
  }

  private positiveTrim(recursionDesired: boolean): PositiveTrim {
    switch (this.config?.options.minimalResponses) {
      case 'yes': return 'authority-and-additional';
      case 'no-auth': return 'authority';
      case 'no-auth-recursive': return recursionDesired ? 'authority' : 'none';
      default: return 'none';
    }
  }

  private cacheLimits(): DnsCacheLimits {
    const options = this.config?.options;
    return {
      ...DEFAULT_CACHE_LIMITS,
      ranksByTrust: true,
      maxTtlSeconds: options?.maxCacheTtl ?? DEFAULT_CACHE_LIMITS.maxTtlSeconds,
      maxNegativeTtlSeconds: options?.maxNcacheTtl ?? DEFAULT_CACHE_LIMITS.maxNegativeTtlSeconds,
    };
  }

  private buildResolvers(config: NamedConfig): RecursiveResolver[] {
    this.rootHints = null;
    if (!config.options.recursion) return [];
    const resolvers: RecursiveResolver[] = [];
    const forwarders: IPAddress[] = [];
    for (const forwarder of config.options.forwarders) {
      const parsed = IPAddress.tryParse(forwarder);
      if (parsed) forwarders.push(parsed);
    }
    const dnssec = config.options.dnssecValidation !== 'no' && config.trustAnchors.length > 0
      ? { dnssec: { anchors: config.trustAnchors, now: () => Math.floor(this.host.getSystemClockMs() / 1000) } }
      : {};
    const hintRecords = this.readHintRecords(config);
    const hints = hintRecords
      .filter((record): record is ResourceRecord<ARecordData> => record.data.type === RRType.A)
      .map((record) => record.data.address);
    const hintNs = hintRecords.filter((record): record is ResourceRecord<NsRecordData> => record.data.type === RRType.NS);
    if (hintNs.length > 0) {
      this.rootHints = { ns: hintNs };
    }
    if (forwarders.length > 0) {
      const fallsBack = config.options.forwardMode === 'first' && hints.length > 0;
      resolvers.push(new RecursiveResolver(
        this.host, forwarders, this.cache, { forwardRecursively: true, servfailTtlSeconds: fallsBack ? 0 : config.options.servfailTtl, resolveSpecialUseNamesUpstream: !config.options.emptyZonesEnable, ...dnssec }));
      if (config.options.forwardMode === 'only') return resolvers;
    }
    if (hints.length > 0) resolvers.push(new RecursiveResolver(this.host, hints, this.cache, { servfailTtlSeconds: config.options.servfailTtl, resolveSpecialUseNamesUpstream: !config.options.emptyZonesEnable, retainsAuthorityData: true, primesRoot: true, ...dnssec }));
    return resolvers;
  }

  private readHintRecords(config: NamedConfig): ResourceRecord<ResourceRecordData>[] {
    const records: ResourceRecord<ResourceRecordData>[] = [];
    for (const zone of config.zones) {
      if (zone.type !== 'hint' || zone.file === null) continue;
      const content = this.readFile(zone.file);
      if (content === null) continue;
      try {
        records.push(...parseZoneRecords(content, '.').records);
      } catch (error) {
        if (!(error instanceof ZoneFileError)) throw error;
      }
    }
    return records;
  }

  private buildForwardZones(config: NamedConfig): Map<string, { readonly mode: ForwardMode; readonly resolver: RecursiveResolver }> {
    const zones = new Map<string, { readonly mode: ForwardMode; readonly resolver: RecursiveResolver }>();
    if (!config.options.recursion) return zones;
    const dnssec = config.options.dnssecValidation !== 'no' && config.trustAnchors.length > 0
      ? { dnssec: { anchors: config.trustAnchors, now: () => Math.floor(this.host.getSystemClockMs() / 1000) } }
      : {};
    for (const zone of config.zones) {
      if (zone.type !== 'forward') continue;
      const forwarders = zone.forwarders
        .map((forwarder) => IPAddress.tryParse(forwarder))
        .filter((ip): ip is IPAddress => ip !== null);
      if (forwarders.length === 0) continue;
      zones.set(zone.name, {
        mode: zone.forward ?? config.options.forwardMode,
        resolver: new RecursiveResolver(this.host, forwarders, this.cache, {
          forwardRecursively: true,
          servfailTtlSeconds: (zone.forward ?? config.options.forwardMode) === 'first' && this.resolvers.length > 0 ? 0 : config.options.servfailTtl,
          resolveSpecialUseNamesUpstream: !config.options.emptyZonesEnable, ...dnssec,
        }),
      });
    }
    return zones;
  }

  private resolversFor(qname: string): readonly RecursiveResolver[] {
    let candidate: string | null = normalizeDnsName(qname);
    while (candidate !== null) {
      const forwarded = this.forwardZones.get(candidate);
      if (forwarded) return forwarded.mode === 'only' ? [forwarded.resolver] : [forwarded.resolver, ...this.resolvers];
      candidate = parentName(candidate);
    }
    return this.resolvers;
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
    for (const port of this.host.getInterfaces()) {
      for (const entry of port.getIPv6Addresses()) {
        localAddresses.push(entry.address.toString());
        localNetworks.push({ address: entry.address.toString(), prefix: entry.prefixLength });
      }
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
  private chaosEmpty(query: DnsMessage): DnsMessage {
    const question = query.questions[0];
    const name = normalizeDnsName(question.qname);
    const soa = makeSoaRecord(name, 86400, {
      mname: name, rname: `hostmaster.${name}`, serial: 0, refresh: 28800, retry: 7200, expire: 604800, minimum: 86400,
    });
    return {
      id: query.id,
      flags: {
        qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false,
        rd: query.flags.rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: query.questions,
      answers: [],
      authorities: [{ ...soa, rrClass: DnsClass.CH }],
      additionals: [],
    };
  }

  private unservedClassAnswer(query: DnsMessage, recursionAllowed: boolean): DnsMessage | null {
    const question = query.questions[0];
    if (!question || question.qclass === DnsClass.IN) return null;
    const refused = this.refuse(query, recursionAllowed);
    const malformed = question.qclass === DnsClass.ANY || question.qclass === DnsClass.NONE;
    return { ...refused, flags: { ...refused.flags, rcode: malformed ? DnsRcode.FORMERR : DnsRcode.REFUSED } };
  }

  private chaosAnswer(query: DnsMessage): DnsMessage | null {
    const question = query.questions[0];
    if (!question || question.qclass !== DnsClass.CH) return null;
    const qname = normalizeDnsName(question.qname);
    let text: string;
    if (qname === 'version.bind') {
      const version = this.config?.options.version ?? { kind: 'real' };
      if (version.kind === 'none') return this.chaosEmpty(query);
      text = version.kind === 'text' ? version.text : bindPackageVersion();
    } else if (qname === 'authors.bind') text = 'bind-simulator';
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
      authorities: [{ ...makeNsRecord(question.qname, 0, question.qname), rrClass: DnsClass.CH }],
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
    query: DnsMessage, sourceIP?: IPAddress | IPv6Address, sourcePort?: number, raw?: Uint8Array,
  ): DnsMessage | Promise<DnsMessage> =>
    datagramReply(this.answerQuery(query, 'udp', sourceIP, sourcePort, raw));

  private readonly handleTcpQuery = (
    query: DnsMessage, sourceIP?: IPAddress | IPv6Address, sourcePort?: number, raw?: Uint8Array,
  ): DnsMessage | DnsMessage[] | Promise<DnsMessage> =>
    this.answerQuery(query, 'tcp', sourceIP, sourcePort, raw);

  private answerQuery(
    query: DnsMessage,
    transport: 'udp' | 'tcp',
    sourceIP?: IPAddress | IPv6Address,
    sourcePort?: number,
    raw?: Uint8Array,
  ): DnsMessage | DnsMessage[] | Promise<DnsMessage> {
    const answer = this.answerQueryBeforeDns64(query, transport, sourceIP, sourcePort, raw);
    const question = query.questions[0];
    if (!this.config?.options.dns64.length || Array.isArray(answer)
      || (question?.qtype !== RRType.AAAA && question?.qtype !== RRType.PTR)
      || isNotify(query) || isUpdateMessage(query)) {
      return answer;
    }
    const client = sourceIP?.toString() ?? LOOPBACK;
    return Promise.resolve(answer).then((response) => question.qtype === RRType.AAAA
      ? this.synthesizeAaaa(query, response, client)
      : this.synthesizePtr(query, response, client));
  }

  private async synthesizePtr(query: DnsMessage, response: DnsMessage, client: string): Promise<DnsMessage> {
    const env = this.aclEnvironment();
    const rules = this.config!.options.dns64.map((statement) => ({
      prefix: statement.prefix,
      clients: (address: string) => statement.clients.matches(address, env),
      mapped: () => true,
      exclude: statement.exclude,
      recursiveOnly: statement.recursiveOnly,
      breakDnssec: statement.breakDnssec,
    }));
    const question = query.questions[0];
    const target = dns64ReverseTarget(rules, client, question.qname);
    if (target === null || (rules[0].recursiveOnly && !query.flags.rd)) return response;
    const reverseQuery: DnsMessage = { ...query, questions: [{ ...question, qname: target }] };
    const answered = await this.answerQueryBeforeDns64(reverseQuery, 'udp', IPAddress.tryParse(client) ?? IPv6Address.tryParse(client) ?? undefined);
    const reverse = Array.isArray(answered) ? answered[0] : answered;
    const pointers = reverse.answers.filter((rr) => rr.data.type === RRType.PTR);
    if (reverse.flags.rcode !== DnsRcode.NOERROR || pointers.length === 0) return response;
    const ttl = Math.min(...pointers.map((rr) => rr.ttl));
    return {
      ...response,
      flags: { ...response.flags, rcode: DnsRcode.NOERROR, ad: false },
      answers: [makeCnameRecord(question.qname, ttl, target), ...reverse.answers],
      authorities: [],
    };
  }

  private async synthesizeAaaa(query: DnsMessage, response: DnsMessage, client: string): Promise<DnsMessage> {
    const config = this.config!;
    const env = this.aclEnvironment();
    const rules = config.options.dns64.map((statement) => ({
      prefix: statement.prefix,
      clients: (address: string) => statement.clients.matches(address, env),
      mapped: (address: IPAddress) => statement.mapped.matches(address.toString(), env),
      exclude: statement.exclude,
      recursiveOnly: statement.recursiveOnly,
      breakDnssec: statement.breakDnssec,
    }));
    const question = query.questions[0];
    const toResult = (message: DnsMessage): ResolutionResult => ({
      status: message.flags.rcode === DnsRcode.NOERROR ? 'NOERROR'
        : message.flags.rcode === DnsRcode.NXDOMAIN ? 'NXDOMAIN' : 'SERVFAIL',
      answers: message.answers,
      authorities: message.authorities,
      fromCache: false,
      ...(message.flags.ad ? { security: 'secure' as const } : {}),
    });
    const lookup = async (qname: string, qtype: number): Promise<ResolutionResult> => {
      const aQuery: DnsMessage = { ...query, questions: [{ ...question, qname, qtype }] };
      const answered = await this.answerQueryBeforeDns64(aQuery, 'udp', IPAddress.tryParse(client) ?? IPv6Address.tryParse(client) ?? undefined);
      return toResult(Array.isArray(answered) ? answered[0] : answered);
    };
    const original = toResult(response);
    const result = await applyDns64(rules, {
      client,
      checkingDisabled: query.flags.cd,
      dnssecOk: findOpt(query)?.data.dnssecOk === true,
      recursionDesired: query.flags.rd,
    }, question.qname, original, lookup);
    if (result === original) return response;
    const rcode = result.status === 'NOERROR' ? DnsRcode.NOERROR
      : result.status === 'NXDOMAIN' ? DnsRcode.NXDOMAIN : DnsRcode.SERVFAIL;
    return {
      ...response,
      flags: { ...response.flags, rcode, ad: false },
      answers: [...result.answers],
      authorities: [...(result.authorities ?? response.authorities)],
    };
  }

  private answerQueryBeforeDns64(
    query: DnsMessage,
    transport: 'udp' | 'tcp',
    sourceIP?: IPAddress | IPv6Address,
    sourcePort?: number,
    raw?: Uint8Array,
  ): DnsMessage | DnsMessage[] | Promise<DnsMessage> {
    const config = this.config!;

    if (isNotify(query)) {
      return this.handleNotify(query, sourceIP, sourcePort, raw);
    }
    if (isUpdateMessage(query)) {
      return this.handleUpdate(query, sourceIP, raw);
    }
    const env = this.aclEnvironment();
    const source = sourceIP?.toString() ?? LOOPBACK;
    const recursionAllowed =
      config.options.recursion && config.options.allowRecursion.matches(source, env);

    const asked = query.questions[0];
    const queryAcl = (asked ? this.zoneFor(asked.qname)?.allowQuery : null) ?? config.options.allowQuery;
    if (!queryAcl.matches(source, env)) {
      return this.refuse(query, recursionAllowed);
    }

    const chaos = this.chaosAnswer(query);
    if (chaos) return chaos;
    const unservedClass = this.unservedClassAnswer(query, recursionAllowed);
    if (unservedClass) return unservedClass;

    const question = query.questions[0];
    if (this.queryLogEnabled && question) {
      this.logging.logQuery(config, {
        flags: queryLogFlags(query, transport),
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
      const now = Math.floor(simulationNowMs() / 1000);
      const auth = authorizeUpdate(raw, 'none', this.keyring, now);
      if (auth.rcode !== DnsRcode.NOERROR) {
        const refused = this.refuse(query, recursionAllowed);
        return signIfKeyed({ ...refused, flags: { ...refused.flags, rcode: auth.rcode } }, auth, now);
      }
      if (!config.zones.some((zone) => zone.name === normalizeDnsName(question.qname))) {
        const refused = this.refuse(query, recursionAllowed);
        return { ...refused, flags: { ...refused.flags, rcode: DnsRcode.NOTAUTH } };
      }
      const signer = auth.key ? canonicalKeyName(auth.key.name) : null;
      if (!transferAcl.matches(source, env, signer)) {
        return signIfKeyed(this.refuse(query, recursionAllowed), auth, now);
      }
      if (transport === 'udp') return refuseTransfer(query);
      return signTransferResponse(this.serveTransfer(query), auth, now);
    }

    const response = this.authoritative!.answer(query);
    if (response.flags.rcode === DnsRcode.REFUSED && this.queryHitsFailedZone(query)) {
      return {
        ...response,
        flags: { ...response.flags, rcode: DnsRcode.SERVFAIL, ra: recursionAllowed },
      };
    }

    const outsideAuthority = !response.flags.aa && response.flags.rcode === DnsRcode.REFUSED;
    if (outsideAuthority && question && query.flags.rd && recursionAllowed && this.resolversFor(question.qname).length > 0) {
      return this.recurse(query);
    }
    if (outsideAuthority && question && !query.flags.rd && recursionAllowed) {
      const fromCache = this.answerWithoutRecursion(query);
      if (fromCache !== null) return fromCache;
    }
    return { ...response, flags: { ...response.flags, ra: recursionAllowed } };
  }

  private answerWithoutRecursion(query: DnsMessage): DnsMessage | null {
    const question = query.questions[0];
    const known = resolutionFromCache(this.cache.lookup(question.qname, question.qtype));
    if (known !== null) return buildRecursiveResponse(query, known, this.recursiveEnvelope(query));
    const hints = this.rootHints;
    if (hints === null) return null;
    return {
      id: query.id,
      flags: {
        qr: true, opcode: query.flags.opcode, aa: false, tc: false,
        rd: query.flags.rd, ra: true, ad: false, cd: query.flags.cd, rcode: DnsRcode.NOERROR,
      },
      questions: query.questions,
      answers: [],
      authorities: [...hints.ns],
      additionals: echoedOpt(query, this.config?.options.ednsUdpSize ?? DEFAULT_EDNS_UDP_SIZE),
    };
  }

  private handleUpdate(query: DnsMessage, sourceIP?: IPAddress | IPv6Address, raw?: Uint8Array): DnsMessage {
    const now = Math.floor(simulationNowMs() / 1000);
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
    const rendered = renderZoneFile(zone);
    this.files.write(named.file, rendered);
    this.loadedFiles.set(named.name, rendered);
    return { ok: true };
  }

  private serveTransfer(query: DnsMessage): DnsMessage[] {
    return serveZoneTransfer(this.store, query) ?? [this.refuse(query, false)];
  }

  private handleNotify(
    query: DnsMessage, sourceIP?: IPAddress | IPv6Address, sourcePort?: number, raw?: Uint8Array,
  ): DnsMessage {
    const now = Math.floor(simulationNowMs() / 1000);
    const auth = authorizeUpdate(raw, 'none', this.keyring, now);
    const client = `client @0x0 ${sourceIP?.toString() ?? LOOPBACK}#${sourcePort ?? 0}`;
    if (auth.failure !== null) {
      this.files.log?.(`${client}: request has invalid signature: TSIG ${auth.failure.keyName}: ${tsigFailureText(auth.failure)}`);
    }
    if (auth.rcode !== DnsRcode.NOERROR) {
      const refusal = makeNotifyAck(query);
      return signIfKeyed({ ...refusal, flags: { ...refusal.flags, rcode: auth.rcode } }, auth, now);
    }
    const qname = normalizeDnsName(query.questions[0]?.qname ?? '');
    const signer = auth.key === null ? '' : `/key ${auth.key.name}`;
    this.files.log?.(`${client}${signer}: received notify for zone '${qname}'${auth.key === null ? '' : `: TSIG '${auth.key.name}'`}`);
    const zone = this.config?.zones.find((z) => z.name === qname && z.type === 'secondary');
    const source = sourceIP?.toString();
    if (zone && source && zone.primaries.some((primary) => primary.address === source)) {
      void this.refreshSecondaryZone(zone);
    }
    return signIfKeyed(makeNotifyAck(query), auth, now);
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
      .map((primary) => IPAddress.tryParse(primary.address))
      .filter((ip): ip is IPAddress => ip !== null);
    const { zone: fetched } = await this.secondaries.refresh(
      this.store, zone.name, primaries, force, this.primaryKeysOf(zone), this.transferEndpointsOf(zone));
    if (!fetched) return false;
    this.loadedZones.set(zone.name, fetched.soa.data.serial);
    this.failedZones.delete(zone.name);
    return true;
  }

  private primaryKeysOf(zone: NamedZone): Map<string, TsigKey> {
    const keys = new Map<string, TsigKey>();
    for (const primary of zone.primaries) {
      const key = primary.key === null ? undefined : this.keyring.get(primary.key);
      if (key) keys.set(primary.address, key);
    }
    return keys;
  }

  private transferEndpointsOf(zone: NamedZone): Map<string, TransferEndpoint> {
    const endpoints = new Map<string, TransferEndpoint>();
    for (const primary of zone.primaries) {
      if (primary.port === null && primary.tls === null) continue;
      endpoints.set(primary.address, {
        port: primary.port,
        tls: primary.tls === null ? null : this.transferTlsOf(zone, primary),
      });
    }
    return endpoints;
  }

  private transferTlsOf(zone: NamedZone, primary: NamedRemoteServer): TransferTls {
    const profile = primary.tls === 'ephemeral' ? undefined : this.config?.tlsProfiles.get(primary.tls!);
    const caFile = profile?.caFile ?? null;
    const strict = caFile !== null || (profile?.remoteHostname ?? null) !== null;
    const caText = caFile === null ? null : this.readFile(caFile);
    const caChain = caText === null ? [] : pemToCertChain(caText);
    const origin = `transfer of '${zone.name}/IN' from ${primary.address}#${primary.port ?? DOT_PORT}`;
    return {
      anchors: !strict ? null : caFile === null ? this.files.systemAnchors?.() ?? [] : caChain,
      serverName: strict ? profile?.remoteHostname ?? primary.address : null,
      setupFailed: caFile !== null && caChain.length === 0,
      report: (failure) => {
        if (failure === 'verification') {
          this.files.log?.(`${origin}: failed to connect: TLS peer certificate verification failed`);
          this.files.log?.(`${origin}: Transfer status: TLS peer certificate verification failed`);
        } else {
          this.files.log?.(`${origin}: Transfer status: failure`);
          this.files.log?.(`${origin}: zone transfer setup failed`);
        }
      },
    };
  }

  private notifySecondaries(zoneName: string): void {
    const zone = this.config?.zones.find((z) => z.name === zoneName && z.type === 'primary');
    const loaded = this.store?.findZone(zoneName);
    if (!zone || !loaded || loaded.origin !== zoneName) return;
    void this.notifyTargets(zone, loaded).then((targets) => notifyZoneTargets(this.host, loaded, targets));
  }

  private async notifyTargets(zone: NamedZone, loaded: Zone): Promise<NotifyTarget[]> {
    const options = this.config!.options;
    const mode = zone.notify ?? options.notify;
    if (mode === 'no') return [];
    const targets = new Map<string, NotifyTarget>();
    if (mode !== 'explicit') {
      const toSoa = zone.notifyToSoa ?? options.notifyToSoa;
      const soaServer = normalizeDnsName(loaded.soa.data.mname);
      const own = new Set(this.aclEnvironment().localAddresses);
      for (const record of (loaded.getRRSet(loaded.origin, RRType.NS) ?? []) as ResourceRecord<NsRecordData>[]) {
        const server = normalizeDnsName(record.data.nsdname);
        if (server === soaServer && !toSoa) continue;
        for (const address of await this.addressesOfServer(loaded, server)) {
          if (!own.has(address.toString())) targets.set(`${address}#${DNS_PORT}`, { address });
        }
      }
    }
    for (const server of zone.alsoNotify ?? options.alsoNotify ?? []) {
      const target = this.notifyTargetOf(server);
      targets.set(`${target.address}#${target.port ?? DNS_PORT}`, target);
    }
    return [...targets.values()];
  }

  private notifyTargetOf(server: NamedRemoteServer): NotifyTarget {
    const key = server.key === null ? undefined : this.keyring.get(server.key);
    const port = server.port ?? (server.tls === null ? undefined : DOT_PORT);
    return {
      address: new IPAddress(server.address),
      ...(port === undefined ? {} : { port }),
      ...(key === undefined ? {} : { key }),
    };
  }

  private async addressesOfServer(zone: Zone, server: string): Promise<IPAddress[]> {
    const inZone = ((zone.getRRSet(server, RRType.A) ?? []) as ResourceRecord<ARecordData>[]).map((record) => record.data.address);
    if (inZone.length > 0 || this.resolvers.length === 0) return inZone;
    const resolved = await this.resolvers[0].resolve(server, RRType.A);
    return resolved.answers.filter((record): record is ResourceRecord<ARecordData> => record.data.type === RRType.A)
      .map((record) => record.data.address);
  }

  private async recurse(query: DnsMessage): Promise<DnsMessage> {
    const question = query.questions[0];
    const options = recursiveResolveOptions(query);
    const resolvers = this.resolversFor(question.qname);
    let result = await resolvers[0].resolve(question.qname, question.qtype, options);
    for (const next of resolvers.slice(1)) {
      if (result.status !== 'SERVFAIL') break;
      result = await next.resolve(question.qname, question.qtype, options);
    }
    return buildRecursiveResponse(query, this.asHeldByCache(question, result), this.recursiveEnvelope(query));
  }

  private asHeldByCache(question: DnsMessage['questions'][number], result: ResolutionResult): ResolutionResult {
    if (result.status === 'SERVFAIL' || result.answers.length > 0) return result;
    const held = resolutionFromCache(this.cache.lookup(question.qname, question.qtype));
    return held !== null && held.status === result.status && held.answers.length === 0 ? held : result;
  }

  private recursiveEnvelope(query: DnsMessage): RecursiveEnvelope {
    return {
      cache: this.cache,
      trim: this.positiveTrim(query.flags.rd),
      ednsPayloadSize: this.config?.options.ednsUdpSize ?? DEFAULT_EDNS_UDP_SIZE,
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
      additionals: echoedOpt(query, this.config?.options.ednsUdpSize ?? DEFAULT_EDNS_UDP_SIZE),
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
