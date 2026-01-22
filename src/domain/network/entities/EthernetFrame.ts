/**
 * EthernetFrame Entity
 *
 * Represents an Ethernet II frame (IEEE 802.3).
 * Used for Layer 2 communication in the network simulator.
 *
 * Frame structure:
 * - Destination MAC: 6 bytes
 * - Source MAC: 6 bytes
 * - EtherType: 2 bytes
 * - Payload: 46-1500 bytes
 * - FCS (Frame Check Sequence): 4 bytes (optional in simulation)
 *
 * @example
 * ```typescript
 * const frame = new EthernetFrame({
 *   sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
 *   destinationMAC: new MACAddress('11:22:33:44:55:66'),
 *   etherType: EtherType.IPv4,
 *   payload: Buffer.from([...])
 * });
 * ```
 */

import { MACAddress } from '../value-objects/MACAddress';

/**
 * EtherType constants (IEEE 802.3)
 */
export const EtherType = {
  IPv4: 0x0800,
  ARP: 0x0806,
  IPv6: 0x86DD,
  VLAN: 0x8100
} as const;

export type EtherTypeValue = typeof EtherType[keyof typeof EtherType];

/**
 * Configuration for creating an Ethernet frame
 */
export interface EthernetFrameConfig {
  sourceMAC: MACAddress;
  destinationMAC: MACAddress;
  etherType: EtherTypeValue;
  payload: Buffer;
  vlanTag?: number;
}

/**
 * Ethernet frame constants
 */
const MIN_PAYLOAD_SIZE = 46; // Minimum payload size (before padding)
const MAX_PAYLOAD_SIZE = 1500; // Maximum payload size (MTU)
const HEADER_SIZE = 14; // Dest MAC (6) + Source MAC (6) + EtherType (2)
const MIN_FRAME_SIZE = 64; // Minimum frame size (including FCS)

export class EthernetFrame {
  private readonly sourceMAC: MACAddress;
  private readonly destinationMAC: MACAddress;
  private readonly etherType: EtherTypeValue;
  private readonly payload: Buffer;
  private readonly vlanTag?: number;
  private readonly timestamp: number;

  constructor(config: EthernetFrameConfig) {
    // Validate payload size
    if (config.payload.length > MAX_PAYLOAD_SIZE) {
      throw new Error(
        `Payload size exceeds maximum: ${config.payload.length} > ${MAX_PAYLOAD_SIZE}`
      );
    }

    if (config.payload.length < MIN_PAYLOAD_SIZE) {
      throw new Error(
        `Payload size below minimum: ${config.payload.length} < ${MIN_PAYLOAD_SIZE}`
      );
    }

    this.sourceMAC = config.sourceMAC;
    this.destinationMAC = config.destinationMAC;
    this.etherType = config.etherType;
    this.payload = Buffer.from(config.payload); // Create copy
    this.vlanTag = config.vlanTag;
    this.timestamp = Date.now();
  }

  /**
   * Creates an Ethernet frame from byte buffer
   *
   * @param bytes - Raw frame bytes
   * @returns EthernetFrame instance
   * @throws {Error} If frame is invalid
   */
  public static fromBytes(bytes: Buffer): EthernetFrame {
    if (bytes.length < MIN_FRAME_SIZE) {
      throw new Error(`Invalid frame size: ${bytes.length} < ${MIN_FRAME_SIZE}`);
    }

    // Parse header
    const destinationMAC = MACAddress.fromBytes(Array.from(bytes.slice(0, 6)));
    const sourceMAC = MACAddress.fromBytes(Array.from(bytes.slice(6, 12)));
    const etherType = bytes.readUInt16BE(12);

    // Extract payload (skip header)
    const payload = bytes.slice(14);

    return new EthernetFrame({
      sourceMAC,
      destinationMAC,
      etherType,
      payload
    });
  }

  /**
   * Serializes frame to byte buffer
   *
   * @returns Frame as Buffer
   */
  public toBytes(): Buffer {
    const headerSize = HEADER_SIZE;
    const totalSize = headerSize + this.payload.length;

    // Ensure minimum frame size (pad if necessary)
    const frameSize = Math.max(totalSize, MIN_FRAME_SIZE);
    const buffer = Buffer.alloc(frameSize);

    // Write destination MAC
    const destBytes = this.destinationMAC.toBytes();
    for (let i = 0; i < 6; i++) {
      buffer[i] = destBytes[i];
    }

    // Write source MAC
    const srcBytes = this.sourceMAC.toBytes();
    for (let i = 0; i < 6; i++) {
      buffer[6 + i] = srcBytes[i];
    }

    // Write EtherType
    buffer.writeUInt16BE(this.etherType, 12);

    // Write payload
    this.payload.copy(buffer, 14);

    // Padding is automatically zeros from Buffer.alloc

    return buffer;
  }

  /**
   * Returns source MAC address
   */
  public getSourceMAC(): MACAddress {
    return this.sourceMAC;
  }

  /**
   * Returns destination MAC address
   */
  public getDestinationMAC(): MACAddress {
    return this.destinationMAC;
  }

  /**
   * Returns EtherType
   */
  public getEtherType(): EtherTypeValue {
    return this.etherType;
  }

  /**
   * Returns payload
   */
  public getPayload(): Buffer {
    return Buffer.from(this.payload); // Return copy
  }

  /**
   * Returns VLAN tag if present
   */
  public getVLANTag(): number | undefined {
    return this.vlanTag;
  }

  /**
   * Returns frame timestamp
   */
  public getTimestamp(): number {
    return this.timestamp;
  }

  /**
   * Returns total frame size in bytes (header + payload)
   */
  public getSize(): number {
    return HEADER_SIZE + this.payload.length;
  }

  /**
   * Checks if this is a broadcast frame
   */
  public isBroadcast(): boolean {
    return this.destinationMAC.isBroadcast();
  }

  /**
   * Checks if this is a multicast frame
   */
  public isMulticast(): boolean {
    return this.destinationMAC.isMulticast();
  }

  /**
   * Checks if this is a unicast frame
   */
  public isUnicast(): boolean {
    return this.destinationMAC.isUnicast();
  }

  /**
   * Returns string representation for debugging
   */
  public toString(): string {
    return `EthernetFrame { src: ${this.sourceMAC.toString()}, dst: ${this.destinationMAC.toString()}, type: 0x${this.etherType.toString(16)}, size: ${this.getSize()} }`;
  }
}
