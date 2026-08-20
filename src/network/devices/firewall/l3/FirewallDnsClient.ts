import {
  IPAddress, IP_PROTO_UDP, createIPv4Packet,
  type IPv4Packet, type UDPPacket,
} from '../../../core/types';
import {
  buildLegacyQueryMessage, nextDnsTransactionId, resourceRecordToLegacyRecord,
} from '../../../dns/compat/DnsWireCompat';
import { decodeDnsMessage, encodeDnsMessage } from '../../../dns/wire/DnsMessageCodec';

export const DNS_PORT = 53;
const EPHEMERAL_BASE = 40000;

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
}

export class FirewallDnsClient {
  private settings: FirewallDnsSettings = { primary: '', secondary: '', domain: '' };
  private readonly cache = new Map<string, ResolvedFqdn>();
  private pending: { id: number; answers: string[]; ttl: number } | null = null;
  private sourcePort = EPHEMERAL_BASE;

  constructor(private readonly deps: FirewallDnsDeps) {}

  applySettings(settings: FirewallDnsSettings): void {
    this.settings = settings;
  }

  getSettings(): FirewallDnsSettings { return this.settings; }

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
      const legacy = resourceRecordToLegacyRecord(answer);
      if (legacy?.type !== 'A') continue;
      waiting.answers.push(legacy.value);
      waiting.ttl = legacy.ttl;
    }
    return true;
  }

  resolve(fqdn: string): readonly string[] {
    const known = this.cache.get(fqdn.toLowerCase());
    if (known) return known.addresses;
    return this.query(fqdn);
  }

  query(fqdn: string): readonly string[] {
    const servers = [this.settings.primary, this.settings.secondary]
      .filter(server => server.length > 0 && server !== '0.0.0.0');
    if (servers.length === 0) return [];

    for (const server of servers) {
      const id = nextDnsTransactionId();
      const message = buildLegacyQueryMessage(id, fqdn, 'A');
      if (!message) return [];

      this.pending = { id, answers: [], ttl: 0 };
      const port = this.nextSourcePort();
      this.deps.send(server, port, encodeDnsMessage(message));
      const collected = this.pending;
      this.pending = null;

      if (collected.answers.length > 0) {
        const entry: ResolvedFqdn = {
          fqdn, addresses: Object.freeze([...collected.answers]), ttl: collected.ttl,
        };
        this.cache.set(fqdn.toLowerCase(), entry);
        return entry.addresses;
      }
    }
    this.cache.set(fqdn.toLowerCase(), { fqdn, addresses: Object.freeze([]), ttl: 0 });
    return [];
  }

  forget(fqdn: string): void { this.cache.delete(fqdn.toLowerCase()); }

  entries(): readonly ResolvedFqdn[] {
    return Object.freeze([...this.cache.values()]);
  }

  private nextSourcePort(): number {
    this.sourcePort = this.sourcePort >= 65000 ? EPHEMERAL_BASE : this.sourcePort + 1;
    return this.sourcePort;
  }
}

export function dnsQueryDatagram(
  source: string, destination: string, sourcePort: number, payload: Uint8Array,
): IPv4Packet {
  const udp: UDPPacket = {
    type: 'udp', sourcePort, destinationPort: DNS_PORT,
    length: 8 + payload.length, checksum: 0, payload,
  };
  return createIPv4Packet(
    new IPAddress(source), new IPAddress(destination),
    IP_PROTO_UDP, 64, udp, 8 + payload.length);
}
