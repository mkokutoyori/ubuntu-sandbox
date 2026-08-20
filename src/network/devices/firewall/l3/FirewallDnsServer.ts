import {
  IPAddress, IP_PROTO_UDP, createIPv4Packet,
  type IPv4Packet, type UDPPacket,
} from '../../../core/types';
import {
  buildLegacyResponseMessage, legacyRecordToResourceRecord, rrTypeName,
  type DnsRecord,
} from '../../../dns/compat/DnsWireCompat';
import { decodeDnsMessage, encodeDnsMessage } from '../../../dns/wire/DnsMessageCodec';
import type { DnsMessage } from '../../../dns/wire/DnsMessage';
import { DNS_PORT } from './FirewallDnsClient';

export interface DnsZoneEntry {
  readonly hostname: string;
  readonly ip: string;
}

export interface DnsZone {
  readonly name: string;
  readonly domain: string;
  readonly type: string;
  readonly authoritative: boolean;
  readonly entries: readonly DnsZoneEntry[];
}

export interface DnsServerInterface {
  readonly iface: string;
  readonly mode: string;
}

export interface FirewallDnsServerDeps {
  resolveExternal(name: string): readonly string[];
  reply(iface: string, to: string, port: number, payload: Uint8Array): void;
}

const ZONE_TTL = 3600;

export class FirewallDnsServer {
  private readonly listeners = new Map<string, DnsServerInterface>();
  private readonly zones = new Map<string, DnsZone>();

  constructor(private readonly deps: FirewallDnsServerDeps) {}

  applyInterface(entry: DnsServerInterface): void {
    this.listeners.set(entry.iface, entry);
  }

  removeInterface(iface: string): void { this.listeners.delete(iface); }

  applyZone(zone: DnsZone): void { this.zones.set(zone.name, zone); }

  removeZone(name: string): void { this.zones.delete(name); }

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

    const answers = this.answer(query);
    const response = buildLegacyResponseMessage(
      query, answers.length > 0 ? 'NOERROR' : 'NXDOMAIN', answers);
    this.deps.reply(iface, packet.sourceIP.toString(), udp.sourcePort,
      encodeDnsMessage(response));
    return true;
  }

  private answer(query: DnsMessage): DnsRecord[] {
    const question = query.questions[0];
    if (!question || rrTypeName(Number(question.qtype)) !== 'A') return [];

    const name = question.qname.replace(/\.$/, '').toLowerCase();
    const local = this.fromZones(name);
    if (local.length > 0) return local;

    return this.deps.resolveExternal(name)
      .map(address => ({ name, type: 'A' as const, value: address, ttl: ZONE_TTL }));
  }

  private fromZones(name: string): DnsRecord[] {
    for (const zone of this.zones.values()) {
      const domain = zone.domain.replace(/\.$/, '').toLowerCase();
      if (domain.length === 0 || !name.endsWith(`.${domain}`)) continue;

      const host = name.slice(0, name.length - domain.length - 1);
      const entry = zone.entries.find(
        candidate => candidate.hostname.toLowerCase() === host);
      if (entry) {
        return [{ name, type: 'A', value: entry.ip, ttl: ZONE_TTL }];
      }
    }
    return [];
  }
}

export function udpReplyDatagram(
  source: string, destination: string,
  sourcePort: number, destinationPort: number, payload: Uint8Array,
): IPv4Packet {
  const udp: UDPPacket = {
    type: 'udp', sourcePort, destinationPort,
    length: 8 + payload.length, checksum: 0, payload,
  };
  return createIPv4Packet(
    new IPAddress(source), new IPAddress(destination),
    IP_PROTO_UDP, 64, udp, 8 + payload.length);
}

export function zoneRecordsOf(zone: DnsZone): readonly DnsRecord[] {
  return zone.entries.map(entry => ({
    name: `${entry.hostname}.${zone.domain}`,
    type: 'A' as const, value: entry.ip, ttl: ZONE_TTL,
  }));
}

export { legacyRecordToResourceRecord };
