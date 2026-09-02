import { IPv6Address } from '../../../core/types';
import { parseIpv6Prefix } from '../../../core/Ipv6Arithmetic';
import { DHCPv6Server } from '../../../dhcpv6/DHCPv6Server';

export interface Dhcp6Scope {
  readonly id: string;
  readonly enabled: boolean;
  readonly iface: string;
  readonly subnet: string;
  readonly leaseTimeSec: number;
  readonly dnsService: string;
  readonly dnsServers: readonly string[];
  readonly domain: string;
  readonly ranges: ReadonlyArray<{ startIp: string; endIp: string }>;
}

export interface FirewallDhcp6Deps {
  readonly systemDnsServers?: () => readonly string[];
}

export interface Dhcp6Lease {
  readonly iface: string;
  readonly ip: string;
  readonly duid: string;
  readonly expiresAt: number;
  readonly serverId: string;
}

function isIpv6(candidate: string): boolean {
  try {
    new IPv6Address(candidate);
    return true;
  } catch {
    return false;
  }
}

export class FirewallDhcp6 {
  private readonly server = new DHCPv6Server();
  private readonly scopes = new Map<string, Dhcp6Scope>();

  constructor(private readonly deps: FirewallDhcp6Deps = {}) {}

  getServer(): DHCPv6Server { return this.server; }

  upsertScope(scope: Dhcp6Scope): void {
    this.scopes.set(scope.id, scope);
    this.rebuild();
  }

  removeScope(id: string): void {
    this.scopes.delete(id);
    this.rebuild();
  }

  getScopes(): readonly Dhcp6Scope[] { return [...this.scopes.values()]; }

  private serving(): Dhcp6Scope[] {
    return [...this.scopes.values()].filter(scope =>
      scope.enabled && scope.iface.length > 0 && parseIpv6Prefix(scope.subnet) !== null);
  }

  private poolName(scope: Dhcp6Scope): string { return `scope6-${scope.id}`; }

  private resolvedDnsServers(scope: Dhcp6Scope): string[] {
    if (scope.dnsService === 'delegated') return [];
    if (scope.dnsService === 'default') {
      return [...(this.deps.systemDnsServers?.() ?? [])].filter(isIpv6);
    }
    return scope.dnsServers.filter(isIpv6);
  }

  private rebuild(): void {
    for (const name of [...this.server.getAllPools().keys()]) this.server.deletePool(name);

    const serving = this.serving();
    for (const scope of serving) {
      const parsed = parseIpv6Prefix(scope.subnet);
      if (!parsed) continue;
      const name = this.poolName(scope);
      this.server.createPool(name);
      this.server.configurePoolPrefix(name, parsed.address, parsed.prefixLength);
      this.server.configurePoolRanges(name, scope.ranges.map(range => ({ ...range })));
      this.server.configurePoolDns(name, this.resolvedDnsServers(scope));
      this.server.configurePoolDomain(name, scope.domain);
      this.server.configurePoolLifetime(name, scope.leaseTimeSec, scope.leaseTimeSec);
    }

    if (serving.length === 0) { this.server.disable(); return; }
    this.server.enable();
  }

  poolOfInterface(iface: string): string | undefined {
    const scope = this.serving().find(entry => entry.iface === iface);
    return scope ? this.poolName(scope) : undefined;
  }

  private scopeOfPool(poolName: string): Dhcp6Scope | undefined {
    return [...this.scopes.values()].find(scope => this.poolName(scope) === poolName);
  }

  leases(): readonly Dhcp6Lease[] {
    return this.server.getBindings().map(binding => {
      const scope = this.scopeOfPool(binding.poolName);
      return {
        iface: scope?.iface ?? '',
        ip: binding.address,
        duid: binding.clientDuid,
        expiresAt: binding.leaseExpiration,
        serverId: scope?.id ?? '0',
      };
    });
  }

  clearLease(address: string): boolean {
    if (!isIpv6(address)) return false;
    const wanted = new IPv6Address(address).toString();
    for (const binding of this.server.getBindings()) {
      if (new IPv6Address(binding.address).toString() === wanted) {
        return this.server.clearBinding(binding.address);
      }
    }
    return false;
  }

  clearAllLeases(): number { return this.server.clearAllBindings(); }
}
