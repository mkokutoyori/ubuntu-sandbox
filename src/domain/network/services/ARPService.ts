/**
 * ARPService - Address Resolution Protocol (RFC 826)
 *
 * Manages ARP cache and packet creation/processing.
 * Maps IP addresses to MAC addresses at Layer 2.
 *
 * Design Pattern: Service (DDD)
 * - Stateless operations on domain objects
 * - Maintains ARP cache with TTL
 * - Handles ARP request/reply creation and processing
 *
 * Features:
 * - ARP cache management with TTL
 * - Automatic expiration of old entries
 * - ARP request/reply packet creation
 * - Gratuitous ARP support
 * - Packet serialization/deserialization
 *
 * @example
 * ```typescript
 * const arpService = new ARPService();
 *
 * // Add entry to cache
 * arpService.addEntry(ip, mac, 300); // 5 minutes TTL
 *
 * // Resolve IP to MAC
 * const mac = arpService.resolve(ip);
 *
 * // Create ARP request
 * const request = arpService.createRequest(senderIP, senderMAC, targetIP);
 *
 * // Process ARP packet
 * arpService.processPacket(arpPacket);
 * ```
 */

import { IPAddress } from '../value-objects/IPAddress';
import { MACAddress } from '../value-objects/MACAddress';

/**
 * ARP packet operation type
 */
export type ARPOperation = 'request' | 'reply';

/**
 * ARP packet structure
 */
export interface ARPPacket {
  operation: ARPOperation;
  senderMAC: MACAddress;
  senderIP: IPAddress;
  targetMAC: MACAddress;
  targetIP: IPAddress;
}

/**
 * ARP cache entry
 */
interface ARPCacheEntry {
  mac: MACAddress;
  timestamp: number;
  ttl: number; // seconds
}

/**
 * ARP statistics
 */
export interface ARPStatistics {
  cacheSize: number;
  requestsSent: number;
  repliesSent: number;
  packetsProcessed: number;
}

/**
 * Default TTL for ARP cache entries (5 minutes)
 */
const DEFAULT_ARP_TTL = 300;

/**
 * ARP packet size (28 bytes)
 */
const ARP_PACKET_SIZE = 28;

/**
 * ARPService - Manages ARP protocol operations
 */
export class ARPService {
  private cache: Map<string, ARPCacheEntry>;
  private statistics: ARPStatistics;

  constructor() {
    this.cache = new Map();
    this.statistics = {
      cacheSize: 0,
      requestsSent: 0,
      repliesSent: 0,
      packetsProcessed: 0
    };
  }

  /**
   * Adds entry to ARP cache
   *
   * @param ip - IP address
   * @param mac - MAC address
   * @param ttl - Time to live in seconds (default: 300)
   */
  public addEntry(ip: IPAddress, mac: MACAddress, ttl: number = DEFAULT_ARP_TTL): void {
    const key = ip.toString();
    const entry: ARPCacheEntry = {
      mac,
      timestamp: Date.now(),
      ttl
    };

    this.cache.set(key, entry);
    this.updateCacheSize();
  }

  /**
   * Removes entry from ARP cache
   *
   * @param ip - IP address
   */
  public removeEntry(ip: IPAddress): void {
    const key = ip.toString();
    this.cache.delete(key);
    this.updateCacheSize();
  }

  /**
   * Checks if entry exists in cache
   *
   * @param ip - IP address
   * @returns True if entry exists and is not expired
   */
  public hasEntry(ip: IPAddress): boolean {
    const key = ip.toString();
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    // Check if expired
    const age = (Date.now() - entry.timestamp) / 1000; // Convert to seconds
    if (age >= entry.ttl) {
      this.cache.delete(key);
      this.updateCacheSize();
      return false;
    }

    return true;
  }

  /**
   * Resolves IP address to MAC address
   *
   * @param ip - IP address to resolve
   * @returns MAC address or undefined if not found
   */
  public resolve(ip: IPAddress): MACAddress | undefined {
    // Clean expired entries
    this.cleanExpired();

    const key = ip.toString();
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    const age = (Date.now() - entry.timestamp) / 1000;
    if (age >= entry.ttl) {
      this.cache.delete(key);
      this.updateCacheSize();
      return undefined;
    }

    return entry.mac;
  }

  /**
   * Gets ARP cache entry (including metadata)
   *
   * @param ip - IP address
   * @returns Cache entry or undefined if not found
   */
  public getEntry(ip: IPAddress): ARPCacheEntry | undefined {
    const key = ip.toString();
    return this.cache.get(key);
  }

  /**
   * Clears all entries from cache
   */
  public clear(): void {
    this.cache.clear();
    this.updateCacheSize();
  }

  /**
   * Removes expired entries from cache
   */
  public cleanExpired(): void {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      const age = (now - entry.timestamp) / 1000;
      if (age >= entry.ttl) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.cache.delete(key);
    }

    this.updateCacheSize();
  }

  /**
   * Creates ARP request packet
   *
   * @param senderIP - Sender IP address
   * @param senderMAC - Sender MAC address
   * @param targetIP - Target IP address to resolve
   * @returns ARP request packet
   */
  public createRequest(senderIP: IPAddress, senderMAC: MACAddress, targetIP: IPAddress): ARPPacket {
    this.statistics.requestsSent++;

    return {
      operation: 'request',
      senderIP,
      senderMAC,
      targetIP,
      targetMAC: MACAddress.ZERO // Unknown in request
    };
  }

  /**
   * Creates ARP reply packet
   *
   * @param senderIP - Sender IP address
   * @param senderMAC - Sender MAC address
   * @param targetIP - Target IP address
   * @param targetMAC - Target MAC address
   * @returns ARP reply packet
   */
  public createReply(
    senderIP: IPAddress,
    senderMAC: MACAddress,
    targetIP: IPAddress,
    targetMAC: MACAddress
  ): ARPPacket {
    this.statistics.repliesSent++;

    return {
      operation: 'reply',
      senderIP,
      senderMAC,
      targetIP,
      targetMAC
    };
  }

  /**
   * Processes ARP packet (request or reply)
   * Automatically updates cache with sender information
   *
   * @param packet - ARP packet to process
   */
  public processPacket(packet: ARPPacket): void {
    this.statistics.packetsProcessed++;

    // Always add sender to cache (from both requests and replies)
    this.addEntry(packet.senderIP, packet.senderMAC);
  }

  /**
   * Creates gratuitous ARP packet
   * Used to announce IP address or detect conflicts
   *
   * @param ip - IP address to announce
   * @param mac - MAC address
   * @returns Gratuitous ARP packet
   */
  public createGratuitousARP(ip: IPAddress, mac: MACAddress): ARPPacket {
    this.statistics.requestsSent++;

    return {
      operation: 'request',
      senderIP: ip,
      senderMAC: mac,
      targetIP: ip, // Same as sender (gratuitous)
      targetMAC: MACAddress.ZERO
    };
  }

  /**
   * Checks if packet is gratuitous ARP
   *
   * @param packet - ARP packet
   * @returns True if gratuitous ARP
   */
  public isGratuitousARP(packet: ARPPacket): boolean {
    return packet.operation === 'request' && packet.senderIP.equals(packet.targetIP);
  }

  /**
   * Serializes ARP packet to bytes (RFC 826 format)
   *
   * ARP packet structure (28 bytes):
   * - Hardware type (2 bytes) - Ethernet = 1
   * - Protocol type (2 bytes) - IPv4 = 0x0800
   * - Hardware address length (1 byte) - 6 for MAC
   * - Protocol address length (1 byte) - 4 for IPv4
   * - Operation (2 bytes) - 1 = request, 2 = reply
   * - Sender hardware address (6 bytes)
   * - Sender protocol address (4 bytes)
   * - Target hardware address (6 bytes)
   * - Target protocol address (4 bytes)
   *
   * @param packet - ARP packet
   * @returns Serialized packet as Buffer
   */
  public serializePacket(packet: ARPPacket): Buffer {
    const buffer = Buffer.alloc(ARP_PACKET_SIZE);

    // Hardware type (Ethernet = 1)
    buffer.writeUInt16BE(1, 0);

    // Protocol type (IPv4 = 0x0800)
    buffer.writeUInt16BE(0x0800, 2);

    // Hardware address length (MAC = 6 bytes)
    buffer.writeUInt8(6, 4);

    // Protocol address length (IPv4 = 4 bytes)
    buffer.writeUInt8(4, 5);

    // Operation (request = 1, reply = 2)
    buffer.writeUInt16BE(packet.operation === 'request' ? 1 : 2, 6);

    // Sender hardware address (MAC)
    const senderMACBytes = packet.senderMAC.toBytes();
    for (let i = 0; i < 6; i++) {
      buffer[8 + i] = senderMACBytes[i];
    }

    // Sender protocol address (IP)
    const senderIPBytes = packet.senderIP.toBytes();
    for (let i = 0; i < 4; i++) {
      buffer[14 + i] = senderIPBytes[i];
    }

    // Target hardware address (MAC)
    const targetMACBytes = packet.targetMAC.toBytes();
    for (let i = 0; i < 6; i++) {
      buffer[18 + i] = targetMACBytes[i];
    }

    // Target protocol address (IP)
    const targetIPBytes = packet.targetIP.toBytes();
    for (let i = 0; i < 4; i++) {
      buffer[24 + i] = targetIPBytes[i];
    }

    return buffer;
  }

  /**
   * Deserializes ARP packet from bytes
   *
   * @param bytes - Serialized ARP packet
   * @returns ARP packet
   * @throws {Error} If packet is invalid
   */
  public deserializePacket(bytes: Buffer): ARPPacket {
    if (bytes.length < ARP_PACKET_SIZE) {
      throw new Error(`Invalid ARP packet size: ${bytes.length} < ${ARP_PACKET_SIZE}`);
    }

    // Validate hardware type (Ethernet = 1)
    const hardwareType = bytes.readUInt16BE(0);
    if (hardwareType !== 1) {
      throw new Error(`Invalid hardware type: ${hardwareType}`);
    }

    // Validate protocol type (IPv4 = 0x0800)
    const protocolType = bytes.readUInt16BE(2);
    if (protocolType !== 0x0800) {
      throw new Error(`Invalid protocol type: 0x${protocolType.toString(16)}`);
    }

    // Parse operation
    const operationCode = bytes.readUInt16BE(6);
    const operation: ARPOperation = operationCode === 1 ? 'request' : 'reply';

    // Parse sender MAC
    const senderMACBytes = Array.from(bytes.slice(8, 14));
    const senderMAC = MACAddress.fromBytes(senderMACBytes);

    // Parse sender IP
    const senderIPBytes = Array.from(bytes.slice(14, 18));
    const senderIP = IPAddress.fromBytes(senderIPBytes);

    // Parse target MAC
    const targetMACBytes = Array.from(bytes.slice(18, 24));
    const targetMAC = MACAddress.fromBytes(targetMACBytes);

    // Parse target IP
    const targetIPBytes = Array.from(bytes.slice(24, 28));
    const targetIP = IPAddress.fromBytes(targetIPBytes);

    return {
      operation,
      senderMAC,
      senderIP,
      targetMAC,
      targetIP
    };
  }

  /**
   * Returns current statistics
   *
   * @returns ARP statistics
   */
  public getStatistics(): Readonly<ARPStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets statistics (but not cache)
   */
  public resetStatistics(): void {
    this.statistics.requestsSent = 0;
    this.statistics.repliesSent = 0;
    this.statistics.packetsProcessed = 0;
    // Keep cacheSize as is
  }

  /**
   * Updates cache size in statistics
   */
  private updateCacheSize(): void {
    this.statistics.cacheSize = this.cache.size;
  }
}
