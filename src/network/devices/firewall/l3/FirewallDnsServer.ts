import { IPAddress, type IPv4Packet, type UDPPacket } from '../../../core/types';
import {
  buildLegacyResponseMessage, legacyRecordToResourceRecord, rrTypeName,
  type DnsRecord,
} from '../../../dns/compat/DnsWireCompat';
import { decodeDnsMessage, encodeDnsMessage } from '../../../dns/wire/DnsMessageCodec';
import type { DnsMessage } from '../../../dns/wire/DnsMessage';
import { DnsRcode } from '../../../dns/wire/DnsHeaderFlags';
import { makeARecord, makeSoaRecord } from '../../../dns/wire/ResourceRecord';
import { Zone } from '../../../dns/zone/Zone';
import { ZoneStore } from '../../../dns/zone/ZoneStore';
import { AuthoritativeServer } from '../../../dns/resolver/AuthoritativeServer';
import { isTransferQuery, refuseTransfer } from '../../../dns/transfer/AxfrSession';
import { isNotify, makeNotifyAck } from '../../../dns/transfer/NotifyProtocol';
import {
  ZoneTransferClient, type ZoneTransferTransport,
} from '../../../dns/transfer/ZoneTransferClient';
import { DNS_PORT } from './FirewallDnsClient';

export interface DnsZoneEntry {
  readonly hostname: string;
  readonly ip: string;
  readonly ttl?: number;
}

export interface DnsZone {
  readonly name: string;
  readonly domain: string;
  readonly type: string;
  readonly authoritative: boolean;
  readonly primaryName?: string;
  readonly contact?: string;
  readonly ipPrimary?: string;
  readonly entries: readonly DnsZoneEntry[];
}

export interface DnsServerInterface {
  readonly iface: string;
  readonly mode: string;
}

export interface FirewallDnsServerDeps {
  resolveExternal(name: string): readonly string[];
  reply(iface: string, to: string, port: number, payload: Uint8Array): void;
  transferTransport?(): ZoneTransferTransport;
}

export function isSecondary(zone: DnsZone): boolean {
  return zone.type === 'secondary' && (zone.ipPrimary ?? '').length > 0;
}

const ZONE_TTL = 3600;
const SOA_REFRESH = 10800;
const SOA_RETRY = 900;
const SOA_EXPIRE = 604800;
const SOA_MINIMUM = 86400;

function buildZone(zone: DnsZone): Zone | null {
  const domain = zone.domain.replace(/\.$/, '');
  if (domain.length === 0) return null;

  const mname = zone.primaryName && zone.primaryName.length > 0
    ? zone.primaryName : `dns.${domain}`;
  const rname = zone.contact && zone.contact.length > 0
    ? zone.contact.replace('@', '.') : `hostmaster.${domain}`;

  let built: Zone;
  try {
    built = new Zone(domain, makeSoaRecord(domain, ZONE_TTL, {
      mname, rname, serial: 1,
      refresh: SOA_REFRESH, retry: SOA_RETRY,
      expire: SOA_EXPIRE, minimum: SOA_MINIMUM,
    }));
  } catch {
    return null;
  }

  for (const entry of zone.entries) {
    if (entry.hostname.length === 0) continue;
    const owner = entry.hostname === '@' ? domain : `${entry.hostname}.${domain}`;
    try {
      built.addRecord(makeARecord(owner, entry.ttl && entry.ttl > 0 ? entry.ttl : ZONE_TTL, entry.ip));
    } catch {
      continue;
    }
  }
  return built;
}

export class FirewallDnsServer {
  private readonly listeners = new Map<string, DnsServerInterface>();
  private readonly zones = new Map<string, DnsZone>();
  private readonly transfers = new Map<string, ZoneTransferClient>();
  private authority: AuthoritativeServer | null = null;

  constructor(private readonly deps: FirewallDnsServerDeps) {}

  applyInterface(entry: DnsServerInterface): void {
    this.listeners.set(entry.iface, entry);
  }

  removeInterface(iface: string): void { this.listeners.delete(iface); }

  applyZone(zone: DnsZone): void {
    const previous = this.zones.get(zone.name);
    this.zones.set(zone.name, zone);
    this.authority = null;
    if (previous?.domain !== zone.domain || previous?.ipPrimary !== zone.ipPrimary) {
      this.transfers.delete(zone.name);
    }
    if (isSecondary(zone)) void this.transferZone(zone.name);
  }

  removeZone(name: string): void {
    this.zones.delete(name);
    this.transfers.delete(name);
    this.authority = null;
  }

  async transferZone(name: string, force = false): Promise<boolean> {
    const client = this.transferClientFor(name);
    if (!client) return false;
    const fetched = await client.refresh(force);
    if (fetched) this.authority = null;
    return fetched;
  }

  async transferSecondaryZones(force = false): Promise<void> {
    for (const zone of this.zones.values()) {
      if (isSecondary(zone)) await this.transferZone(zone.name, force);
    }
  }

  transferredZone(name: string): Zone | null {
    return this.transfers.get(name)?.currentZone() ?? null;
  }

  private transferClientFor(name: string): ZoneTransferClient | null {
    const existing = this.transfers.get(name);
    if (existing) return existing;

    const zone = this.zones.get(name);
    if (!zone || !isSecondary(zone) || !this.deps.transferTransport) return null;
    const origin = zone.domain.replace(/\.$/, '');
    const primary = IPAddress.tryParse(zone.ipPrimary ?? '');
    if (origin.length === 0 || !primary) return null;

    const client = new ZoneTransferClient(
      origin, [primary], this.deps.transferTransport());
    this.transfers.set(name, client);
    return client;
  }

  servesOn(iface: string): boolean { return this.listeners.has(iface); }

  listZones(): readonly DnsZone[] { return Object.freeze([...this.zones.values()]); }

  handleUdp(iface: string, packet: IPv4Packet, udp: UDPPacket): boolean {
    if (udp.destinationPort !== DNS_PORT || !this.servesOn(iface)) return false;
    if (!(udp.payload instanceof Uint8Array)) return false;

    let query: DnsMessage;
    try {
      query = decodeDnsMessage(udp.payload);
    } catch {
      return false;
    }
    if (query.flags.qr) return false;

    const response = this.reactTo(query, packet.sourceIP.toString());
    this.deps.reply(iface, packet.sourceIP.toString(), udp.sourcePort,
      encodeDnsMessage(response));
    return true;
  }

  private reactTo(query: DnsMessage, from: string): DnsMessage {
    if (isNotify(query)) {
      this.onNotify(query.questions[0]?.qname ?? '', from);
      return makeNotifyAck(query);
    }
    if (isTransferQuery(query)) return refuseTransfer(query);
    return this.respond(query);
  }

  private onNotify(qname: string, from: string): void {
    const origin = qname.replace(/\.$/, '').toLowerCase();
    for (const zone of this.zones.values()) {
      if (!isSecondary(zone)) continue;
      if (zone.domain.replace(/\.$/, '').toLowerCase() !== origin) continue;
      if (zone.ipPrimary !== from) continue;
      void this.transferZone(zone.name);
    }
  }

  private respond(query: DnsMessage): DnsMessage {
    const question = query.questions[0];
    if (question) {
      const local = this.localAuthority().answer(query);
      if (local.flags.rcode !== DnsRcode.REFUSED
        && (local.answers.length > 0 || this.answersNegatively(question.qname))) {
        return local;
      }
    }
    return this.forwarded(query);
  }

  private answersNegatively(qname: string): boolean {
    const domain = qname.replace(/\.$/, '').toLowerCase();
    for (const zone of this.zones.values()) {
      const origin = zone.domain.replace(/\.$/, '').toLowerCase();
      if (origin.length === 0) continue;
      if (domain === origin || domain.endsWith(`.${origin}`)) return zone.authoritative;
    }
    return false;
  }

  private forwarded(query: DnsMessage): DnsMessage {
    const question = query.questions[0];
    const answers = question && rrTypeName(Number(question.qtype)) === 'A'
      ? this.deps.resolveExternal(question.qname.replace(/\.$/, '').toLowerCase())
        .map<DnsRecord>(address => ({
          name: question.qname.replace(/\.$/, ''),
          type: 'A', value: address, ttl: ZONE_TTL,
        }))
      : [];
    return buildLegacyResponseMessage(
      query, answers.length > 0 ? 'NOERROR' : 'NXDOMAIN', answers);
  }

  private localAuthority(): AuthoritativeServer {
    if (this.authority) return this.authority;
    const store = new ZoneStore();
    for (const zone of this.zones.values()) {
      const built = isSecondary(zone)
        ? this.transfers.get(zone.name)?.currentZone() ?? null
        : buildZone(zone);
      if (!built) continue;
      if (store.getZone(built.origin)) continue;
      store.addZone(built);
    }
    this.authority = new AuthoritativeServer(store);
    return this.authority;
  }
}

export function zoneRecordsOf(zone: DnsZone): readonly DnsRecord[] {
  return zone.entries.map(entry => ({
    name: `${entry.hostname}.${zone.domain}`,
    type: 'A' as const, value: entry.ip, ttl: entry.ttl && entry.ttl > 0 ? entry.ttl : ZONE_TTL,
  }));
}

export { legacyRecordToResourceRecord };
