import { IP_PROTO_UDP, type IPv4Packet, type UDPPacket } from '../../../core/types';
import { udpDatagram } from './FirewallEgress';
import {
  buildLegacyQueryMessage, nextDnsTransactionId, resourceRecordToLegacyRecord,
} from '../../../dns/compat/DnsWireCompat';
import { decodeDnsMessage, encodeDnsMessage } from '../../../dns/wire/DnsMessageCodec';
import { DnsCache } from '../../../dns/resolver/DnsCache';
import { RRType } from '../../../dns/wire/RRType';
import type {
  ResourceRecord, ResourceRecordData, SoaRecordData,
} from '../../../dns/wire/ResourceRecord';

export const DNS_PORT = 53;
const EPHEMERAL_BASE = 40000;

export type DnsAddressFamily = 'ipv4' | 'ipv6';

const QUERY_TYPE: Record<DnsAddressFamily, { readonly code: number; readonly name: 'A' | 'AAAA' }> = {
  ipv4: { code: RRType.A, name: 'A' },
  ipv6: { code: RRType.AAAA, name: 'AAAA' },
};

export interface FirewallDnsSettings {
  readonly primary: string;
  readonly secondary: string;
  readonly domain: string;
}

export interface ResolvedFqdn {
  readonly fqdn: string;
  readonly addresses: readonly string[];
  readonly ttl: number;
}

export interface FirewallDnsDeps {
  send(destination: string, sourcePort: number, payload: Uint8Array): boolean;
  now(): number;
  learnedServers?(): readonly string[];
}

interface PendingQuery {
  readonly id: number;
  readonly qtype: number;
  readonly records: ResourceRecord<ResourceRecordData>[];
  rcode?: number;
  soa?: ResourceRecord<SoaRecordData>;
}

function addressesOf(records: readonly ResourceRecord<ResourceRecordData>[]): string[] {
  return records.flatMap(record => {
    const legacy = resourceRecordToLegacyRecord(record);
    return legacy === null ? [] : [legacy.value];
  });
}

export class FirewallDnsClient {
  private settings: FirewallDnsSettings = { primary: '', secondary: '', domain: '' };
  private readonly cache: DnsCache;
  private readonly asked = new Map<string, string>();
  private pending: PendingQuery | null = null;
  private sourcePort = EPHEMERAL_BASE;

  constructor(private readonly deps: FirewallDnsDeps) {
    this.cache = new DnsCache(() => deps.now());
  }

  applySettings(settings: FirewallDnsSettings): void {
    this.settings = settings;
  }

  getSettings(): FirewallDnsSettings { return this.settings; }

  servers(): readonly string[] {
    const declared = [this.settings.primary, this.settings.secondary];
    const learned = this.deps.learnedServers?.() ?? [];
    return [...new Set([...declared, ...learned])]
      .filter(server => server.length > 0 && server !== '0.0.0.0');
  }

  observe(packet: IPv4Packet): boolean {
    const waiting = this.pending;
    if (!waiting || packet.protocol !== IP_PROTO_UDP) return false;

    const udp = packet.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || udp.sourcePort !== DNS_PORT) return false;
    if (!(udp.payload instanceof Uint8Array)) return false;

    let response;
    try {
      response = decodeDnsMessage(udp.payload);
    } catch {
      return false;
    }
    if (response.id !== waiting.id) return false;

    for (const answer of response.answers) {
      if (answer.data.type === waiting.qtype) waiting.records.push(answer);
    }
    waiting.rcode = response.flags.rcode;
    const soa = response.authorities.find(record => record.data.type === RRType.SOA);
    if (soa !== undefined) waiting.soa = soa as ResourceRecord<SoaRecordData>;
    return true;
  }

  resolve(fqdn: string, family: DnsAddressFamily = 'ipv4'): readonly string[] {
    const cached = this.cache.lookup(fqdn, QUERY_TYPE[family].code);
    if (cached.kind === 'hit') return addressesOf(cached.records);
    if (cached.kind === 'negative' || cached.kind === 'servfail') return [];
    return this.query(fqdn, family);
  }

  query(fqdn: string, family: DnsAddressFamily = 'ipv4'): readonly string[] {
    const type = QUERY_TYPE[family];
    this.asked.set(fqdn.toLowerCase(), fqdn);
    for (const server of this.servers()) {
      const id = nextDnsTransactionId();
      const message = buildLegacyQueryMessage(id, fqdn, type.name);
      if (!message) return [];

      const collected: PendingQuery = { id, qtype: type.code, records: [] };
      this.pending = collected;
      this.deps.send(server, this.nextSourcePort(), encodeDnsMessage(message));
      this.pending = null;

      if (collected.records.length > 0) {
        this.cache.storePositive(collected.records, fqdn);
        return addressesOf(collected.records);
      }
      if (collected.rcode !== undefined && collected.soa !== undefined) {
        this.cache.storeNegative(fqdn, type.code, collected.rcode, collected.soa);
        return [];
      }
    }
    return [];
  }

  forget(fqdn: string): void {
    this.asked.delete(fqdn.toLowerCase());
    this.cache.forget(fqdn);
  }

  entries(): readonly ResolvedFqdn[] {
    const byName = new Map<string, { addresses: string[]; ttl: number }>();
    for (const view of this.cache.entries()) {
      if (view.negative) continue;
      const key = view.entry.toLowerCase();
      const known = byName.get(key);
      if (known === undefined) byName.set(key, { addresses: [view.data], ttl: view.ttl });
      else {
        known.addresses.push(view.data);
        known.ttl = Math.min(known.ttl, view.ttl);
      }
    }
    return Object.freeze([...this.asked].map(([key, fqdn]) => {
      const resolved = byName.get(key);
      return {
        fqdn,
        addresses: Object.freeze([...(resolved?.addresses ?? [])]),
        ttl: resolved?.ttl ?? 0,
      };
    }));
  }

  private nextSourcePort(): number {
    this.sourcePort = this.sourcePort >= 65000 ? EPHEMERAL_BASE : this.sourcePort + 1;
    return this.sourcePort;
  }
}

export function dnsQueryDatagram(
  source: string, destination: string, sourcePort: number, payload: Uint8Array,
): IPv4Packet {
  return udpDatagram(source, destination, sourcePort, DNS_PORT, payload);
}
