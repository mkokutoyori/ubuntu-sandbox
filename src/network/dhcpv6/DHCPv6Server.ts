/**
 * DHCPv6Server - stateful DHCPv6 address-assignment engine (RFC 8415).
 *
 * Mirrors ../dhcp/DHCPServer.ts's shape (pools, bindings, subnet-anchored
 * pool selection) for IA_NA (non-temporary address) assignment. Prefix
 * delegation (IA_PD) and stateless (INFORMATION-REQUEST-only) service are
 * out of scope — this covers the SOLICIT/ADVERTISE/REQUEST/REPLY/RELEASE
 * core that a real client actually needs to obtain an address.
 */

import { IPv6Address } from '../core/types';
import { ipv6FromBigInt, ipv6ToBigInt } from '../core/Ipv6Arithmetic';
import {
  DHCPv6PoolConfig, DHCPv6Binding, DHCPv6SolicitParams, DHCPv6RequestParams,
  DHCPv6LeaseResult, DHCPv6ReleaseParams, DHCPv6AddressRange, createDefaultDHCPv6Pool,
  DHCPv6PrefixBinding, DHCPv6StaticDelegation,
} from './types';

const RANGE_SCAN_LIMIT = 65536;

export class DHCPv6Server {
  private enabled = false;
  private serverDuid: string = '00:03:00:01:00:00:00:00:00:01';
  private pools: Map<string, DHCPv6PoolConfig> = new Map();
  /** Address → binding. */
  private bindings: Map<string, DHCPv6Binding> = new Map();
  /** Address reserved between SOLICIT and REQUEST (RFC 8415 §18.3.1). */
  private pendingOffers: Map<string, { clientDuid: string; iaid: number; poolName: string }> = new Map();
  private prefixBindings: Map<string, DHCPv6PrefixBinding> = new Map();
  private pendingPrefixes: Map<string, { clientDuid: string; iaid: number; poolName: string }> = new Map();
  private declined: Map<string, number> = new Map();
  private rapidCommit = false;
  private preference = 0;
  private clock: () => number = () => Date.now();

  setRapidCommit(enabled: boolean): void { this.rapidCommit = enabled; }
  isRapidCommit(): boolean { return this.rapidCommit; }
  setPreference(value: number): void { this.preference = Math.max(0, Math.min(255, Math.trunc(value))); }
  getPreference(): number { return this.preference; }

  setClock(clock: () => number): void { this.clock = clock; }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  setServerDuid(duid: string): void { this.serverDuid = duid; }
  getServerDuid(): string { return this.serverDuid; }

  createPool(name: string): DHCPv6PoolConfig {
    const pool = createDefaultDHCPv6Pool(name);
    this.pools.set(name, pool);
    return pool;
  }

  getPool(name: string): DHCPv6PoolConfig | undefined { return this.pools.get(name); }
  getAllPools(): Map<string, DHCPv6PoolConfig> { return this.pools; }
  deletePool(name: string): boolean { return this.pools.delete(name); }

  configurePoolPrefix(name: string, prefix: string, prefixLength: number): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.prefix = new IPv6Address(prefix).getNetworkPrefix(prefixLength).toString();
    pool.prefixLength = prefixLength;
    return true;
  }

  configurePoolRanges(name: string, ranges: readonly DHCPv6AddressRange[]): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.ranges = ranges.map(range => ({ ...range }));
    return true;
  }

  configurePoolDns(name: string, servers: string[]): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.dnsServers = servers;
    return true;
  }

  configurePoolDomain(name: string, domain: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.domainName = domain;
    return true;
  }

  configurePoolLifetime(name: string, preferred: number, valid: number): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.preferredLifetime = preferred;
    pool.validLifetime = valid;
    return true;
  }

  getBindings(): DHCPv6Binding[] { return [...this.bindings.values()]; }

  clearBinding(address: string): boolean { return this.bindings.delete(address); }

  clearAllBindings(): number {
    const removed = this.bindings.size + this.prefixBindings.size;
    this.bindings.clear();
    this.prefixBindings.clear();
    this.pendingOffers.clear();
    this.pendingPrefixes.clear();
    this.declined.clear();
    return removed;
  }

  getPrefixBindings(): DHCPv6PrefixBinding[] { return [...this.prefixBindings.values()]; }

  getDeclinedAddresses(): string[] { return [...this.declined.keys()]; }

  clearDeclined(address: string): boolean { return this.declined.delete(address); }

  clearPrefixBinding(prefix: string, prefixLength: number): boolean {
    return this.prefixBindings.delete(`${prefix}/${prefixLength}`);
  }

  configurePoolDelegation(name: string, prefix: string, prefixLength: number, assignedLength: number): boolean {
    const pool = this.pools.get(name);
    if (!pool || assignedLength < prefixLength || assignedLength > 128) return false;
    const network = new IPv6Address(prefix).getNetworkPrefix(prefixLength).toString();
    pool.delegations = [
      ...pool.delegations.filter(d => !(d.prefix === network && d.prefixLength === prefixLength)),
      { prefix: network, prefixLength, assignedLength },
    ];
    return true;
  }

  configurePoolStaticDelegation(name: string, delegation: DHCPv6StaticDelegation): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    const network = new IPv6Address(delegation.prefix).getNetworkPrefix(delegation.prefixLength).toString();
    pool.staticDelegations = [
      ...pool.staticDelegations.filter(d => !(d.prefix === network && d.prefixLength === delegation.prefixLength)),
      { ...delegation, prefix: network },
    ];
    return true;
  }

  /**
   * Candidate pools for this exchange: an explicit interface→pool binding
   * (`ipv6 dhcp server <pool>`) takes precedence; otherwise fall back to
   * subnet-anchored selection by the relay's link-address (RFC 8415 §18.4,
   * mirrors giaddr-based pool selection on the v4 engine).
   */
  private resolvePools(anchor?: string, explicitPoolName?: string): DHCPv6PoolConfig[] {
    if (explicitPoolName) {
      const pool = this.pools.get(explicitPoolName);
      return pool ? [pool] : [];
    }
    const all = [...this.pools.values()].filter(p => p.prefix && p.prefixLength);
    if (!anchor) return all;
    const anchorIp = new IPv6Address(anchor);
    const matching = all.filter(p => anchorIp.isInSameSubnet(new IPv6Address(p.prefix!), p.prefixLength!));
    return matching.length > 0 ? matching : all;
  }

  private findBindingForClient(clientDuid: string, iaid: number, poolName: string): DHCPv6Binding | null {
    for (const b of this.bindings.values()) {
      if (b.clientDuid === clientDuid && b.iaid === iaid && b.poolName === poolName) return b;
    }
    return null;
  }

  private addressFreeAndInPool(candidate: string, pool: DHCPv6PoolConfig): boolean {
    if (this.bindings.has(candidate) || this.pendingOffers.has(candidate) || this.declined.has(candidate)) return false;
    if (!pool.prefix || !pool.prefixLength) return true;
    return new IPv6Address(candidate)
      .isInSameSubnet(new IPv6Address(pool.prefix), pool.prefixLength);
  }

  private findInRanges(pool: DHCPv6PoolConfig): string | null {
    for (const range of pool.ranges) {
      let first: bigint;
      let last: bigint;
      try {
        first = ipv6ToBigInt(new IPv6Address(range.startIp));
        last = ipv6ToBigInt(new IPv6Address(range.endIp));
      } catch {
        continue;
      }
      if (last < first) continue;
      const ceiling = first + BigInt(RANGE_SCAN_LIMIT);
      for (let value = first; value <= last && value < ceiling; value++) {
        const candidate = ipv6FromBigInt(value).toString();
        if (this.addressFreeAndInPool(candidate, pool)) return candidate;
      }
    }
    return null;
  }

  /** First unused address in the pool's prefix (host portion, starting at ::2 — ::1 is conventionally the router). */
  private findAvailableAddress(pool: DHCPv6PoolConfig): string | null {
    if (pool.ranges.length > 0) return this.findInRanges(pool);
    if (!pool.prefix || !pool.prefixLength) return null;
    const prefixHextets = new IPv6Address(pool.prefix).getHextets();
    const hostBits = 128 - pool.prefixLength;
    const maxHost = hostBits >= 32 ? 0xfffe : (1 << hostBits) - 2;
    for (let host = 2; host <= maxHost && host < 0xfffe; host++) {
      const hextets = [...prefixHextets];
      hextets[7] = host & 0xffff;
      hextets[6] = (hextets[6] & 0xffff) | (host >> 16);
      const candidate = new IPv6Address(hextets).toString();
      if (this.bindings.has(candidate) || this.pendingOffers.has(candidate) || this.declined.has(candidate)) continue;
      return candidate;
    }
    return null;
  }

  processSolicit(params: DHCPv6SolicitParams, explicitPoolName?: string): DHCPv6LeaseResult | null {
    const pools = this.resolvePools(params.linkAddress, explicitPoolName);
    for (const pool of pools) {
      const existing = this.findBindingForClient(params.clientDuid, params.iaid, pool.name);
      if (existing) {
        return { address: existing.address, pool, serverDuid: this.serverDuid, transactionId: params.transactionId };
      }
      for (const [addr, pending] of this.pendingOffers) {
        if (pending.clientDuid === params.clientDuid && pending.iaid === params.iaid && pending.poolName === pool.name) {
          return { address: addr, pool, serverDuid: this.serverDuid, transactionId: params.transactionId };
        }
      }
      const address = this.findAvailableAddress(pool);
      if (!address) continue;
      this.pendingOffers.set(address, { clientDuid: params.clientDuid, iaid: params.iaid, poolName: pool.name });
      return { address, pool, serverDuid: this.serverDuid, transactionId: params.transactionId };
    }
    return null;
  }

  processRequest(params: DHCPv6RequestParams, explicitPoolName?: string): DHCPv6LeaseResult | null {
    if (params.serverDuid !== this.serverDuid) return null;
    const pools = this.resolvePools(params.linkAddress, explicitPoolName);
    for (const pool of pools) {
      const pending = this.pendingOffers.get(params.requestedAddress);
      const alreadyBound = this.findBindingForClient(params.clientDuid, params.iaid, pool.name);
      const owned = (pending && pending.clientDuid === params.clientDuid && pending.iaid === params.iaid && pending.poolName === pool.name)
        || (alreadyBound && alreadyBound.address === params.requestedAddress);
      if (!owned) continue;
      this.pendingOffers.delete(params.requestedAddress);
      const now = this.clock();
      this.bindings.set(params.requestedAddress, {
        clientDuid: params.clientDuid, iaid: params.iaid, address: params.requestedAddress,
        poolName: pool.name, leaseStart: now, leaseExpiration: now + pool.validLifetime * 1000,
      });
      return { address: params.requestedAddress, pool, serverDuid: this.serverDuid, transactionId: params.transactionId };
    }
    return null;
  }

  /**
   * INFORMATION-REQUEST (RFC 8415 §18.3.5): the other configuration and
   * nothing else. No address is assigned and NO binding recorded — that
   * is what stateless means, so this touches neither `bindings` nor
   * `pendingOffers` and a pool queried a hundred times is not drained.
   *
   * A pool with no prefix is legitimate here: an `ipv6 dhcp pool`
   * carrying only a `dns-server` is exactly the stateless setup.
   */
  processInformationRequest(
    params: { transactionId: number }, explicitPoolName?: string, anchor?: string,
  ): { pool: DHCPv6PoolConfig; serverDuid: string; transactionId: number } | null {
    void params;
    const pools = explicitPoolName
      ? this.resolvePools(undefined, explicitPoolName)
      : [...this.pools.values()].filter((p) => {
        if (!anchor || !p.prefix || !p.prefixLength) return true;
        return new IPv6Address(anchor).isInSameSubnet(new IPv6Address(p.prefix), p.prefixLength);
      });
    const pool = pools.find((p) => p.dnsServers.length > 0 || p.domainName) ?? pools[0];
    if (!pool) return null;
    return { pool, serverDuid: this.serverDuid, transactionId: params.transactionId };
  }

  processRelease(params: DHCPv6ReleaseParams): boolean {
    const binding = this.bindings.get(params.address);
    if (binding && binding.clientDuid === params.clientDuid && binding.iaid === params.iaid) {
      this.bindings.delete(params.address);
      return true;
    }
    return false;
  }

  addressOnLink(address: string, anchor?: string, explicitPoolName?: string): boolean | null {
    const pools = explicitPoolName
      ? this.resolvePools(undefined, explicitPoolName)
      : this.resolvePools(anchor).filter(p => p.prefix && p.prefixLength);
    const withPrefix = pools.filter(p => p.prefix && p.prefixLength);
    if (withPrefix.length === 0) return null;
    const candidate = new IPv6Address(address);
    return withPrefix.some(p => candidate.isInSameSubnet(new IPv6Address(p.prefix!), p.prefixLength!));
  }

  findBinding(clientDuid: string, iaid: number, address: string): DHCPv6Binding | null {
    const binding = this.bindings.get(address);
    return binding && binding.clientDuid === clientDuid && binding.iaid === iaid ? binding : null;
  }

  hasIaBinding(clientDuid: string, iaid: number): boolean {
    for (const b of this.bindings.values()) if (b.clientDuid === clientDuid && b.iaid === iaid) return true;
    for (const b of this.prefixBindings.values()) if (b.clientDuid === clientDuid && b.iaid === iaid) return true;
    return false;
  }

  extendAddress(clientDuid: string, iaid: number, address: string): DHCPv6LeaseResult | null {
    const binding = this.findBinding(clientDuid, iaid, address);
    const pool = binding ? this.pools.get(binding.poolName) : undefined;
    if (!binding || !pool) return null;
    const now = this.clock();
    binding.leaseStart = now;
    binding.leaseExpiration = now + pool.validLifetime * 1000;
    return { address, pool, serverDuid: this.serverDuid, transactionId: 0 };
  }

  declineAddress(clientDuid: string, iaid: number, address: string): boolean {
    if (!this.findBinding(clientDuid, iaid, address)) return false;
    this.bindings.delete(address);
    this.declined.set(address, this.clock());
    return true;
  }

  private delegationPools(explicitPoolName?: string, anchor?: string): DHCPv6PoolConfig[] {
    if (explicitPoolName) {
      const pool = this.pools.get(explicitPoolName);
      return pool ? [pool] : [];
    }
    const withDelegation = [...this.pools.values()].filter(p => p.delegations.length > 0 || p.staticDelegations.length > 0);
    if (!anchor) return withDelegation;
    const anchorIp = new IPv6Address(anchor);
    const onLink = withDelegation.filter(p => p.prefix && p.prefixLength
      && anchorIp.isInSameSubnet(new IPv6Address(p.prefix), p.prefixLength));
    return onLink.length > 0 ? onLink : withDelegation;
  }

  private prefixKey(prefix: string, length: number): string {
    return `${new IPv6Address(prefix).getNetworkPrefix(length).toString()}/${length}`;
  }

  private prefixTaken(key: string): boolean {
    return this.prefixBindings.has(key) || this.pendingPrefixes.has(key);
  }

  private carvePrefix(pool: DHCPv6PoolConfig): { prefix: string; length: number } | null {
    for (const delegation of pool.delegations) {
      const step = 1n << BigInt(128 - delegation.assignedLength);
      const base = ipv6ToBigInt(new IPv6Address(delegation.prefix));
      const count = 1n << BigInt(delegation.assignedLength - delegation.prefixLength);
      const ceiling = count < BigInt(RANGE_SCAN_LIMIT) ? count : BigInt(RANGE_SCAN_LIMIT);
      for (let index = 0n; index < ceiling; index++) {
        const candidate = ipv6FromBigInt(base + index * step).toString();
        if (!this.prefixTaken(this.prefixKey(candidate, delegation.assignedLength))
          && !this.staticallyReserved(candidate, delegation.assignedLength)) {
          return { prefix: candidate, length: delegation.assignedLength };
        }
      }
    }
    return null;
  }

  private staticallyReserved(prefix: string, length: number): boolean {
    const key = this.prefixKey(prefix, length);
    for (const pool of this.pools.values()) {
      for (const entry of pool.staticDelegations) {
        if (this.prefixKey(entry.prefix, entry.prefixLength) === key) return true;
      }
    }
    return false;
  }

  offerPrefix(
    clientDuid: string, iaid: number, explicitPoolName?: string, anchor?: string,
  ): { prefix: string; prefixLength: number; pool: DHCPv6PoolConfig } | null {
    for (const pool of this.delegationPools(explicitPoolName, anchor)) {
      for (const binding of this.prefixBindings.values()) {
        if (binding.clientDuid === clientDuid && binding.iaid === iaid && binding.poolName === pool.name) {
          return { prefix: binding.prefix, prefixLength: binding.prefixLength, pool };
        }
      }
      for (const [key, pending] of this.pendingPrefixes) {
        if (pending.clientDuid === clientDuid && pending.iaid === iaid && pending.poolName === pool.name) {
          const [prefix, length] = key.split('/');
          return { prefix, prefixLength: parseInt(length, 10), pool };
        }
      }
      const fixed = pool.staticDelegations.find(d => d.clientDuid === clientDuid && (d.iaid === null || d.iaid === iaid));
      const chosen = fixed ? { prefix: fixed.prefix, length: fixed.prefixLength } : this.carvePrefix(pool);
      if (!chosen) continue;
      this.pendingPrefixes.set(this.prefixKey(chosen.prefix, chosen.length), { clientDuid, iaid, poolName: pool.name });
      return { prefix: chosen.prefix, prefixLength: chosen.length, pool };
    }
    return null;
  }

  commitPrefix(
    clientDuid: string, iaid: number, prefix: string, prefixLength: number, explicitPoolName?: string, anchor?: string,
  ): { prefix: string; prefixLength: number; pool: DHCPv6PoolConfig } | null {
    const key = this.prefixKey(prefix, prefixLength);
    const network = key.split('/')[0];
    for (const pool of this.delegationPools(explicitPoolName, anchor)) {
      const pending = this.pendingPrefixes.get(key);
      const existing = this.prefixBindings.get(key);
      const owned = (pending && pending.clientDuid === clientDuid && pending.iaid === iaid && pending.poolName === pool.name)
        || (existing && existing.clientDuid === clientDuid && existing.iaid === iaid);
      if (!owned) continue;
      this.pendingPrefixes.delete(key);
      const now = this.clock();
      this.prefixBindings.set(key, {
        clientDuid, iaid, prefix: network, prefixLength, poolName: pool.name,
        leaseStart: now, leaseExpiration: now + pool.validLifetime * 1000,
      });
      return { prefix: network, prefixLength, pool };
    }
    return null;
  }

  extendPrefix(clientDuid: string, iaid: number, prefix: string, prefixLength: number): { pool: DHCPv6PoolConfig } | null {
    const binding = this.prefixBindings.get(this.prefixKey(prefix, prefixLength));
    const pool = binding ? this.pools.get(binding.poolName) : undefined;
    if (!binding || !pool || binding.clientDuid !== clientDuid || binding.iaid !== iaid) return null;
    const now = this.clock();
    binding.leaseStart = now;
    binding.leaseExpiration = now + pool.validLifetime * 1000;
    return { pool };
  }

  releasePrefix(clientDuid: string, iaid: number, prefix: string, prefixLength: number): boolean {
    const key = this.prefixKey(prefix, prefixLength);
    const binding = this.prefixBindings.get(key);
    if (!binding || binding.clientDuid !== clientDuid || binding.iaid !== iaid) return false;
    return this.prefixBindings.delete(key);
  }

  prefixOnLink(prefix: string, prefixLength: number, explicitPoolName?: string, anchor?: string): boolean | null {
    const pools = this.delegationPools(explicitPoolName, anchor);
    if (pools.length === 0) return null;
    const candidate = new IPv6Address(prefix);
    return pools.some(pool => [...pool.delegations, ...pool.staticDelegations].some(entry => {
      const length = 'assignedLength' in entry ? entry.assignedLength : entry.prefixLength;
      return length === prefixLength && candidate.isInSameSubnet(new IPv6Address(entry.prefix), entry.prefixLength);
    }));
  }
}
