/**
 * RoutingTable — Generic routing table with Longest Prefix Match (LPM)
 *
 * Fixes:
 * - 1.6: Missing RoutingTable abstraction (was raw RouteEntry[] with O(n) linear scan)
 * - 1.2: Shared between IPv4 and IPv6 via generics (eliminates duplication)
 *
 * Supports both IPv4 (mask-based) and IPv6 (prefix-length-based) routes
 * through a generic prefix-length extractor function.
 */

import type { IPAddress, SubnetMask, IPv6Address } from './types';
import type { IIPv4Route, IIPv6Route } from './interfaces';

// ─── Generic Routing Table ──────────────────────────────────────────

/**
 * Generic routing table entry with prefix length for LPM.
 */
interface RoutingEntry<TRoute> {
  route: TRoute;
  prefixLength: number;
}

/**
 * Generic Routing Table with Longest Prefix Match (LPM).
 *
 * @typeParam TAddress - The address type (IPAddress or IPv6Address)
 * @typeParam TRoute - The route entry type
 *
 * @example
 * ```ts
 * const ipv4Table = new IPv4RoutingTable();
 * ipv4Table.addRoute({ network: '10.0.0.0', mask: '255.255.255.0', ... });
 * const route = ipv4Table.lookup('10.0.0.5');
 * ```
 */
export class RoutingTable<TAddress extends string, TRoute extends { ad: number; metric: number }> {
  private entries: RoutingEntry<TRoute>[] = [];

  constructor(
    private readonly getPrefixLength: (route: TRoute) => number,
    private readonly matchesFn: (route: TRoute, destination: TAddress) => boolean,
    private readonly getNetwork: (route: TRoute) => TAddress,
    private readonly getIface: (route: TRoute) => string,
    private readonly getType: (route: TRoute) => string,
  ) {}

  /** Add a route to the table */
  addRoute(route: TRoute): void {
    const prefixLength = this.getPrefixLength(route);

    // Replace existing route with same network + interface + type
    const existingIndex = this.entries.findIndex(
      e =>
        this.getNetwork(e.route) === this.getNetwork(route) &&
        this.getPrefixLength(e.route) === prefixLength &&
        this.getIface(e.route) === this.getIface(route) &&
        this.getType(e.route) === this.getType(route),
    );

    if (existingIndex >= 0) {
      this.entries[existingIndex] = { route, prefixLength };
    } else {
      this.entries.push({ route, prefixLength });
    }
  }

  /**
   * Remove routes matching the given criteria.
   * Returns true if any routes were removed.
   */
  removeRoute(network: TAddress, iface?: string, type?: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => {
      if (this.getNetwork(e.route) !== network) return true;
      if (iface && this.getIface(e.route) !== iface) return true;
      if (type && this.getType(e.route) !== type) return true;
      return false;
    });
    return this.entries.length < before;
  }

  /**
   * Longest Prefix Match (LPM) lookup.
   *
   * Finds the most specific matching route. On ties:
   * 1. Longest prefix wins
   * 2. Lower AD wins
   * 3. Lower metric wins
   */
  lookup(destination: TAddress): TRoute | null {
    let bestRoute: TRoute | null = null;
    let bestPrefixLength = -1;
    let bestAD = Infinity;
    let bestMetric = Infinity;

    for (const entry of this.entries) {
      if (!this.matchesFn(entry.route, destination)) continue;

      const prefixLen = entry.prefixLength;
      if (
        prefixLen > bestPrefixLength ||
        (prefixLen === bestPrefixLength && entry.route.ad < bestAD) ||
        (prefixLen === bestPrefixLength && entry.route.ad === bestAD && entry.route.metric < bestMetric)
      ) {
        bestRoute = entry.route;
        bestPrefixLength = prefixLen;
        bestAD = entry.route.ad;
        bestMetric = entry.route.metric;
      }
    }

    return bestRoute;
  }

  /** Get all routes */
  getRoutes(): TRoute[] {
    return this.entries.map(e => e.route);
  }

  /** Clear all routes of a given type */
  clearByType(type: string): void {
    this.entries = this.entries.filter(e => this.getType(e.route) !== type);
  }

  /** Clear all routes */
  clear(): void {
    this.entries = [];
  }

  /** Get the number of routes */
  get size(): number {
    return this.entries.length;
  }
}

// ─── IPv4 Routing Table ─────────────────────────────────────────────

/**
 * Compute prefix length from a subnet mask.
 * e.g., "255.255.255.0" → 24
 */
export function maskToPrefixLength(mask: SubnetMask): number {
  const parts = mask.split('.').map(Number);
  let bits = 0;
  for (const part of parts) {
    bits += (part >>> 0).toString(2).split('1').length - 1;
  }
  return bits;
}

/**
 * Check if an IP address matches a network/mask pair.
 */
export function ipMatchesNetwork(ip: IPAddress, network: IPAddress, mask: SubnetMask): boolean {
  const ipParts = ip.split('.').map(Number);
  const netParts = network.split('.').map(Number);
  const maskParts = mask.split('.').map(Number);

  for (let i = 0; i < 4; i++) {
    if ((ipParts[i] & maskParts[i]) !== (netParts[i] & maskParts[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Pre-configured IPv4 routing table.
 */
export function createIPv4RoutingTable(): RoutingTable<IPAddress, IIPv4Route> {
  return new RoutingTable<IPAddress, IIPv4Route>(
    route => maskToPrefixLength(route.mask),
    (route, dest) => ipMatchesNetwork(dest, route.network, route.mask),
    route => route.network,
    route => route.iface,
    route => route.type,
  );
}

// ─── IPv6 Routing Table ─────────────────────────────────────────────

/**
 * Expand an IPv6 address to its full 8-group representation.
 */
function expandIPv6(addr: string): string {
  // Handle :: expansion
  let fullAddr = addr.toLowerCase();
  if (fullAddr.includes('::')) {
    const parts = fullAddr.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0000');
    fullAddr = [...left, ...middle, ...right].join(':');
  }
  return fullAddr
    .split(':')
    .map(g => g.padStart(4, '0'))
    .join(':');
}

/**
 * Check if an IPv6 address matches a prefix/length pair.
 */
export function ipv6MatchesPrefix(addr: IPv6Address, prefix: IPv6Address, prefixLength: number): boolean {
  const expandedAddr = expandIPv6(addr);
  const expandedPrefix = expandIPv6(prefix);

  const addrBits = expandedAddr
    .split(':')
    .map(g => parseInt(g, 16).toString(2).padStart(16, '0'))
    .join('');
  const prefixBits = expandedPrefix
    .split(':')
    .map(g => parseInt(g, 16).toString(2).padStart(16, '0'))
    .join('');

  return addrBits.substring(0, prefixLength) === prefixBits.substring(0, prefixLength);
}

/**
 * Pre-configured IPv6 routing table.
 */
export function createIPv6RoutingTable(): RoutingTable<IPv6Address, IIPv6Route> {
  return new RoutingTable<IPv6Address, IIPv6Route>(
    route => route.prefixLength,
    (route, dest) => ipv6MatchesPrefix(dest, route.network, route.prefixLength),
    route => route.network,
    route => route.iface,
    route => route.type,
  );
}
