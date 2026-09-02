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
    const removed = this.bindings.size;
    this.bindings.clear();
    this.pendingOffers.clear();
    return removed;
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
    if (this.bindings.has(candidate) || this.pendingOffers.has(candidate)) return false;
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
      if (this.bindings.has(candidate) || this.pendingOffers.has(candidate)) continue;
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
      const now = Date.now();
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

  processRelease(params: DHCPv6ReleaseParams): void {
    const binding = this.bindings.get(params.address);
    if (binding && binding.clientDuid === params.clientDuid && binding.iaid === params.iaid) {
      this.bindings.delete(params.address);
    }
  }
}
