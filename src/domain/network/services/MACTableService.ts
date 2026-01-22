/**
 * MACTableService - MAC Address Table (CAM Table)
 *
 * Manages MAC address learning and lookup for switches.
 * Implements aging mechanism to remove stale entries.
 *
 * Design Pattern: Service (DDD)
 * - Stateless operations on domain objects
 * - Maintains MAC address table with aging
 * - Handles MAC learning, lookup, and expiration
 *
 * Features:
 * - MAC address learning (source MAC -> port mapping)
 * - Aging mechanism with configurable TTL
 * - Port-based queries (all MACs on port)
 * - Capacity management (max table size)
 * - Statistics tracking
 * - Export/Import for persistence
 *
 * @example
 * ```typescript
 * const macTable = new MACTableService({ maxSize: 1000 });
 *
 * // Learn MAC on port
 * macTable.learn(mac, 'eth0');
 *
 * // Lookup port for MAC
 * const port = macTable.lookup(mac);
 *
 * // Clean expired entries
 * macTable.cleanExpired();
 * ```
 */

import { MACAddress } from '../value-objects/MACAddress';

/**
 * MAC table entry
 */
interface MACTableEntry {
  mac: MACAddress;
  port: string;
  timestamp: number;
  agingTime: number; // seconds
}

/**
 * MAC table statistics
 */
export interface MACTableStatistics {
  tableSize: number;
  learningCount: number;
  moves: number;
  lookups: number;
  hits: number;
  misses: number;
}

/**
 * MAC table configuration
 */
export interface MACTableConfig {
  maxSize?: number;
  defaultAgingTime?: number;
}

/**
 * Default aging time for MAC entries (5 minutes)
 */
const DEFAULT_AGING_TIME = 300;

/**
 * Default maximum table size
 */
const DEFAULT_MAX_SIZE = 8192;

/**
 * MACTableService - Manages MAC address table
 */
export class MACTableService {
  private table: Map<string, MACTableEntry>;
  private statistics: MACTableStatistics;
  private config: Required<MACTableConfig>;

  constructor(config: MACTableConfig = {}) {
    this.table = new Map();
    this.statistics = {
      tableSize: 0,
      learningCount: 0,
      moves: 0,
      lookups: 0,
      hits: 0,
      misses: 0
    };
    this.config = {
      maxSize: config.maxSize ?? DEFAULT_MAX_SIZE,
      defaultAgingTime: config.defaultAgingTime ?? DEFAULT_AGING_TIME
    };
  }

  /**
   * Learns MAC address on port
   * Ignores broadcast and multicast addresses
   *
   * @param mac - MAC address to learn
   * @param port - Port where MAC was seen
   * @param agingTime - Custom aging time in seconds (optional)
   * @returns True if learned successfully
   */
  public learn(mac: MACAddress, port: string, agingTime?: number): boolean {
    // Don't learn broadcast or multicast addresses
    if (mac.isBroadcast() || mac.isMulticast()) {
      return false;
    }

    const key = mac.toString();
    const existingEntry = this.table.get(key);

    // Check if MAC is moving to different port
    const isMove = existingEntry !== undefined && existingEntry.port !== port;
    if (isMove) {
      this.statistics.moves++;
    }

    // Check capacity before adding new entry
    if (!existingEntry && this.table.size >= this.config.maxSize) {
      this.evictOldest();
    }

    const entry: MACTableEntry = {
      mac,
      port,
      timestamp: Date.now(),
      agingTime: agingTime ?? this.config.defaultAgingTime
    };

    this.table.set(key, entry);
    this.statistics.learningCount++;
    this.updateTableSize();

    return true;
  }

  /**
   * Looks up port for MAC address
   *
   * @param mac - MAC address to look up
   * @returns Port name or undefined if not found
   */
  public lookup(mac: MACAddress): string | undefined {
    this.statistics.lookups++;

    const key = mac.toString();
    const entry = this.table.get(key);

    if (!entry) {
      this.statistics.misses++;
      return undefined;
    }

    // Check if expired
    const age = (Date.now() - entry.timestamp) / 1000;
    if (age >= entry.agingTime) {
      this.table.delete(key);
      this.updateTableSize();
      this.statistics.misses++;
      return undefined;
    }

    this.statistics.hits++;
    return entry.port;
  }

  /**
   * Checks if MAC address is in table
   *
   * @param mac - MAC address
   * @returns True if MAC is in table and not expired
   */
  public hasEntry(mac: MACAddress): boolean {
    const key = mac.toString();
    const entry = this.table.get(key);

    if (!entry) {
      return false;
    }

    // Check if expired
    const age = (Date.now() - entry.timestamp) / 1000;
    if (age >= entry.agingTime) {
      this.table.delete(key);
      this.updateTableSize();
      return false;
    }

    return true;
  }

  /**
   * Gets MAC table entry (including metadata)
   *
   * @param mac - MAC address
   * @returns Table entry or undefined if not found
   */
  public getEntry(mac: MACAddress): MACTableEntry | undefined {
    const key = mac.toString();
    return this.table.get(key);
  }

  /**
   * Removes MAC entry from table
   *
   * @param mac - MAC address to remove
   */
  public remove(mac: MACAddress): void {
    const key = mac.toString();
    this.table.delete(key);
    this.updateTableSize();
  }

  /**
   * Removes all MACs learned on specific port
   *
   * @param port - Port name
   */
  public removePort(port: string): void {
    const keysToRemove: string[] = [];

    for (const [key, entry] of this.table.entries()) {
      if (entry.port === port) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.table.delete(key);
    }

    this.updateTableSize();
  }

  /**
   * Clears all entries from table
   */
  public clear(): void {
    this.table.clear();
    this.updateTableSize();
  }

  /**
   * Removes expired entries from table
   */
  public cleanExpired(): void {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const [key, entry] of this.table.entries()) {
      const age = (now - entry.timestamp) / 1000;
      if (age >= entry.agingTime) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.table.delete(key);
    }

    this.updateTableSize();
  }

  /**
   * Evicts oldest entry from table (used when table is full)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of this.table.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.table.delete(oldestKey);
      this.updateTableSize();
    }
  }

  /**
   * Returns all MACs learned on specific port
   *
   * @param port - Port name
   * @returns Array of MAC addresses on port
   */
  public getPortMACs(port: string): MACAddress[] {
    const macs: MACAddress[] = [];

    for (const entry of this.table.values()) {
      if (entry.port === port) {
        macs.push(entry.mac);
      }
    }

    return macs;
  }

  /**
   * Returns all ports in table
   *
   * @returns Array of unique port names
   */
  public getAllPorts(): string[] {
    const ports = new Set<string>();

    for (const entry of this.table.values()) {
      ports.add(entry.port);
    }

    return Array.from(ports);
  }

  /**
   * Returns current statistics
   *
   * @returns MAC table statistics
   */
  public getStatistics(): Readonly<MACTableStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets statistics (but not table)
   */
  public resetStatistics(): void {
    this.statistics.learningCount = 0;
    this.statistics.moves = 0;
    this.statistics.lookups = 0;
    this.statistics.hits = 0;
    this.statistics.misses = 0;
    // Keep tableSize as is
  }

  /**
   * Updates table size in statistics
   */
  private updateTableSize(): void {
    this.statistics.tableSize = this.table.size;
  }

  /**
   * Exports table to JSON-serializable format
   *
   * @returns Array of table entries
   */
  public export(): Array<{
    mac: string;
    port: string;
    timestamp: number;
    agingTime: number;
  }> {
    const entries: Array<{
      mac: string;
      port: string;
      timestamp: number;
      agingTime: number;
    }> = [];

    for (const entry of this.table.values()) {
      entries.push({
        mac: entry.mac.toString(),
        port: entry.port,
        timestamp: entry.timestamp,
        agingTime: entry.agingTime
      });
    }

    return entries;
  }

  /**
   * Imports table from JSON format
   *
   * @param data - Array of table entries
   */
  public import(
    data: Array<{
      mac: string;
      port: string;
      timestamp: number;
      agingTime: number;
    }>
  ): void {
    this.clear();

    for (const item of data) {
      const mac = new MACAddress(item.mac);
      const entry: MACTableEntry = {
        mac,
        port: item.port,
        timestamp: item.timestamp,
        agingTime: item.agingTime
      };

      this.table.set(mac.toString(), entry);
    }

    this.updateTableSize();
  }
}
