import {
  IPAddress, IP_PROTO_ICMPV6, type IPv6Address, type IPv4Packet, type IPv6Packet,
} from '@/network/core/types';
import { Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';
import { Nat64Translator, type Nat64NexthopMtu } from '@/network/nat/nat64/Nat64Translator';
import type { PolicyDecision } from '../policy/PolicyEvaluator';
import type { PolicyProbe } from '../policy/PolicyProbe';
import { poolAddressAt, poolAddressCount, poolContains, type IpPool } from './IpPool';

export interface FirewallNat64Deps {
  nexthopMtu: Nat64NexthopMtu;
  decide(ingress: string, probe: PolicyProbe): PolicyDecision;
  pool(ingress: string, name: string): IpPool | undefined;
  pools(): readonly IpPool[];
  egressFor(ingress: string, target: string): { iface: string; nextHop?: string } | undefined;
  forward(iface: string, packet: IPv4Packet, nextHop?: string): void;
  injectIpv6(packet: IPv6Packet): void;
  now(): number;
  log(line: string): void;
}

function poolAddresses(pool: IpPool): IPAddress[] {
  const addresses: IPAddress[] = [];
  for (let i = 0; i < poolAddressCount(pool); i++) {
    const address = poolAddressAt(pool, i);
    if (address !== null) addresses.push(new IPAddress(address));
  }
  return addresses;
}

function portsOf(packet: IPv6Packet): { sourcePort?: number; destPort?: number } {
  const payload = packet.payload as { sourcePort?: number; destinationPort?: number } | undefined;
  return payload?.sourcePort === undefined ? {} : { sourcePort: payload.sourcePort, destPort: payload.destinationPort };
}

export class FirewallNat64 {
  private prefix = Nat64Prefix.wellKnownPrefix();
  private readonly translators = new Map<string, Nat64Translator>();

  constructor(private readonly deps: FirewallNat64Deps) {}

  forget(pool: string): void { this.translators.delete(pool); }

  private secondary = new Map<string, Nat64Prefix>();
  private secondaryEnabled = false;

  setPrefix(prefix: Nat64Prefix): void {
    this.prefix = prefix;
    this.translators.clear();
  }

  setSecondaryPrefix(name: string, prefix: Nat64Prefix): void {
    this.secondary.set(name, prefix);
    this.translators.clear();
  }

  removeSecondaryPrefix(name: string): void {
    this.secondary.delete(name);
    this.translators.clear();
  }

  setSecondaryEnabled(enabled: boolean): void {
    this.secondaryEnabled = enabled;
    this.translators.clear();
  }

  private secondaryPrefixes(): Nat64Prefix[] {
    return this.secondaryEnabled ? [...this.secondary.values()] : [];
  }

  private prefixFor(address: IPv6Address): Nat64Prefix | undefined {
    return [this.prefix, ...this.secondaryPrefixes()].find((candidate) => candidate.contains(address));
  }

  forward6(ingress: string, packet: IPv6Packet): boolean {
    const prefix = this.prefixFor(packet.destinationIP);
    if (prefix === undefined || packet.hopLimit <= 1) return false;
    const target = prefix.extract(packet.destinationIP);
    if (target === null) return this.drop(packet, 'non-global-destination');
    const egress = this.deps.egressFor(ingress, target.toString());
    if (egress === undefined) return this.drop(packet, 'no-route');
    const payload = packet.payload as { type?: string } | undefined;
    const decision = this.deps.decide(ingress, {
      ingressZone: '', egressZone: '',
      ingressInterface: ingress, egressInterface: egress.iface,
      sourceIP: packet.sourceIP.toString(), destIP: packet.destinationIP.toString(),
      protocol: payload?.type === 'icmpv6' ? IP_PROTO_ICMPV6 : packet.nextHeader,
      tos: packet.trafficClass,
      ...portsOf(packet),
    });
    const rule = decision.rule;
    if (decision.action !== 'allow' || rule.nat64Enabled !== true) return this.drop(packet, 'policy');
    const pool = rule.natPool === undefined ? undefined : this.deps.pool(ingress, rule.natPool);
    if (pool === undefined || !pool.nat64) return this.drop(packet, 'no-nat64-pool');
    const result = this.translatorFor(pool).translate6to4({ ...packet, hopLimit: packet.hopLimit - 1 });
    if (result.ok === false) return this.drop(packet, result.reason);
    this.deps.forward(egress.iface, result.packet, egress.nextHop);
    return true;
  }

  forward4(packet: IPv4Packet): boolean {
    const pool = this.deps.pools().find((p) => p.nat64 && poolContains(p, packet.destinationIP.toString()));
    if (pool === undefined) return false;
    if (packet.ttl <= 1) return true;
    const result = this.translatorFor(pool).translate4to6Fitted({ ...packet, ttl: packet.ttl - 1 });
    if (result.ok === false) {
      this.deps.log(`NAT64 dropped ${packet.sourceIP} -> ${packet.destinationIP} (${result.reason})`);
      return true;
    }
    for (const translated of result.packet) this.deps.injectIpv6(translated);
    return true;
  }

  private translatorFor(pool: IpPool): Nat64Translator {
    const existing = this.translators.get(pool.name);
    if (existing !== undefined) return existing;
    const created = new Nat64Translator({ nexthopMtu: this.deps.nexthopMtu, prefix: this.prefix, secondaryPrefixes: this.secondaryPrefixes(), pool: poolAddresses(pool), clock: () => this.deps.now() });
    this.translators.set(pool.name, created);
    return created;
  }

  private drop(packet: IPv6Packet, reason: string): boolean {
    this.deps.log(`NAT64 dropped ${packet.sourceIP} -> ${packet.destinationIP} (${reason})`);
    return true;
  }
}
