/**
 * NeighborResolver — Generic address resolution abstraction
 *
 * Fixes:
 * - 1.2: Eliminates ~300 lines of duplicated ARP/NDP resolution logic
 * - 1.9: Adds proper cache TTL, size limiting, and cleanup
 *
 * Shared data structures and patterns for both:
 * - ARP (IPv4 → MAC, RFC 826)
 * - NDP (IPv6 → MAC, RFC 4861)
 */

import type { MACAddress } from './types';
import type { INeighborEntry } from './interfaces';
import { ARP_TIMERS } from './constants';

/**
 * Pending resolution callback.
 */
interface PendingResolution {
  resolve: (mac: MACAddress) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Extended neighbor entry with TTL support.
 */
export interface NeighborEntry extends INeighborEntry {
  /** NDP state (only used for IPv6) */
  state?: 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';
  /** Whether this neighbor is a router (IPv6 only) */
  isRouter?: boolean;
}

/**
 * Generic neighbor resolver that unifies ARP and NDP resolution patterns.
 *
 * Both protocols follow the same fundamental pattern:
 * 1. Check cache → if hit, return immediately
 * 2. If miss, send solicitation and queue callback
 * 3. On response, update cache and resolve all pending callbacks
 * 4. On timeout, reject pending callbacks
 *
 * @typeParam TAddress - The address type (string for both IPv4 and IPv6)
 *
 * @example
 * ```ts
 * const arpResolver = new NeighborResolver<IPAddress>('ARP');
 * arpResolver.learn('10.0.0.1', '00:11:22:33:44:55', 'eth0');
 * const mac = await arpResolver.resolve('10.0.0.2', 'eth0', sendARPRequest);
 * ```
 */
export class NeighborResolver<TAddress extends string> {
  private cache: Map<string, NeighborEntry> = new Map();
  private pending: Map<string, PendingResolution[]> = new Map();

  /**
   * @param protocol - Protocol name for logging ('ARP' or 'NDP')
   * @param timeoutMs - Resolution timeout in ms
   * @param cacheTTLMs - Cache entry TTL in ms (0 = no expiration)
   */
  constructor(
    private readonly protocol: string,
    private readonly timeoutMs: number = ARP_TIMERS.REQUEST_TIMEOUT_MS,
    private readonly cacheTTLMs: number = ARP_TIMERS.CACHE_TTL_MS,
  ) {}

  /**
   * Learn a neighbor mapping (called on incoming ARP reply or NDP NA).
   */
  learn(address: TAddress, mac: MACAddress, iface: string, extra?: Partial<NeighborEntry>): void {
    this.cache.set(address, {
      mac,
      iface,
      timestamp: Date.now(),
      ...extra,
    });

    // Resolve any pending requests for this address
    const pendingList = this.pending.get(address);
    if (pendingList) {
      for (const p of pendingList) {
        clearTimeout(p.timer);
        p.resolve(mac);
      }
      this.pending.delete(address);
    }
  }

  /**
   * Look up a cached entry. Returns undefined if not found or expired.
   */
  lookup(address: TAddress): NeighborEntry | undefined {
    const entry = this.cache.get(address);
    if (!entry) return undefined;

    // Check TTL
    if (this.cacheTTLMs > 0 && Date.now() - entry.timestamp > this.cacheTTLMs) {
      this.cache.delete(address);
      return undefined;
    }

    return entry;
  }

  /**
   * Resolve an address to a MAC, with async solicitation if needed.
   *
   * @param address - The L3 address to resolve
   * @param iface - The interface to send the solicitation on
   * @param sendSolicitation - Function to send the actual ARP request or NDP NS
   */
  resolve(
    address: TAddress,
    iface: string,
    sendSolicitation: (address: TAddress, iface: string) => void,
  ): Promise<MACAddress> {
    // Check cache first
    const cached = this.lookup(address);
    if (cached) {
      return Promise.resolve(cached.mac);
    }

    return new Promise<MACAddress>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this specific pending entry on timeout
        const list = this.pending.get(address);
        if (list) {
          const idx = list.findIndex(p => p.resolve === resolve);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.pending.delete(address);
        }
        reject(`${this.protocol} resolution timeout for ${address}`);
      }, this.timeoutMs);

      const pendingEntry: PendingResolution = { resolve, reject, timer };

      const existingList = this.pending.get(address);
      if (existingList) {
        existingList.push(pendingEntry);
        // Don't send another solicitation — one is already in flight
      } else {
        this.pending.set(address, [pendingEntry]);
        sendSolicitation(address, iface);
      }
    });
  }

  /**
   * Check if there are pending resolutions for an address.
   */
  hasPending(address: TAddress): boolean {
    return this.pending.has(address);
  }

  /** Get the full cache (read-only copy) */
  getCache(): Map<string, NeighborEntry> {
    return new Map(this.cache);
  }

  /** Get cache size */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Clear the entire cache and reject all pending */
  clear(): void {
    // Reject all pending
    for (const [addr, list] of this.pending) {
      for (const p of list) {
        clearTimeout(p.timer);
        p.reject(`${this.protocol} cache cleared`);
      }
    }
    this.pending.clear();
    this.cache.clear();
  }

  /** Remove a specific entry from the cache */
  remove(address: TAddress): boolean {
    return this.cache.delete(address);
  }

  /**
   * Purge expired entries from the cache.
   * @returns Number of entries purged
   */
  purgeExpired(): number {
    if (this.cacheTTLMs <= 0) return 0;

    const now = Date.now();
    let count = 0;

    for (const [addr, entry] of this.cache) {
      if (now - entry.timestamp > this.cacheTTLMs) {
        this.cache.delete(addr);
        count++;
      }
    }

    return count;
  }
}
