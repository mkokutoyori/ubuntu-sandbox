import { IP_PROTO_UDP, type IPv4Packet, type UDPPacket } from '../../../core/types';
import { DnsClass, RRType } from '../../../dns/wire/RRType';
import { makeARecord } from '../../../dns/wire/ResourceRecord';
import { buildUpdateMessage } from '../../../dns/update/DnsUpdate';
import { decodeDnsMessage, encodeDnsMessage } from '../../../dns/wire/DnsMessageCodec';
import { signDnsMessage, tsigKeyFromBase64, TsigAlgorithm } from '../../../dns/tsig/Tsig';
import { DNS_PORT } from './FirewallDnsClient';

export interface DdnsSettings {
  readonly serverIp: string;
  readonly zone: string;
  readonly ttl: number;
  readonly auth: 'disable' | 'tsig';
  readonly keyName: string;
  readonly key: string;
}

export interface DdnsOutcome {
  readonly fqdn: string;
  readonly address: string;
  readonly operation: 'add' | 'delete';
  readonly rcode: number | null;
}

export interface FirewallDdnsDeps {
  send(destination: string, sourcePort: number, payload: Uint8Array): boolean;
  now(): number;
}

const EPHEMERAL_BASE = 45000;
const TRANSACTION_SPAN = 0x10000;

export class FirewallDdns {
  private nextId = 1;
  private nextPort = EPHEMERAL_BASE;
  private readonly pending = new Map<number, DdnsOutcome>();
  private readonly outcomes: DdnsOutcome[] = [];

  constructor(private readonly deps: FirewallDdnsDeps) {}

  register(settings: DdnsSettings, fqdn: string, address: string, ttl: number): boolean {
    return this.send(settings, fqdn, address, 'add', [
      { kind: 'delete-rrset', name: fqdn, type: RRType.A },
      { kind: 'add', record: makeARecord(fqdn, ttl, address) },
    ]);
  }

  withdraw(settings: DdnsSettings, fqdn: string, address: string): boolean {
    return this.send(settings, fqdn, address, 'delete', [
      { kind: 'delete-record', record: makeARecord(fqdn, 0, address) },
    ]);
  }

  results(): readonly DdnsOutcome[] { return this.outcomes; }

  observe(packet: IPv4Packet): boolean {
    if (this.pending.size === 0 || packet.protocol !== IP_PROTO_UDP) return false;
    const udp = packet.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || udp.sourcePort !== DNS_PORT || !(udp.payload instanceof Uint8Array)) return false;
    let response;
    try {
      response = decodeDnsMessage(udp.payload);
    } catch {
      return false;
    }
    const waiting = this.pending.get(response.id);
    if (waiting === undefined) return false;
    this.pending.delete(response.id);
    this.outcomes.push({ ...waiting, rcode: response.flags.rcode });
    return true;
  }

  private send(
    settings: DdnsSettings, fqdn: string, address: string, operation: 'add' | 'delete',
    updates: Parameters<typeof buildUpdateMessage>[0]['updates'],
  ): boolean {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) % TRANSACTION_SPAN;
    const message = buildUpdateMessage(
      { zone: settings.zone, zoneClass: DnsClass.IN, prerequisites: [], updates }, id);
    const signing = settings.auth === 'tsig' && settings.keyName.length > 0;
    const key = signing
      ? tsigKeyFromBase64(settings.keyName, TsigAlgorithm.HMAC_MD5, settings.key)
      : null;
    if (signing && !key) return false;
    const payload = key
      ? signDnsMessage(message, { key, timeSigned: Math.floor(this.deps.now() / 1000) })
      : encodeDnsMessage(message);
    const port = this.nextPort;
    this.nextPort = this.nextPort >= 49999 ? EPHEMERAL_BASE : this.nextPort + 1;
    const sent = this.deps.send(settings.serverIp, port, payload);
    if (sent) this.pending.set(id, { fqdn, address, operation, rcode: null });
    return sent;
  }
}
