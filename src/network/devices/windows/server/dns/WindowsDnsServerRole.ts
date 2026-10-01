import type { EndHost } from '@/network/devices/EndHost';
import { Zone, ZoneError } from '@/network/dns/zone/Zone';
import { ZoneStore, ZoneStoreError } from '@/network/dns/zone/ZoneStore';
import { reverseZoneNameFor, classlessOwnerFor } from '@/network/dns/zone/ReverseZoneNames';
import { renderZoneFile, parseZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { RecursiveResolver, type ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';
import { IANA_ROOT_HINTS, renderRootHintsFile, type RootHint } from '@/network/dns/resolver/RootHints';
import { DnsCache, type DnsCacheRecordView } from '@/network/dns/resolver/DnsCache';
import { bindDnsUdpServer, unbindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { isUpdateMessage } from '@/network/dns/update/DnsUpdate';
import {
  evaluateUpdate, updateResponse, parseOrFormerr, DnsUpdateRcode,
  authorizeUpdate, signIfKeyed,
} from '@/network/dns/update/UpdateResponder';
import { TsigKeyring, tsigKeyFromBase64 } from '@/network/dns/tsig/Tsig';
import { buildRecursiveResponse, recursiveResolveOptions } from '@/network/dns/resolver/RecursiveResponse';
import { makeDnskeyRecord } from '@/network/dns/wire/ResourceRecord';
import type { DsRecordData } from '@/network/dns/wire/ResourceRecord';
import { makeDsForKey, DNSKEY_FLAG_KSK, DnssecAlgorithm } from '@/network/dns/dnssec/DnsKey';
import { base64ToBytes } from '@/crypto/encoding';

const WINDOWS_CRYPTO_ALGORITHMS: ReadonlyMap<string, number> = new Map([
  ['rsasha1', DnssecAlgorithm.RSASHA1],
  ['rsasha256', DnssecAlgorithm.RSASHA256],
  ['ecdsap256sha256', DnssecAlgorithm.ECDSAP256SHA256],
]);
import { isTransferQuery, refuseTransfer } from '@/network/dns/transfer/AxfrSession';
import { isNotify, makeNotifyAck } from '@/network/dns/transfer/NotifyProtocol';
import { SecondaryZoneRefresher, notifyZoneTargets, serveZoneTransfer, datagramReply } from '@/network/dns/transfer/ZoneTransferHosting';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import { RRType } from '@/network/dns/wire/RRType';
import {
  makeARecord, makeAaaaRecord, makeCnameRecord, makePtrRecord, makeMxRecord, makeSrvRecord, makeSoaRecord,
  makeNsRecord, makeTxtRecord,
  type ResourceRecord, type ResourceRecordData, type SoaRecordData,
  type ARecordData, type AaaaRecordData, type CnameRecordData, type PtrRecordData, type MxRecordData,
  type SrvRecordData, type NsRecordData, type TxtRecordData, type DhcidRecordData, makeDhcidRecord,
} from '@/network/dns/wire/ResourceRecord';
import { dhcidToPresentation } from '@/network/dns/wire/Dhcid';
import { ptrQName } from '@/network/dns/compat/DnsWireCompat';
import { IPAddress } from '@/network/core/types';

export interface DnsOpResult { ok: boolean; message: string }

export type DnsDynamicUpdateMode = 'None' | 'NonsecureAndSecure' | 'Secure';
export type DnsZoneType = 'Primary' | 'Secondary' | 'Forwarder';
export type DnsTransferPolicy =
  'NoTransfer' | 'TransferToZoneNameServer' | 'TransferToSecureServers' | 'TransferAnyServer';
export type DnsNotifyPolicy = 'NoNotify' | 'Notify' | 'NotifyServers';

export const DNS_TRANSFER_POLICIES: readonly DnsTransferPolicy[] =
  ['NoTransfer', 'TransferToZoneNameServer', 'TransferToSecureServers', 'TransferAnyServer'];
export const DNS_NOTIFY_POLICIES: readonly DnsNotifyPolicy[] = ['NoNotify', 'Notify', 'NotifyServers'];

export interface DnsZoneInfo {
  name: string;
  type: DnsZoneType;
  recordCount: number;
  dynamicUpdate: DnsDynamicUpdateMode;
  zoneFile: string;
  isDsIntegrated: boolean;
  isReverse: boolean;
  isLoaded: boolean;
  serial: number | null;
  secureSecondaries: DnsTransferPolicy;
  secondaryServers: string[];
  notify: DnsNotifyPolicy;
  notifyServers: string[];
  masterServers: string[];
  lastZoneTransfer: number | null;
  isExpired: boolean;
}

export interface DnsZoneAgingInfo {
  name: string;
  agingEnabled: boolean;
  noRefreshSeconds: number;
  refreshSeconds: number;
  availableForScavengeMs: number | null;
  scavengeServers: string[];
}

export interface DnsScavengingInfo {
  scavengingEnabled: boolean;
  intervalSeconds: number;
  noRefreshSeconds: number;
  refreshSeconds: number;
  lastScavengeMs: number | null;
}

export interface DnsRecordOptions { age?: boolean; allowUpdateAny?: boolean }

export interface DnsRecordInfo {
  name: string;
  type: string;
  ttl: number;
  text: string;
  data: Record<string, string | number>;
  timestampMs: number | null;
}

export interface DnsRecordSpec { type: string; data: Record<string, string | number> }

export type DnsRootHintInfo = RootHint;

export interface DnsForwarderInfo { addresses: string[]; useRootHint: boolean; timeoutSeconds: number; enableReordering: boolean }

export interface DnsZoneFileSink {
  read(fileName: string): string | null;
  write(fileName: string, text: string): void;
  remove(fileName: string): void;
}

export interface DnsRoleEnvironment {
  now?: () => number;
  zoneFiles?: DnsZoneFileSink;
  directoryAvailable?: () => boolean;
}

export interface DnsPrimaryZoneOptions {
  dsIntegrated?: boolean;
  loadExisting?: boolean;
  adminEmail?: string;
  ttl?: number;
  networkId?: string;
  zoneFile?: string;
  dynamicUpdate?: DnsDynamicUpdateMode;
}

export interface DnsPrimaryZoneChanges {
  dynamicUpdate?: DnsDynamicUpdateMode;
  secureSecondaries?: DnsTransferPolicy;
  secondaryServers?: string[];
  notify?: DnsNotifyPolicy;
  notifyServers?: string[];
}

const DNS_PORT = 53;
const DEFAULT_FORWARDER_TIMEOUT_SECONDS = 3;
const DAY_SECONDS = 86400;
const DEFAULT_AGING_SECONDS = 7 * DAY_SECONDS;
const UNLOADED_RETRY_SECONDS = 600;

const RR_TYPE_NAME = new Map<number, string>(
  Object.entries(RRType).map(([name, code]) => [code, name]),
);

const RECORD_FIELDS: Record<string, readonly string[]> = {
  A: ['IPv4Address'],
  AAAA: ['IPv6Address'],
  CNAME: ['HostNameAlias'],
  PTR: ['PtrDomainName'],
  NS: ['NameServer'],
  MX: ['Preference', 'MailExchange'],
  SRV: ['Priority', 'Weight', 'Port', 'DomainName'],
  TXT: ['DescriptiveText'],
};

export function formatRecordFields(type: string, fields: Record<string, string | number>): string | null {
  switch (type.toUpperCase()) {
    case 'A': return String(fields.IPv4Address);
    case 'AAAA': return String(fields.IPv6Address);
    case 'CNAME': return String(fields.HostNameAlias);
    case 'PTR': return String(fields.PtrDomainName);
    case 'NS': return String(fields.NameServer);
    case 'TXT': return String(fields.DescriptiveText);
    case 'MX': return `[${fields.Preference}] ${fields.MailExchange}`;
    case 'SRV': return `[${fields.Priority}][${fields.Weight}] ${fields.Port} ${fields.DomainName}`;
    case 'SOA':
      return `[${fields.SerialNumber}][${fields.RefreshInterval}][${fields.RetryDelay}][${fields.ExpireLimit}][${fields.MinimumTimeToLive}] ${fields.PrimaryServer} ${fields.ResponsiblePerson}`;
    default: return null;
  }
}

function formatRecordData(rr: ResourceRecord<ResourceRecordData>): string {
  const fields = recordFields(rr);
  const typeName = RR_TYPE_NAME.get(rr.data.type) ?? '';
  const known = formatRecordFields(typeName, fields);
  if (known !== null) return known;
  return rr.data.type === RRType.DHCID
    ? dhcidToPresentation(rr.data as DhcidRecordData)
    : JSON.stringify(rr.data);
}

function recordFields(rr: ResourceRecord<ResourceRecordData>): Record<string, string | number> {
  switch (rr.data.type) {
    case RRType.A: return { IPv4Address: (rr.data as ARecordData).address.toString() };
    case RRType.AAAA: return { IPv6Address: (rr.data as AaaaRecordData).address.toString() };
    case RRType.CNAME: return { HostNameAlias: (rr.data as CnameRecordData).cname };
    case RRType.PTR: return { PtrDomainName: (rr.data as PtrRecordData).ptrdname };
    case RRType.NS: return { NameServer: (rr.data as NsRecordData).nsdname };
    case RRType.TXT: return { DescriptiveText: (rr.data as TxtRecordData).text.join('') };
    case RRType.MX: {
      const d = rr.data as MxRecordData;
      return { Preference: d.preference, MailExchange: d.exchange };
    }
    case RRType.SRV: {
      const d = rr.data as SrvRecordData;
      return { Priority: d.priority, Weight: d.weight, Port: d.port, DomainName: d.target };
    }
    case RRType.SOA: {
      const d = rr.data as SoaRecordData;
      return {
        PrimaryServer: d.mname, ResponsiblePerson: d.rname, SerialNumber: d.serial,
        RefreshInterval: d.refresh, RetryDelay: d.retry, ExpireLimit: d.expire, MinimumTimeToLive: d.minimum,
      };
    }
    default: return {};
  }
}

function buildRecord(fqdn: string, ttl: number, spec: DnsRecordSpec): ResourceRecord<ResourceRecordData> {
  const type = spec.type.toUpperCase();
  const fields = RECORD_FIELDS[type];
  if (!fields) throw new Error(`Record type "${spec.type}" is not supported by this DNS server.`);
  for (const field of fields) {
    const value = spec.data[field];
    if (value === undefined || value === '') {
      throw new Error(`The ${type} record data is missing "${field}".`);
    }
  }
  const text = (field: string): string => String(spec.data[field]);
  const number = (field: string): number => Number(spec.data[field]);
  switch (type) {
    case 'A': return makeARecord(fqdn, ttl, text('IPv4Address'));
    case 'AAAA': return makeAaaaRecord(fqdn, ttl, text('IPv6Address'));
    case 'CNAME': return makeCnameRecord(fqdn, ttl, text('HostNameAlias'));
    case 'PTR': return makePtrRecord(fqdn, ttl, text('PtrDomainName'));
    case 'NS': return makeNsRecord(fqdn, ttl, text('NameServer'));
    case 'TXT': return makeTxtRecord(fqdn, ttl, text('DescriptiveText'));
    case 'MX': return makeMxRecord(fqdn, ttl, number('Preference'), text('MailExchange'));
    default: return makeSrvRecord(fqdn, ttl, {
      priority: number('Priority'), weight: number('Weight'), port: number('Port'), target: text('DomainName'),
    });
  }
}

function sameFields(a: Record<string, string | number>, b: Record<string, string | number>): boolean {
  const keys = Object.keys(b);
  return keys.length > 0 && keys.every(k => normalizeValue(a[k]) === normalizeValue(b[k]));
}

function normalizeValue(value: string | number | undefined): string {
  return String(value ?? '').toLowerCase().replace(/\.$/, '');
}

function bumpSerial(zone: Zone): void {
  const d = zone.soa.data;
  zone.updateSoa(makeSoaRecord(zone.soa.name, zone.soa.ttl, {
    mname: d.mname, rname: d.rname, serial: d.serial + 1,
    refresh: d.refresh, retry: d.retry, expire: d.expire, minimum: d.minimum,
  }));
}

function recordKey(rr: ResourceRecord<ResourceRecordData>): string {
  return `${rr.name.toLowerCase()}|${rr.data.type}|${formatRecordData(rr)}`;
}

function normalizeZoneKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

const ZONE_NAME = /^[a-z0-9_][a-z0-9_/-]*(\.[a-z0-9_/-]+)*$/;

function zoneNameProblem(origin: string): string | null {
  return ZONE_NAME.test(origin) ? null : `"${origin}" is not a valid DNS zone name (letters, digits, "-" and "_" separated by dots).`;
}

function isUnder(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}

function parseAddresses(values: readonly string[]): IPAddress[] | string {
  const parsed: IPAddress[] = [];
  for (const value of values) {
    const ip = IPAddress.tryParse(value);
    if (!ip) return `"${value}" is not a valid IPv4 address.`;
    parsed.push(ip);
  }
  return parsed;
}

interface ZoneSettings {
  type: DnsZoneType;
  zoneFile: string;
  dsIntegrated: boolean;
  transfer: DnsTransferPolicy;
  secondaryServers: string[];
  notify: DnsNotifyPolicy;
  notifyServers: string[];
  masters: string[];
  lastTransferMs: number | null;
  nextRefreshMs: number | null;
  expired: boolean;
}

interface ZoneAging { enabled: boolean; noRefreshSeconds: number; refreshSeconds: number; availableAtMs: number | null; scavengeServers: string[] }

interface ReverseTarget { zone: Zone; owner: string; alias: { zone: Zone; name: string } | null }

interface ConditionalForwarder { masters: string[]; timeoutSeconds: number; useRecursion: boolean; zoneFile: string; resolver: RecursiveResolver }

interface ForwarderEntry { address: string; resolver: RecursiveResolver; averageMs: number | null; failures: number }

interface ResolutionAttempt { resolver: RecursiveResolver; report?: (elapsedMs: number, succeeded: boolean) => void }

export class WindowsDnsServerRole {
  private readonly store = new ZoneStore();
  private readonly authoritative = new AuthoritativeServer(this.store);
  private readonly cache: DnsCache;
  private readonly settings = new Map<string, ZoneSettings>();
  private readonly conditional = new Map<string, ConditionalForwarder>();
  private readonly secondaries: SecondaryZoneRefresher;
  private readonly keyring = new TsigKeyring();
  private readonly trustAnchors: ResourceRecord<DsRecordData>[] = [];
  private readonly trustAnchorKeys = new Map<string, { name: string; cryptoAlgorithm: string; base64: string }>();
  private readonly zoneDynamicUpdate = new Map<string, DnsDynamicUpdateMode>();
  private forwarders: ForwarderEntry[] = [];
  private enableReordering = true;
  private readonly aging = new Map<string, ZoneAging>();
  private readonly timestamps = new Map<string, number>();
  private readonly owners = new Map<string, string>();
  private readonly updatableByAny = new Set<string>();
  private scavengingEnabled = false;
  private scavengingIntervalSeconds = DEFAULT_AGING_SECONDS;
  private scavengeNoRefreshSeconds = DEFAULT_AGING_SECONDS;
  private scavengeRefreshSeconds = DEFAULT_AGING_SECONDS;
  private lastScavengeMs: number | null = null;
  private readonly startedAtMs: number;
  private forwarderTimeoutSeconds = DEFAULT_FORWARDER_TIMEOUT_SECONDS;
  private rootHints: RootHint[] = IANA_ROOT_HINTS.map(h => ({ ...h }));
  private rootResolver: RecursiveResolver | null = null;
  private useRootHint = true;
  private recursionEnabled = true;
  private running = false;

  private readonly now: () => number;
  private readonly zoneFiles: DnsZoneFileSink | null;
  private readonly directoryAvailable: () => boolean;

  constructor(private readonly host: EndHost, environment: DnsRoleEnvironment = {}) {
    this.now = environment.now ?? (() => Date.now());
    this.zoneFiles = environment.zoneFiles ?? null;
    this.directoryAvailable = environment.directoryAvailable ?? (() => false);
    this.cache = new DnsCache(this.now);
    this.startedAtMs = this.now();
    this.rootResolver = this.resolverOver(parseAddresses(this.rootHints.map(h => h.address)) as IPAddress[]);
    this.secondaries = new SecondaryZoneRefresher(host, (name, force) => { void this.refreshSecondary(name, force); });
  }

  isRunning(): boolean { return this.running; }

  getTsigKeyring(): TsigKeyring { return this.keyring; }

  start(): void {
    if (this.running) return;
    bindDnsUdpServer(this.host, this.handleUdp, DNS_PORT, 'dns');
    bindDnsTcpServer(this.host, this.handleTcp, DNS_PORT);
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    unbindDnsUdpServer(this.host, DNS_PORT);
    unbindDnsTcpServer(this.host, DNS_PORT);
    this.running = false;
  }

  tick(): void {
    const at = this.now();
    if (this.scavengingEnabled && at >= (this.lastScavengeMs ?? this.startedAtMs) + this.scavengingIntervalSeconds * 1000) {
      this.scavengeAll();
    }
    for (const [name, settings] of this.settings) {
      if (settings.type !== 'Secondary') continue;
      const zone = this.store.getZone(name);
      if (zone && settings.lastTransferMs !== null
        && at - settings.lastTransferMs >= zone.soa.data.expire * 1000) {
        this.store.removeZone(name);
        this.secondaries.discard(name);
        settings.expired = true;
        settings.nextRefreshMs = at;
      }
      if (settings.nextRefreshMs !== null && at >= settings.nextRefreshMs) {
        settings.nextRefreshMs = null;
        void this.refreshSecondary(name, false);
      }
    }
  }

  private readonly handleUdp = (
    query: DnsMessage, source?: unknown, _port?: number, raw?: Uint8Array,
  ): DnsMessage | Promise<DnsMessage> => datagramReply(this.answer(query, 'udp', source, raw));

  private readonly handleTcp = (
    query: DnsMessage, source?: unknown, _port?: number, raw?: Uint8Array,
  ): DnsMessage | DnsMessage[] | Promise<DnsMessage> => this.answer(query, 'tcp', source, raw);

  private answer(
    query: DnsMessage, transport: 'udp' | 'tcp', source: unknown, raw?: Uint8Array,
  ): DnsMessage | DnsMessage[] | Promise<DnsMessage> {
    const sourceAddress = source instanceof IPAddress ? source.toString() : null;
    if (isNotify(query)) return this.handleNotify(query, sourceAddress);
    if (isUpdateMessage(query)) return this.handleUpdate(query, raw);
    if (isTransferQuery(query)) {
      return transport === 'udp' ? refuseTransfer(query) : this.handleTransfer(query, sourceAddress);
    }
    const response = this.authoritative.answer(query);
    const question = query.questions[0];
    const outsideAuthority = !response.flags.aa && response.flags.rcode === DnsRcode.REFUSED;
    if (outsideAuthority && question && this.hitsUnloadedSecondary(question.qname)) {
      return { ...response, flags: { ...response.flags, rcode: DnsRcode.SERVFAIL } };
    }
    if (outsideAuthority && question && query.flags.rd && this.recursionEnabled) {
      const resolvers = this.resolversFor(question.qname);
      if (resolvers.length > 0) return this.recurse(query, resolvers);
    }
    return response;
  }

  private hitsUnloadedSecondary(qname: string): boolean {
    const name = normalizeDnsName(qname);
    for (const [zone, settings] of this.settings) {
      if (settings.type === 'Secondary' && !this.store.getZone(zone) && isUnder(name, zone)) return true;
    }
    return false;
  }

  private resolversFor(qname: string): ResolutionAttempt[] {
    const name = normalizeDnsName(qname);
    let best: string | null = null;
    for (const zone of this.conditional.keys()) {
      if (isUnder(name, zone) && (best === null || zone.length > best.length)) best = zone;
    }
    if (best !== null) return [{ resolver: this.conditional.get(best)!.resolver }];
    const attempts: ResolutionAttempt[] = this.orderedForwarders().map(entry => ({
      resolver: entry.resolver,
      report: (elapsedMs, succeeded) => {
        if (succeeded) {
          entry.failures = 0;
          entry.averageMs = entry.averageMs === null ? elapsedMs : (entry.averageMs + elapsedMs) / 2;
        } else {
          entry.failures++;
        }
      },
    }));
    if (this.useRootHint && this.rootResolver) attempts.push({ resolver: this.rootResolver });
    return attempts;
  }

  private orderedForwarders(): ForwarderEntry[] {
    if (!this.enableReordering) return this.forwarders;
    return [...this.forwarders].sort((a, b) =>
      a.failures - b.failures || (a.averageMs ?? Infinity) - (b.averageMs ?? Infinity));
  }

  private handleTransfer(query: DnsMessage, source: string | null): DnsMessage | DnsMessage[] {
    const qname = normalizeDnsName(query.questions[0].qname);
    const settings = this.settings.get(qname);
    const zone = this.store.getZone(qname);
    if (!settings || settings.type === 'Forwarder' || !zone || !this.transferAllowed(settings, zone, source)) {
      return refuseTransfer(query);
    }
    return serveZoneTransfer(this.store, query) ?? refuseTransfer(query);
  }

  private transferAllowed(settings: ZoneSettings, zone: Zone, source: string | null): boolean {
    if (source === null) return false;
    switch (settings.transfer) {
      case 'TransferAnyServer': return true;
      case 'TransferToSecureServers': return settings.secondaryServers.includes(source);
      case 'TransferToZoneNameServer': return this.nameServerAddresses(zone).includes(source);
      default: return false;
    }
  }

  private nameServerAddresses(zone: Zone): string[] {
    const addresses: string[] = [];
    for (const ns of zone.getRRSet(zone.origin, RRType.NS) ?? []) {
      const target = normalizeDnsName((ns.data as NsRecordData).nsdname);
      for (const a of this.store.findZone(target)?.getRRSet(target, RRType.A) ?? []) {
        addresses.push((a.data as ARecordData).address.toString());
      }
    }
    return addresses;
  }

  private localAddresses(): string[] {
    return this.host.getPorts().map(port => port.getIPAddress()?.toString()).filter((a): a is string => !!a);
  }

  private handleNotify(query: DnsMessage, source: string | null): DnsMessage {
    const ack = makeNotifyAck(query);
    const name = normalizeDnsName(query.questions[0]?.qname ?? '');
    const settings = this.settings.get(name);
    if (settings?.type !== 'Secondary' || source === null || !settings.masters.includes(source)) {
      return { ...ack, flags: { ...ack.flags, rcode: DnsRcode.REFUSED } };
    }
    void this.refreshSecondary(name, false);
    return ack;
  }

  private handleUpdate(query: DnsMessage, raw?: Uint8Array): DnsMessage {
    const now = Math.floor(Date.now() / 1000);
    const request = parseOrFormerr(query);
    const mode = request ? this.dynamicUpdateMode(request.zone) : 'NonsecureAndSecure';
    const auth = authorizeUpdate(raw, mode === 'Secure' ? 'secure' : 'none', this.keyring, now);
    if (mode === 'None') {
      return signIfKeyed(updateResponse(query, DnsRcode.REFUSED), auth, now);
    }
    const reply = (rcode: number): DnsMessage =>
      signIfKeyed(updateResponse(query, rcode), auth, now);

    if (auth.rcode !== DnsRcode.NOERROR) return reply(auth.rcode);
    if (!request) return reply(DnsRcode.FORMERR);

    const zone = this.store.getZone(request.zone);
    if (!zone) return reply(DnsUpdateRcode.NOTAUTH);

    const verdict = evaluateUpdate(zone, request);
    if (verdict.rcode !== DnsRcode.NOERROR) return reply(verdict.rcode);

    const owner = auth.key?.name ?? null;
    if (owner !== null) {
      const foreign = verdict.applied.removals.some(rr => {
        const key = recordKey(rr);
        return this.owners.get(key) !== owner && !this.updatableByAny.has(key);
      });
      if (foreign) return reply(DnsRcode.REFUSED);
    }
    for (const rr of verdict.applied.removals) this.deleteRecord(zone, rr);
    for (const rr of verdict.applied.additions) {
      zone.addRecord(rr);
      this.claimDynamic(zone, rr, owner);
    }
    for (const rr of verdict.applied.refreshed) this.claimDynamic(zone, rr, owner);
    if (verdict.applied.soa) zone.updateSoa(verdict.applied.soa);
    if (verdict.applied.removals.length > 0 || verdict.applied.additions.length > 0 || verdict.applied.soa) {
      this.zoneChanged(zone);
    }
    return reply(DnsRcode.NOERROR);
  }

  private async recurse(query: DnsMessage, attempts: readonly ResolutionAttempt[]): Promise<DnsMessage> {
    const question = query.questions[0];
    const options = recursiveResolveOptions(query);
    let result = await this.attempt(attempts[0], question.qname, question.qtype, options);
    for (const next of attempts.slice(1)) {
      if (result.status !== 'SERVFAIL') break;
      result = await this.attempt(next, question.qname, question.qtype, options);
    }
    return buildRecursiveResponse(query, result);
  }

  private async attempt(
    attempt: ResolutionAttempt, qname: string, qtype: number,
    options: { readonly checkingDisabled?: boolean } = {},
  ): Promise<ResolutionResult> {
    const started = performance.now();
    const result = await attempt.resolver.resolve(qname, qtype, options);
    attempt.report?.(performance.now() - started, result.status !== 'SERVFAIL');
    return result;
  }

  private deleteRecord(zone: Zone, rr: ResourceRecord<ResourceRecordData>): void {
    zone.removeRecord(rr);
    const key = recordKey(rr);
    this.timestamps.delete(key);
    this.owners.delete(key);
    this.updatableByAny.delete(key);
  }

  private stamp(rr: ResourceRecord<ResourceRecordData>): void {
    this.timestamps.set(recordKey(rr), this.now());
  }

  private claimDynamic(zone: Zone, rr: ResourceRecord<ResourceRecordData>, owner: string | null): void {
    const key = recordKey(rr);
    if (owner !== null) this.owners.set(key, owner);
    const noRefreshMs = (this.aging.get(zone.origin)?.noRefreshSeconds ?? this.scavengeNoRefreshSeconds) * 1000;
    const stamped = this.timestamps.get(key);
    if (stamped === undefined || this.now() >= stamped + noRefreshMs) this.stamp(rr);
  }

  private zoneChanged(zone: Zone): void {
    bumpSerial(zone);
    this.persist(zone);
    this.notifyPeers(zone);
  }

  private persist(zone: Zone): void {
    const settings = this.settings.get(zone.origin);
    if (settings && !settings.dsIntegrated && this.zoneFiles) this.zoneFiles.write(settings.zoneFile, renderZoneFile(zone));
  }

  private notifyPeers(zone: Zone): void {
    const settings = this.settings.get(zone.origin);
    if (!settings || settings.type === 'Forwarder' || settings.notify === 'NoNotify') return;
    const own = this.localAddresses();
    const wanted = settings.notify === 'NotifyServers' ? settings.notifyServers : this.nameServerAddresses(zone);
    const targets = wanted
      .filter(address => !own.includes(address) && !settings.masters.includes(address))
      .map(address => IPAddress.tryParse(address))
      .filter((ip): ip is IPAddress => ip !== null);
    notifyZoneTargets(this.host, zone, targets);
  }

  private async refreshSecondary(name: string, force: boolean): Promise<boolean> {
    const settings = this.settings.get(name);
    if (settings?.type !== 'Secondary' || !this.running) return false;
    const masters = parseAddresses(settings.masters);
    if (typeof masters === 'string') return false;
    const serialBefore = this.store.getZone(name)?.soa.data.serial;
    const outcome = await this.secondaries.refresh(this.store, name, masters, force);
    if (outcome.deferred) return false;
    if (!this.settings.has(name)) {
      this.store.removeZone(name);
      return false;
    }
    const at = this.now();
    const zone = this.store.getZone(name);
    if (outcome.succeeded) {
      settings.lastTransferMs = at;
      settings.expired = false;
      if (zone) {
        this.persist(zone);
        if (zone.soa.data.serial !== serialBefore) this.notifyPeers(zone);
        settings.nextRefreshMs = at + zone.soa.data.refresh * 1000;
      }
    } else {
      settings.nextRefreshMs = at + (zone ? zone.soa.data.retry : UNLOADED_RETRY_SECONDS) * 1000;
    }
    return outcome.succeeded;
  }

  setForwarders(addresses: readonly string[]): DnsOpResult {
    const parsed = parseAddresses(addresses);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    this.forwarders = addresses.map((address, index) => {
      const known = this.forwarders.find(f => f.address === address);
      return known ?? { address, resolver: this.forwardingResolver([parsed[index]]), averageMs: null, failures: 0 };
    });
    return { ok: true, message: '' };
  }

  addForwarders(addresses: readonly string[]): DnsOpResult {
    return this.setForwarders([...this.getForwarders(), ...addresses.filter(a => !this.getForwarders().includes(a))]);
  }

  removeForwarders(addresses: readonly string[]): DnsOpResult {
    const missing = addresses.find(a => !this.getForwarders().includes(a));
    if (missing !== undefined) return { ok: false, message: `"${missing}" is not a configured forwarder.` };
    return this.setForwarders(this.getForwarders().filter(a => !addresses.includes(a)));
  }

  setForwarderTimeout(seconds: number): DnsOpResult {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 15) {
      return { ok: false, message: 'The forwarder timeout must be between 1 and 15 seconds.' };
    }
    this.forwarderTimeoutSeconds = seconds;
    const current = this.getForwarders();
    this.forwarders = [];
    return this.setForwarders(current);
  }

  setEnableReordering(enabled: boolean): DnsOpResult {
    this.enableReordering = enabled;
    return { ok: true, message: '' };
  }

  private forwardingResolver(addresses: readonly IPAddress[], timeoutSeconds = this.forwarderTimeoutSeconds): RecursiveResolver {
    return new RecursiveResolver(this.host, addresses, this.cache, { timeoutMs: timeoutSeconds * 1000, forwardRecursively: true, dnssec: { anchors: this.trustAnchors } });
  }

  private resolverOver(addresses: readonly IPAddress[], timeoutSeconds = this.forwarderTimeoutSeconds): RecursiveResolver {
    return new RecursiveResolver(this.host, addresses, this.cache, { timeoutMs: timeoutSeconds * 1000, dnssec: { anchors: this.trustAnchors } });
  }

  getForwarders(): string[] { return this.forwarders.map(f => f.address); }

  getForwarderInfo(): DnsForwarderInfo {
    return {
      addresses: this.getForwarders(), useRootHint: this.useRootHint, timeoutSeconds: this.forwarderTimeoutSeconds,
      enableReordering: this.enableReordering,
    };
  }

  setUseRootHint(enabled: boolean): DnsOpResult {
    this.useRootHint = enabled;
    return { ok: true, message: '' };
  }

  getRootHints(): DnsRootHintInfo[] { return this.rootHints.map(h => ({ ...h })); }

  private rootHintsChanged(): void {
    const parsed = parseAddresses([...new Set(this.rootHints.map(h => h.address))]);
    this.rootResolver = typeof parsed !== 'string' && parsed.length > 0 ? this.resolverOver(parsed) : null;
    this.zoneFiles?.write('cache.dns', renderRootHintsFile(this.rootHints));
  }

  private hintName(name: string): string {
    const lower = name.toLowerCase();
    return lower.endsWith('.') ? lower : `${lower}.`;
  }

  addRootHint(nameServer: string, address: string): DnsOpResult {
    const name = this.hintName(nameServer);
    if (!ZONE_NAME.test(name.slice(0, -1))) return { ok: false, message: `"${nameServer}" is not a valid name server name.` };
    const parsed = parseAddresses([address]);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    if (this.rootHints.some(h => h.name === name && h.address === address)) {
      return { ok: false, message: `The root hint "${nameServer}" ${address} already exists.` };
    }
    this.rootHints.push({ name, address });
    this.rootHintsChanged();
    return { ok: true, message: '' };
  }

  removeRootHint(nameServer: string, address?: string): DnsOpResult {
    const name = this.hintName(nameServer);
    const kept = this.rootHints.filter(h => !(h.name === name && (address === undefined || h.address === address)));
    if (kept.length === this.rootHints.length) return { ok: false, message: `Cannot find the root hint "${nameServer}"${address ? ` ${address}` : ''}.` };
    this.rootHints = kept;
    this.rootHintsChanged();
    return { ok: true, message: '' };
  }

  setRootHint(nameServer: string, addresses: readonly string[]): DnsOpResult {
    const name = this.hintName(nameServer);
    if (!this.rootHints.some(h => h.name === name)) return { ok: false, message: `Cannot find the root hint "${nameServer}".` };
    const parsed = parseAddresses(addresses);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    if (addresses.length === 0) return { ok: false, message: 'A root hint needs at least one IP address.' };
    this.rootHints = [...this.rootHints.filter(h => h.name !== name), ...addresses.map(address => ({ name, address }))];
    this.rootHintsChanged();
    return { ok: true, message: '' };
  }

  importRootHints(): DnsOpResult {
    const sources = parseAddresses([...new Set([...this.rootHints.map(h => h.address), ...this.getForwarders()])]);
    if (typeof sources === 'string' || sources.length === 0) return { ok: false, message: 'No server is known to import root hints from.' };
    void this.fetchRootHints(sources);
    return { ok: true, message: '' };
  }

  private async fetchRootHints(sources: readonly IPAddress[]): Promise<void> {
    const resolver = new RecursiveResolver(this.host, sources, new DnsCache(this.now), { timeoutMs: 2000 });
    const roots = await resolver.resolve('.', RRType.NS);
    const names = roots.answers.filter(rr => rr.data.type === RRType.NS).map(rr => (rr.data as NsRecordData).nsdname);
    const fetched: RootHint[] = [];
    for (const name of names) {
      const answer = await resolver.resolve(name, RRType.A);
      for (const rr of answer.answers) {
        if (rr.data.type === RRType.A) fetched.push({ name: this.hintName(name), address: (rr.data as ARecordData).address.toString() });
      }
    }
    if (fetched.length === 0) return;
    this.rootHints = fetched;
    this.rootHintsChanged();
  }

  private agingOf(origin: string): ZoneAging {
    let aging = this.aging.get(origin);
    if (!aging) {
      aging = {
        enabled: false, noRefreshSeconds: this.scavengeNoRefreshSeconds, refreshSeconds: this.scavengeRefreshSeconds,
        availableAtMs: null, scavengeServers: [],
      };
      this.aging.set(origin, aging);
    }
    return aging;
  }

  setZoneAging(
    name: string,
    changes: { aging?: boolean; noRefreshSeconds?: number; refreshSeconds?: number; scavengeServers?: string[] },
  ): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const settings = this.settings.get(origin);
    if (settings?.type !== 'Primary') return { ok: false, message: `Aging applies to primary zones: "${name}" is not one on this server.` };
    for (const seconds of [changes.noRefreshSeconds, changes.refreshSeconds]) {
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 3600)) {
        return { ok: false, message: 'An aging interval must be at least one hour.' };
      }
    }
    const servers = changes.scavengeServers ? parseAddresses(changes.scavengeServers) : [];
    if (typeof servers === 'string') return { ok: false, message: servers };
    const aging = this.agingOf(origin);
    if (changes.noRefreshSeconds !== undefined) aging.noRefreshSeconds = changes.noRefreshSeconds;
    if (changes.refreshSeconds !== undefined) aging.refreshSeconds = changes.refreshSeconds;
    if (changes.scavengeServers) aging.scavengeServers = [...changes.scavengeServers];
    if (changes.aging !== undefined && changes.aging !== aging.enabled) {
      aging.enabled = changes.aging;
      aging.availableAtMs = changes.aging ? this.now() + (aging.noRefreshSeconds + aging.refreshSeconds) * 1000 : null;
    }
    return { ok: true, message: '' };
  }

  getZoneAging(name: string): DnsZoneAgingInfo | null {
    const origin = normalizeZoneKey(name);
    if (this.settings.get(origin)?.type !== 'Primary') return null;
    const aging = this.agingOf(origin);
    return {
      name: origin, agingEnabled: aging.enabled, noRefreshSeconds: aging.noRefreshSeconds,
      refreshSeconds: aging.refreshSeconds, availableForScavengeMs: aging.availableAtMs, scavengeServers: [...aging.scavengeServers],
    };
  }

  setScavenging(changes: {
    enabled?: boolean; intervalSeconds?: number; noRefreshSeconds?: number; refreshSeconds?: number;
    lastScavengeMs?: number; applyOnAllZones?: boolean;
  }): DnsOpResult {
    for (const seconds of [changes.intervalSeconds, changes.noRefreshSeconds, changes.refreshSeconds]) {
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 3600)) {
        return { ok: false, message: 'A scavenging interval must be at least one hour.' };
      }
    }
    if (changes.enabled !== undefined) this.scavengingEnabled = changes.enabled;
    if (changes.intervalSeconds !== undefined) this.scavengingIntervalSeconds = changes.intervalSeconds;
    if (changes.noRefreshSeconds !== undefined) this.scavengeNoRefreshSeconds = changes.noRefreshSeconds;
    if (changes.refreshSeconds !== undefined) this.scavengeRefreshSeconds = changes.refreshSeconds;
    if (changes.lastScavengeMs !== undefined) this.lastScavengeMs = changes.lastScavengeMs;
    if (changes.applyOnAllZones) {
      for (const [origin, settings] of this.settings) {
        if (settings.type !== 'Primary') continue;
        const aging = this.agingOf(origin);
        aging.noRefreshSeconds = this.scavengeNoRefreshSeconds;
        aging.refreshSeconds = this.scavengeRefreshSeconds;
      }
    }
    return { ok: true, message: '' };
  }

  getScavenging(): DnsScavengingInfo {
    return {
      scavengingEnabled: this.scavengingEnabled, intervalSeconds: this.scavengingIntervalSeconds,
      noRefreshSeconds: this.scavengeNoRefreshSeconds, refreshSeconds: this.scavengeRefreshSeconds,
      lastScavengeMs: this.lastScavengeMs,
    };
  }

  startScavenging(): number {
    return this.scavengeAll();
  }

  private scavengeAll(): number {
    const at = this.now();
    let removed = 0;
    for (const [origin, settings] of this.settings) {
      if (settings.type === 'Primary') removed += this.scavengeZone(origin, at);
    }
    this.lastScavengeMs = at;
    return removed;
  }

  private scavengeZone(origin: string, at: number): number {
    const aging = this.aging.get(origin);
    const zone = this.store.getZone(origin);
    if (!aging?.enabled || !zone || aging.availableAtMs === null || at < aging.availableAtMs) return 0;
    if (aging.scavengeServers.length > 0 && !aging.scavengeServers.some(a => this.localAddresses().includes(a))) return 0;
    const lifetimeMs = (aging.noRefreshSeconds + aging.refreshSeconds) * 1000;
    const stale = zone.allRecords().filter(rr => {
      const stamped = this.timestamps.get(recordKey(rr));
      return stamped !== undefined && at >= stamped + lifetimeMs;
    });
    for (const rr of stale) this.deleteRecord(zone, rr);
    if (stale.length > 0) this.zoneChanged(zone);
    return stale.length;
  }

  setRecursion(enabled: boolean): DnsOpResult {
    this.recursionEnabled = enabled;
    return { ok: true, message: '' };
  }

  isRecursionEnabled(): boolean { return this.recursionEnabled; }

  cacheEntries(): DnsCacheRecordView[] {
    return this.cache.entries().filter(entry => !entry.negative);
  }

  clearCache(): void { this.cache.flush(); }

  private zoneNameConflict(origin: string): DnsOpResult | null {
    const problem = origin === '' ? null : zoneNameProblem(origin);
    if (problem) return { ok: false, message: problem };
    if (this.settings.has(origin) || this.conditional.has(origin)) {
      return { ok: false, message: `A zone named "${origin}" is already configured on this server.` };
    }
    return null;
  }

  private newSettings(type: DnsZoneType, origin: string, zoneFile?: string, dsIntegrated = false): ZoneSettings {
    return {
      type, zoneFile: dsIntegrated ? '' : zoneFile || `${origin}.dns`, dsIntegrated,
      transfer: 'TransferToZoneNameServer', secondaryServers: [],
      notify: 'Notify', notifyServers: [], masters: [],
      lastTransferMs: null, nextRefreshMs: null, expired: false,
    };
  }

  addPrimaryZone(name: string, opts: DnsPrimaryZoneOptions = {}): DnsOpResult {
    const isRoot = name.trim() === '.';
    let origin = normalizeZoneKey(name);
    if (opts.networkId !== undefined) {
      const reverse = reverseZoneNameFor(opts.networkId);
      if ('error' in reverse) return { ok: false, message: reverse.error };
      origin = reverse.name;
    }
    if (!origin && !isRoot) return { ok: false, message: 'Cannot process command because of one or more missing mandatory parameters: Name.' };
    const conflict = this.zoneNameConflict(origin);
    if (conflict) return { ok: false, message: conflict.message.replace(origin, name || origin) };
    if (opts.loadExisting && opts.dsIntegrated) {
      return { ok: false, message: '-LoadExisting reads a zone file and cannot be combined with a directory-integrated zone.' };
    }
    if (opts.dsIntegrated && !this.directoryAvailable()) {
      return { ok: false, message: 'Directory-integrated zones need a domain controller: no Active Directory partition is hosted on this server.' };
    }
    const ttl = opts.ttl ?? 3600;
    const mname = `ns1.${origin}`;
    const rname = (opts.adminEmail ?? `hostmaster.${origin}`).replace('@', '.');
    try {
      const settingsToUse = this.newSettings('Primary', origin, opts.zoneFile, opts.dsIntegrated);
      const zone = opts.loadExisting
        ? this.zoneFromFile(origin, settingsToUse.zoneFile)
        : new Zone(origin, makeSoaRecord(origin, ttl, {
          mname, rname, serial: 1, refresh: 900, retry: 600, expire: 86400, minimum: ttl,
        }));
      if (typeof zone === 'string') return { ok: false, message: zone };
      this.store.addZone(zone);
      this.settings.set(origin, settingsToUse);
      if (opts.dynamicUpdate) this.zoneDynamicUpdate.set(origin, opts.dynamicUpdate);
      this.persist(zone);
      return { ok: true, message: '' };
    } catch (e) {
      if (e instanceof ZoneError || e instanceof ZoneStoreError) return { ok: false, message: e.message };
      throw e;
    }
  }

  private zoneFromFile(origin: string, fileName: string): Zone | string {
    const text = this.zoneFiles?.read(fileName) ?? null;
    if (text === null) return `The zone file "${fileName}" does not exist in C:\\Windows\\System32\\dns.`;
    try {
      const zone = parseZoneFile(text, origin);
      return zone.origin === origin ? zone : `The zone file "${fileName}" describes "${zone.origin}", not "${origin}".`;
    } catch (e) {
      if (e instanceof ZoneFileError || e instanceof ZoneError) return `The zone file "${fileName}" is invalid: ${e.message}`;
      throw e;
    }
  }

  addSecondaryZone(name: string, masters: readonly string[], zoneFile?: string, loadExisting = false): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const parsed = parseAddresses(masters);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    if (parsed.length === 0) return { ok: false, message: 'A secondary zone needs at least one master server.' };
    const conflict = this.zoneNameConflict(origin);
    if (conflict) return conflict;
    const settings = this.newSettings('Secondary', origin, zoneFile);
    settings.masters = [...masters];
    settings.nextRefreshMs = this.now();
    if (loadExisting) {
      const loaded = this.zoneFromFile(origin, settings.zoneFile);
      if (typeof loaded === 'string') return { ok: false, message: loaded };
      this.store.addZone(loaded);
      settings.lastTransferMs = this.now();
      settings.nextRefreshMs = this.now() + loaded.soa.data.refresh * 1000;
    }
    this.settings.set(origin, settings);
    if (!loadExisting) void this.refreshSecondary(origin, false);
    return { ok: true, message: '' };
  }

  addConditionalForwarderZone(name: string, masters: readonly string[], timeoutSeconds = this.forwarderTimeoutSeconds, useRecursion = true, zoneFile?: string): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const parsed = parseAddresses(masters);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    if (parsed.length === 0) return { ok: false, message: 'A conditional forwarder needs at least one master server.' };
    const conflict = this.zoneNameConflict(origin);
    if (conflict) return conflict;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 15) {
      return { ok: false, message: 'The forwarder timeout must be between 1 and 15 seconds.' };
    }
    this.conditional.set(origin, {
      masters: [...masters], timeoutSeconds, useRecursion, zoneFile: zoneFile || `${origin}.dns`,
      resolver: useRecursion ? this.forwardingResolver(parsed, timeoutSeconds) : this.resolverOver(parsed, timeoutSeconds),
    });
    const created = this.conditional.get(origin)!;
    this.zoneFiles?.write(created.zoneFile, created.masters.map(master => `MasterServer ${master}`).join('\n') + '\n');
    return { ok: true, message: '' };
  }

  setConditionalForwarderMasters(name: string, masters: readonly string[] | undefined, timeoutSeconds?: number, useRecursion?: boolean): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const current = this.conditional.get(origin);
    if (!current) return { ok: false, message: `Zone "${name}" is not a conditional forwarder zone.` };
    this.conditional.delete(origin);
    const res = this.addConditionalForwarderZone(origin, masters ?? current.masters, timeoutSeconds ?? current.timeoutSeconds, useRecursion ?? current.useRecursion, current.zoneFile);
    if (!res.ok) this.conditional.set(origin, current);
    return res;
  }

  renameZoneFile(name: string, zoneFile: string): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const settings = this.settings.get(origin);
    if (!settings) return { ok: false, message: `Zone "${name}" does not exist on this server.` };
    if (settings.dsIntegrated) return { ok: false, message: `Zone "${name}" is directory-integrated and has no zone file.` };
    const previous = settings.zoneFile;
    settings.zoneFile = zoneFile;
    const zone = this.store.getZone(origin);
    if (zone) this.persist(zone);
    if (previous !== zoneFile) this.zoneFiles?.remove(previous);
    return { ok: true, message: '' };
  }

  setPrimaryZone(name: string, changes: DnsPrimaryZoneChanges): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const settings = this.settings.get(origin);
    if (!settings || settings.type !== 'Primary') return { ok: false, message: `"${name}" is not a primary zone on this server.` };
    for (const list of [changes.secondaryServers, changes.notifyServers]) {
      const parsed = list ? parseAddresses(list) : [];
      if (typeof parsed === 'string') return { ok: false, message: parsed };
    }
    if (changes.dynamicUpdate) this.zoneDynamicUpdate.set(origin, changes.dynamicUpdate);
    if (changes.secureSecondaries) settings.transfer = changes.secureSecondaries;
    if (changes.secondaryServers) settings.secondaryServers = [...changes.secondaryServers];
    if (changes.notify) settings.notify = changes.notify;
    if (changes.notifyServers) settings.notifyServers = [...changes.notifyServers];
    return { ok: true, message: '' };
  }

  setSecondaryZone(name: string, changes: { masters?: string[]; secureSecondaries?: DnsTransferPolicy; secondaryServers?: string[]; notify?: DnsNotifyPolicy; notifyServers?: string[] }): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const settings = this.settings.get(origin);
    if (settings?.type !== 'Secondary') return { ok: false, message: `"${name}" is not a secondary zone on this server.` };
    for (const list of [changes.masters, changes.secondaryServers, changes.notifyServers]) {
      const parsed = list ? parseAddresses(list) : [];
      if (typeof parsed === 'string') return { ok: false, message: parsed };
    }
    if (changes.masters) {
      if (changes.masters.length === 0) return { ok: false, message: 'A secondary zone needs at least one master server.' };
      settings.masters = [...changes.masters];
      this.secondaries.discard(origin);
    }
    if (changes.secureSecondaries) settings.transfer = changes.secureSecondaries;
    if (changes.secondaryServers) settings.secondaryServers = [...changes.secondaryServers];
    if (changes.notify) settings.notify = changes.notify;
    if (changes.notifyServers) settings.notifyServers = [...changes.notifyServers];
    return { ok: true, message: '' };
  }

  startZoneTransfer(name: string): DnsOpResult {
    const origin = normalizeZoneKey(name);
    if (this.settings.get(origin)?.type !== 'Secondary') {
      return { ok: false, message: `"${name}" is not a secondary zone on this server.` };
    }
    void this.refreshSecondary(origin, true);
    return { ok: true, message: '' };
  }

  removeZone(name: string): DnsOpResult {
    const origin = normalizeZoneKey(name);
    const forwarder = this.conditional.get(origin);
    if (forwarder) {
      this.conditional.delete(origin);
      this.zoneFiles?.remove(forwarder.zoneFile);
      return { ok: true, message: '' };
    }
    const settings = this.settings.get(origin);
    if (!settings) return { ok: false, message: `Zone "${name}" does not exist.` };
    for (const rr of this.store.getZone(origin)?.allRecords() ?? []) this.deleteRecord(this.store.getZone(origin)!, rr);
    this.store.removeZone(origin);
    this.aging.delete(origin);
    this.settings.delete(origin);
    this.zoneDynamicUpdate.delete(origin);
    this.secondaries.discard(origin);
    if (!settings.dsIntegrated) this.zoneFiles?.remove(settings.zoneFile);
    return { ok: true, message: '' };
  }

  getZone(name: string): DnsZoneInfo | null {
    return this.zoneInfoByName(normalizeZoneKey(name));
  }

  listZones(): DnsZoneInfo[] {
    return [...this.settings.keys(), ...this.conditional.keys()]
      .map(name => this.zoneInfoByName(name)!);
  }

  private zoneInfoByName(name: string): DnsZoneInfo | null {
    const forwarder = this.conditional.get(name);
    if (forwarder) {
      return {
        name, type: 'Forwarder', recordCount: 0, dynamicUpdate: 'None', zoneFile: forwarder.zoneFile, isDsIntegrated: false, isReverse: false,
        isLoaded: true, serial: null, secureSecondaries: 'NoTransfer', secondaryServers: [],
        notify: 'NoNotify', notifyServers: [], masterServers: [...forwarder.masters],
        lastZoneTransfer: null, isExpired: false,
      };
    }
    const settings = this.settings.get(name);
    if (!settings) return null;
    const zone = this.store.getZone(name);
    return {
      name, type: settings.type, recordCount: zone?.allRecords().length ?? 0,
      dynamicUpdate: this.dynamicUpdateMode(name), zoneFile: settings.zoneFile, isDsIntegrated: settings.dsIntegrated,
      isReverse: name.endsWith('.arpa'), isLoaded: zone !== null, serial: zone?.soa.data.serial ?? null,
      secureSecondaries: settings.transfer, secondaryServers: [...settings.secondaryServers],
      notify: settings.notify, notifyServers: [...settings.notifyServers],
      masterServers: [...settings.masters], lastZoneTransfer: settings.lastTransferMs,
      isExpired: settings.expired,
    };
  }

  private dynamicUpdateMode(zoneName: string): DnsDynamicUpdateMode {
    const key = normalizeZoneKey(zoneName);
    if (this.settings.get(key)?.type === 'Secondary') return 'None';
    return this.zoneDynamicUpdate.get(key) ?? 'NonsecureAndSecure';
  }

  setZoneDynamicUpdate(zoneName: string, mode: DnsDynamicUpdateMode): DnsOpResult {
    return this.setPrimaryZone(zoneName, { dynamicUpdate: mode });
  }

  addTsigKey(name: string, algorithm: string, secret: string): DnsOpResult {
    const key = tsigKeyFromBase64(name, algorithm, secret);
    if (!key) return { ok: false, message: 'The TSIG secret is not valid base64.' };
    this.keyring.add(key);
    return { ok: true, message: '' };
  }

  addTrustAnchor(name: string, cryptoAlgorithm: string, base64: string): DnsOpResult {
    const algorithm = WINDOWS_CRYPTO_ALGORITHMS.get(cryptoAlgorithm.toLowerCase());
    if (algorithm === undefined) {
      return { ok: false, message: `The cryptographic algorithm "${cryptoAlgorithm}" is not supported.` };
    }
    const owner = normalizeDnsName(name);
    let material: Uint8Array;
    try {
      material = base64ToBytes(base64.replace(/\s+/g, ''));
    } catch {
      return { ok: false, message: 'The key data is not valid base64.' };
    }
    if (material.length === 0) return { ok: false, message: 'The key data is empty.' };
    const dnskey = makeDnskeyRecord(owner, 0, {
      flags: DNSKEY_FLAG_KSK, algorithm, publicKey: base64.replace(/\s+/g, ''),
    });
    const anchor = makeDsForKey(owner, 0, dnskey);
    const key = `${owner}|${anchor.data.keyTag}|${algorithm}`;
    if (this.trustAnchorKeys.has(key)) return { ok: true, message: '' };
    this.trustAnchorKeys.set(key, { name: owner, cryptoAlgorithm, base64: base64.replace(/\s+/g, '') });
    this.trustAnchors.push(anchor);
    return { ok: true, message: '' };
  }

  removeTrustAnchor(name: string): DnsOpResult {
    const owner = normalizeDnsName(name);
    const before = this.trustAnchors.length;
    for (let i = this.trustAnchors.length - 1; i >= 0; i--) {
      if (normalizeDnsName(this.trustAnchors[i].name) === owner) this.trustAnchors.splice(i, 1);
    }
    for (const [key, value] of [...this.trustAnchorKeys]) {
      if (value.name === owner) this.trustAnchorKeys.delete(key);
    }
    return this.trustAnchors.length < before
      ? { ok: true, message: '' }
      : { ok: false, message: `The trust anchor "${name}" does not exist.` };
  }

  listTrustAnchors(): { name: string; keyTag: number; cryptoAlgorithm: string; digest: string }[] {
    return this.trustAnchors.map(anchor => ({
      name: anchor.name, keyTag: anchor.data.keyTag,
      cryptoAlgorithm: [...WINDOWS_CRYPTO_ALGORITHMS].find(([, code]) => code === anchor.data.algorithm)?.[0] ?? String(anchor.data.algorithm),
      digest: anchor.data.digest,
    }));
  }

  removeTsigKey(name: string): DnsOpResult {
    return this.keyring.remove(name)
      ? { ok: true, message: '' }
      : { ok: false, message: `TSIG key "${name}" is not configured on this server.` };
  }

  listTsigKeys(): { name: string; algorithm: string }[] {
    return this.keyring.list().map(k => ({ name: k.name, algorithm: k.algorithm }));
  }

  private zoneFor(zoneName: string, cmdletName: string): Zone | { error: DnsOpResult } {
    const key = normalizeZoneKey(zoneName);
    const settings = this.settings.get(key);
    if (settings?.type === 'Secondary') {
      return { error: { ok: false, message: `${cmdletName} : Zone "${zoneName}" is a secondary zone and is read-only.` } };
    }
    const zone = this.store.getZone(zoneName);
    if (!zone) return { error: { ok: false, message: `${cmdletName} : Zone "${zoneName}" does not exist on this server.` } };
    return zone;
  }

  private fqdn(recordName: string, zone: Zone): string {
    return recordName === '@' || recordName === '' ? zone.origin : `${recordName}.${zone.origin}`;
  }

  addRecord(
    zoneName: string, recordName: string, spec: DnsRecordSpec, ttl = 3600,
    cmdletName = 'Add-DnsServerResourceRecord', createPtr = false, options: DnsRecordOptions = {},
  ): DnsOpResult {
    const zone = this.zoneFor(zoneName, cmdletName);
    if ('error' in zone) return zone.error;
    try {
      const fqdn = this.fqdn(recordName, zone);
      const record = buildRecord(fqdn, ttl, spec);
      let reverse: ReverseTarget | null = null;
      if (createPtr) {
        const type = spec.type.toUpperCase();
        if (type !== 'A' && type !== 'AAAA') return { ok: false, message: '-CreatePtr only applies to A and AAAA records.' };
        const address = String(type === 'A' ? spec.data.IPv4Address : spec.data.IPv6Address);
        reverse = this.reverseTargetFor(address);
        if (!reverse) return { ok: false, message: `No writable reverse lookup zone is authoritative for "${ptrQName(address)}".` };
      }
      zone.addRecord(record);
      if (options.age) this.stamp(record);
      if (options.allowUpdateAny) this.updatableByAny.add(recordKey(record));
      if (reverse) this.writePtr(reverse, ttl, fqdn);
      this.zoneChanged(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  addARecord(zoneName: string, recordName: string, ipv4: string, ttl = 3600): DnsOpResult {
    return this.addRecord(zoneName, recordName, { type: 'A', data: { IPv4Address: ipv4 } }, ttl, 'Add-DnsServerResourceRecordA');
  }

  addAaaaRecord(zoneName: string, recordName: string, ipv6: string, ttl = 3600): DnsOpResult {
    return this.addRecord(zoneName, recordName, { type: 'AAAA', data: { IPv6Address: ipv6 } }, ttl, 'Add-DnsServerResourceRecordAAAA');
  }

  addCnameRecord(zoneName: string, recordName: string, hostNameAlias: string, ttl = 3600): DnsOpResult {
    return this.addRecord(zoneName, recordName, { type: 'CNAME', data: { HostNameAlias: hostNameAlias } }, ttl, 'Add-DnsServerResourceRecordCName');
  }

  addPtrRecord(zoneName: string, recordName: string, ptrDomainName: string, ttl = 3600): DnsOpResult {
    return this.addRecord(zoneName, recordName, { type: 'PTR', data: { PtrDomainName: ptrDomainName } }, ttl, 'Add-DnsServerResourceRecordPtr');
  }

  addMxRecord(zoneName: string, recordName: string, preference: number, mailExchange: string, ttl = 3600): DnsOpResult {
    return this.addRecord(zoneName, recordName,
      { type: 'MX', data: { Preference: preference, MailExchange: mailExchange } }, ttl, 'Add-DnsServerResourceRecordMX');
  }

  addSrvRecord(
    zoneName: string, recordName: string, target: { priority: number; weight: number; port: number; target: string }, ttl = 3600,
  ): DnsOpResult {
    return this.addRecord(zoneName, recordName, {
      type: 'SRV',
      data: { Priority: target.priority, Weight: target.weight, Port: target.port, DomainName: target.target },
    }, ttl, 'Add-DnsServerResourceRecord -Srv');
  }

  removeRecord(zoneName: string, recordName: string, type: string, data?: Record<string, string | number>): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Remove-DnsServerResourceRecord');
    if ('error' in zone) return zone.error;
    const rrType = RRType[type.toUpperCase() as keyof typeof RRType];
    if (rrType === undefined) return { ok: false, message: `Unknown record type "${type}".` };
    const fqdn = this.fqdn(recordName, zone);
    const existing = (zone.getRRSet(fqdn, rrType) ?? [])
      .filter(rr => data === undefined || sameFields(recordFields(rr), data));
    if (existing.length === 0) return { ok: false, message: `Cannot find "${fqdn}" of type ${type} in zone "${zoneName}".` };
    for (const rr of [...existing]) this.deleteRecord(zone, rr);
    this.zoneChanged(zone);
    return { ok: true, message: '' };
  }

  replaceRecord(
    zoneName: string, recordName: string, previous: DnsRecordSpec, next: DnsRecordSpec, ttl?: number,
  ): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Set-DnsServerResourceRecord');
    if ('error' in zone) return zone.error;
    const rrType = RRType[previous.type.toUpperCase() as keyof typeof RRType];
    const fqdn = this.fqdn(recordName, zone);
    const old = rrType === undefined ? undefined
      : (zone.getRRSet(fqdn, rrType) ?? []).find(rr => sameFields(recordFields(rr), previous.data));
    if (!old) return { ok: false, message: `Cannot find "${fqdn}" of type ${previous.type} in zone "${zoneName}".` };
    let replacement: ResourceRecord<ResourceRecordData>;
    try {
      replacement = buildRecord(fqdn, ttl ?? old.ttl, next);
    } catch (e) { return { ok: false, message: (e as Error).message }; }
    this.deleteRecord(zone, old);
    try {
      zone.addRecord(replacement);
    } catch (e) {
      zone.addRecord(old);
      return { ok: false, message: (e as Error).message };
    }
    this.zoneChanged(zone);
    return { ok: true, message: '' };
  }

  getRecords(zoneName: string, recordName?: string, type?: string): DnsRecordInfo[] | null {
    const zone = this.store.getZone(zoneName);
    if (!zone) return null;
    const wanted = type ? RRType[type.toUpperCase() as keyof typeof RRType] : undefined;
    const all = zone.allRecords();
    const named = recordName ? all.filter(rr => rr.name.toLowerCase() === this.fqdn(recordName, zone).toLowerCase()) : all;
    const filtered = wanted === undefined ? named : named.filter(rr => rr.data.type === wanted);
    return filtered.map(rr => ({
      name: rr.name, type: RR_TYPE_NAME.get(rr.data.type) ?? String(rr.data.type), ttl: rr.ttl,
      text: formatRecordData(rr), data: recordFields(rr), timestampMs: this.timestamps.get(recordKey(rr)) ?? null,
    }));
  }

  applyDynamicARecord(zoneName: string, fqdnName: string, ipv4: string, ttl = 3600): DnsOpResult {
    const zone = this.store.getZone(zoneName);
    if (!zone) return { ok: false, message: `Zone "${zoneName}" does not exist on this server.` };
    for (const rr of zone.getRRSet(fqdnName, RRType.A) ?? []) this.deleteRecord(zone, rr);
    const dynamic = makeARecord(fqdnName, ttl, ipv4);
    zone.addRecord(dynamic);
    this.claimDynamic(zone, dynamic, null);
    this.zoneChanged(zone);
    return { ok: true, message: '' };
  }

  private reverseTargetFor(address: string): ReverseTarget | null {
    const arpa = ptrQName(address);
    const parent = this.store.findZone(arpa);
    for (const zone of this.store.listZones()) {
      const owner = classlessOwnerFor(zone.origin, address);
      if (owner && this.settings.get(zone.origin)?.type !== 'Secondary') {
        return { zone, owner, alias: parent && parent !== zone ? { zone: parent, name: arpa } : null };
      }
    }
    if (!parent || this.settings.get(parent.origin)?.type === 'Secondary') return null;
    return { zone: parent, owner: arpa, alias: null };
  }

  private writePtr(target: ReverseTarget, ttl: number, fqdnName: string): void {
    for (const rr of target.zone.getRRSet(target.owner, RRType.PTR) ?? []) this.deleteRecord(target.zone, rr);
    const ptr = makePtrRecord(target.owner, ttl, fqdnName);
    target.zone.addRecord(ptr);
    this.claimDynamic(target.zone, ptr, null);
    this.zoneChanged(target.zone);
    if (!target.alias) return;
    for (const rr of target.alias.zone.getRRSet(target.alias.name, RRType.CNAME) ?? []) this.deleteRecord(target.alias.zone, rr);
    const alias = makeCnameRecord(target.alias.name, ttl, target.owner);
    target.alias.zone.addRecord(alias);
    this.claimDynamic(target.alias.zone, alias, null);
    this.zoneChanged(target.alias.zone);
  }

  reverseZoneFor(address: string): string | null {
    return this.reverseTargetFor(address)?.zone.origin ?? null;
  }

  applyDynamicPtrRecord(address: string, fqdnName: string, ttl = 3600): DnsOpResult {
    const target = this.reverseTargetFor(address);
    if (!target) return { ok: false, message: `No reverse lookup zone is authoritative for "${ptrQName(address)}".` };
    this.writePtr(target, ttl, fqdnName);
    return { ok: true, message: '' };
  }

  removeDynamicRecord(zoneName: string, fqdnName: string, type: string): DnsOpResult {
    const zone = this.store.getZone(zoneName);
    if (!zone) return { ok: false, message: `Zone "${zoneName}" does not exist on this server.` };
    const rrType = RRType[type.toUpperCase() as keyof typeof RRType];
    if (rrType === undefined) return { ok: false, message: `Unknown record type "${type}".` };
    const existing = zone.getRRSet(fqdnName, rrType) ?? [];
    if (existing.length === 0) {
      return { ok: false, message: `Cannot find "${fqdnName}" of type ${type} in zone "${zoneName}".` };
    }
    for (const rr of [...existing]) this.deleteRecord(zone, rr);
    this.zoneChanged(zone);
    return { ok: true, message: '' };
  }

  removeDynamicPtrRecord(address: string): DnsOpResult {
    const target = this.reverseTargetFor(address);
    if (!target) return { ok: false, message: `No reverse lookup zone is authoritative for "${ptrQName(address)}".` };
    const existing = target.zone.getRRSet(target.owner, RRType.PTR) ?? [];
    if (existing.length === 0) return { ok: false, message: `Cannot find "${target.owner}" of type PTR.` };
    for (const rr of [...existing]) this.deleteRecord(target.zone, rr);
    this.zoneChanged(target.zone);
    if (target.alias) {
      for (const rr of target.alias.zone.getRRSet(target.alias.name, RRType.CNAME) ?? []) this.deleteRecord(target.alias.zone, rr);
      this.zoneChanged(target.alias.zone);
    }
    return { ok: true, message: '' };
  }

  readDhcid(zoneName: string, fqdnName: string): DhcidRecordData | null {
    const zone = this.store.getZone(zoneName);
    if (!zone) return null;
    const set = zone.getRRSet(fqdnName, RRType.DHCID) ?? [];
    return set.length > 0 ? set[0].data as DhcidRecordData : null;
  }

  writeDhcid(zoneName: string, fqdnName: string, data: DhcidRecordData, ttl = 3600): DnsOpResult {
    const zone = this.store.getZone(zoneName);
    if (!zone) return { ok: false, message: `Zone "${zoneName}" does not exist on this server.` };
    for (const rr of zone.getRRSet(fqdnName, RRType.DHCID) ?? []) this.deleteRecord(zone, rr);
    const dhcid = makeDhcidRecord(fqdnName, ttl, {
      identifierType: data.identifierType, digestType: data.digestType, digest: data.digest,
    });
    zone.addRecord(dhcid);
    this.claimDynamic(zone, dhcid, null);
    this.zoneChanged(zone);
    return { ok: true, message: '' };
  }
}
