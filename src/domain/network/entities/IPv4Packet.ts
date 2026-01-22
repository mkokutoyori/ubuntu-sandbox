/**
 * IPv4Packet Entity
 *
 * Represents an IPv4 packet following RFC 791.
 * Used for Layer 3 communication in the network simulator.
 *
 * Packet structure:
 * - Version: 4 bits (always 4)
 * - IHL (Internet Header Length): 4 bits (minimum 5, meaning 20 bytes)
 * - DSCP + ECN: 8 bits
 * - Total Length: 16 bits
 * - Identification: 16 bits
 * - Flags + Fragment Offset: 16 bits
 * - TTL: 8 bits
 * - Protocol: 8 bits
 * - Header Checksum: 16 bits
 * - Source IP: 32 bits
 * - Destination IP: 32 bits
 * - Options: variable (not implemented in this simulation)
 * - Payload: variable
 *
 * @example
 * ```typescript
 * const packet = new IPv4Packet({
 *   sourceIP: new IPAddress('192.168.1.1'),
 *   destinationIP: new IPAddress('192.168.1.2'),
 *   protocol: IPProtocol.TCP,
 *   ttl: 64,
 *   payload: Buffer.from([...])
 * });
 * ```
 */

import { IPAddress } from '../value-objects/IPAddress';

/**
 * IP Protocol constants (RFC 790)
 */
export const IPProtocol = {
  ICMP: 1,
  TCP: 6,
  UDP: 17
} as const;

export type IPProtocolValue = typeof IPProtocol[keyof typeof IPProtocol];

/**
 * Configuration for creating an IPv4 packet
 */
export interface IPv4PacketConfig {
  sourceIP: IPAddress;
  destinationIP: IPAddress;
  protocol: IPProtocolValue;
  ttl?: number;
  payload: Buffer;
  identification?: number;
  flags?: number;
  fragmentOffset?: number;
  dscp?: number;
}

/**
 * IPv4 packet constants
 */
const VERSION = 4;
const MIN_HEADER_LENGTH = 20; // bytes (IHL = 5)
const MAX_PACKET_SIZE = 65535; // Maximum total length
const DEFAULT_TTL = 64;

export class IPv4Packet {
  private readonly version: number = VERSION;
  private readonly headerLength: number = MIN_HEADER_LENGTH;
  private readonly sourceIP: IPAddress;
  private readonly destinationIP: IPAddress;
  private readonly protocol: IPProtocolValue;
  private readonly ttl: number;
  private readonly payload: Buffer;
  private readonly identification: number;
  private readonly flags: number;
  private readonly fragmentOffset: number;
  private readonly dscp: number;
  private readonly timestamp: number;

  constructor(config: IPv4PacketConfig) {
    // Validate TTL
    const ttl = config.ttl ?? DEFAULT_TTL;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 255) {
      throw new Error('Invalid TTL: must be between 0 and 255');
    }

    // Validate payload size
    const totalLength = MIN_HEADER_LENGTH + config.payload.length;
    if (totalLength > MAX_PACKET_SIZE) {
      throw new Error(
        `Payload too large: total packet size ${totalLength} exceeds maximum ${MAX_PACKET_SIZE}`
      );
    }

    this.sourceIP = config.sourceIP;
    this.destinationIP = config.destinationIP;
    this.protocol = config.protocol;
    this.ttl = ttl;
    this.payload = Buffer.from(config.payload); // Create copy
    this.identification = config.identification ?? Math.floor(Math.random() * 65536);
    this.flags = config.flags ?? 0;
    this.fragmentOffset = config.fragmentOffset ?? 0;
    this.dscp = config.dscp ?? 0;
    this.timestamp = Date.now();
  }

  /**
   * Creates an IPv4 packet from byte buffer
   *
   * @param bytes - Raw packet bytes
   * @returns IPv4Packet instance
   * @throws {Error} If packet is invalid
   */
  public static fromBytes(bytes: Buffer): IPv4Packet {
    if (bytes.length < MIN_HEADER_LENGTH) {
      throw new Error(`Packet too small: ${bytes.length} < ${MIN_HEADER_LENGTH}`);
    }

    // Parse version and IHL
    const versionIHL = bytes[0];
    const version = (versionIHL >> 4) & 0x0F;
    const ihl = versionIHL & 0x0F;

    if (version !== VERSION) {
      throw new Error(`Invalid IP version: ${version} (expected ${VERSION})`);
    }

    const headerLength = ihl * 4;
    if (headerLength < MIN_HEADER_LENGTH) {
      throw new Error(`Invalid header length: ${headerLength} < ${MIN_HEADER_LENGTH}`);
    }

    // Parse DSCP and ECN
    const dscpECN = bytes[1];
    const dscp = (dscpECN >> 2) & 0x3F;

    // Parse total length
    const totalLength = bytes.readUInt16BE(2);

    // Parse identification
    const identification = bytes.readUInt16BE(4);

    // Parse flags and fragment offset
    const flagsFragmentOffset = bytes.readUInt16BE(6);
    const flags = (flagsFragmentOffset >> 13) & 0x07;
    const fragmentOffset = flagsFragmentOffset & 0x1FFF;

    // Parse TTL
    const ttl = bytes[8];

    // Parse protocol
    const protocol = bytes[9] as IPProtocolValue;

    // Parse source IP
    const sourceIP = IPAddress.fromBytes(Array.from(bytes.slice(12, 16)));

    // Parse destination IP
    const destinationIP = IPAddress.fromBytes(Array.from(bytes.slice(16, 20)));

    // Extract payload
    const payload = bytes.slice(headerLength, totalLength);

    return new IPv4Packet({
      sourceIP,
      destinationIP,
      protocol,
      ttl,
      payload,
      identification,
      flags,
      fragmentOffset,
      dscp
    });
  }

  /**
   * Serializes packet to byte buffer
   *
   * @returns Packet as Buffer
   */
  public toBytes(): Buffer {
    const totalLength = this.headerLength + this.payload.length;
    const buffer = Buffer.alloc(totalLength);

    // Version (4 bits) + IHL (4 bits)
    const ihl = this.headerLength / 4;
    buffer[0] = (this.version << 4) | (ihl & 0x0F);

    // DSCP (6 bits) + ECN (2 bits)
    buffer[1] = (this.dscp << 2) & 0xFC;

    // Total length
    buffer.writeUInt16BE(totalLength, 2);

    // Identification
    buffer.writeUInt16BE(this.identification, 4);

    // Flags (3 bits) + Fragment offset (13 bits)
    const flagsFragmentOffset = ((this.flags & 0x07) << 13) | (this.fragmentOffset & 0x1FFF);
    buffer.writeUInt16BE(flagsFragmentOffset, 6);

    // TTL
    buffer[8] = this.ttl;

    // Protocol
    buffer[9] = this.protocol;

    // Header checksum (calculate after filling other fields)
    buffer.writeUInt16BE(0, 10); // Initialize to 0
    const checksum = this.calculateChecksum(buffer.slice(0, this.headerLength));
    buffer.writeUInt16BE(checksum, 10);

    // Source IP
    const srcBytes = this.sourceIP.toBytes();
    for (let i = 0; i < 4; i++) {
      buffer[12 + i] = srcBytes[i];
    }

    // Destination IP
    const dstBytes = this.destinationIP.toBytes();
    for (let i = 0; i < 4; i++) {
      buffer[16 + i] = dstBytes[i];
    }

    // Copy payload
    this.payload.copy(buffer, this.headerLength);

    return buffer;
  }

  /**
   * Returns IP version (always 4)
   */
  public getVersion(): number {
    return this.version;
  }

  /**
   * Returns header length in bytes
   */
  public getHeaderLength(): number {
    return this.headerLength;
  }

  /**
   * Returns total packet length (header + payload) in bytes
   */
  public getTotalLength(): number {
    return this.headerLength + this.payload.length;
  }

  /**
   * Returns source IP address
   */
  public getSourceIP(): IPAddress {
    return this.sourceIP;
  }

  /**
   * Returns destination IP address
   */
  public getDestinationIP(): IPAddress {
    return this.destinationIP;
  }

  /**
   * Returns protocol
   */
  public getProtocol(): IPProtocolValue {
    return this.protocol;
  }

  /**
   * Returns TTL (Time To Live)
   */
  public getTTL(): number {
    return this.ttl;
  }

  /**
   * Returns payload
   */
  public getPayload(): Buffer {
    return Buffer.from(this.payload); // Return copy
  }

  /**
   * Returns packet timestamp
   */
  public getTimestamp(): number {
    return this.timestamp;
  }

  /**
   * Decrements TTL by 1 and returns a new packet
   * (Immutable operation - original packet unchanged)
   *
   * @returns New IPv4Packet with decremented TTL
   * @throws {Error} If TTL would become 0
   */
  public decrementTTL(): IPv4Packet {
    if (this.ttl <= 1) {
      throw new Error('TTL expired: packet would be dropped');
    }

    return new IPv4Packet({
      sourceIP: this.sourceIP,
      destinationIP: this.destinationIP,
      protocol: this.protocol,
      ttl: this.ttl - 1,
      payload: this.payload,
      identification: this.identification,
      flags: this.flags,
      fragmentOffset: this.fragmentOffset,
      dscp: this.dscp
    });
  }

  /**
   * Calculates IPv4 header checksum
   *
   * @param header - Header bytes (checksum field must be 0)
   * @returns Checksum value
   */
  private calculateChecksum(header: Buffer): number {
    let sum = 0;

    // Sum all 16-bit words
    for (let i = 0; i < header.length; i += 2) {
      const word = (header[i] << 8) | (header[i + 1] || 0);
      sum += word;
    }

    // Add carry bits
    while (sum > 0xFFFF) {
      sum = (sum & 0xFFFF) + (sum >> 16);
    }

    // One's complement
    return ~sum & 0xFFFF;
  }

  /**
   * Returns string representation for debugging
   */
  public toString(): string {
    return `IPv4Packet { src: ${this.sourceIP.toString()}, dst: ${this.destinationIP.toString()}, protocol: ${this.protocol}, ttl: ${this.ttl}, size: ${this.getTotalLength()} }`;
  }
}
