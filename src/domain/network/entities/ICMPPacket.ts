/**
 * ICMPPacket - Internet Control Message Protocol (RFC 792)
 *
 * ICMP is used for diagnostic and control purposes in IP networks.
 * Primary uses:
 * - Echo Request/Reply (ping)
 * - Time Exceeded (traceroute)
 * - Destination Unreachable
 *
 * ICMP Header Format (8 bytes minimum):
 * ┌─────────────────────────────────────────────────────────┐
 * │ Type (1) │ Code (1) │ Checksum (2)                      │
 * ├─────────────────────────────────────────────────────────┤
 * │ Rest of Header (4 bytes - varies by type)               │
 * ├─────────────────────────────────────────────────────────┤
 * │ Data (variable length)                                  │
 * └─────────────────────────────────────────────────────────┘
 *
 * Design Pattern: Value Object (immutable)
 *
 * @example
 * ```typescript
 * // Create Echo Request (ping)
 * const request = new ICMPPacket({
 *   type: ICMPType.ECHO_REQUEST,
 *   code: 0,
 *   identifier: 1234,
 *   sequenceNumber: 1,
 *   data: Buffer.from('ping data')
 * });
 *
 * // Serialize to bytes
 * const bytes = request.toBytes();
 *
 * // Deserialize from bytes
 * const restored = ICMPPacket.fromBytes(bytes);
 * ```
 */

/**
 * ICMP Message Types (RFC 792)
 */
export enum ICMPType {
  ECHO_REPLY = 0,
  DEST_UNREACHABLE = 3,
  SOURCE_QUENCH = 4,
  REDIRECT = 5,
  ECHO_REQUEST = 8,
  ROUTER_ADVERTISEMENT = 9,
  ROUTER_SOLICITATION = 10,
  TIME_EXCEEDED = 11,
  PARAMETER_PROBLEM = 12,
  TIMESTAMP_REQUEST = 13,
  TIMESTAMP_REPLY = 14,
  INFO_REQUEST = 15,
  INFO_REPLY = 16
}

/**
 * ICMP Code values for specific message types
 */
export enum ICMPCode {
  // Destination Unreachable codes
  NET_UNREACHABLE = 0,
  HOST_UNREACHABLE = 1,
  PROTOCOL_UNREACHABLE = 2,
  PORT_UNREACHABLE = 3,
  FRAGMENTATION_NEEDED = 4,
  SOURCE_ROUTE_FAILED = 5,

  // Time Exceeded codes
  TTL_EXCEEDED = 0,
  FRAGMENT_REASSEMBLY_TIME_EXCEEDED = 1,

  // Redirect codes
  REDIRECT_NET = 0,
  REDIRECT_HOST = 1,
  REDIRECT_TOS_NET = 2,
  REDIRECT_TOS_HOST = 3
}

/**
 * ICMP Packet configuration
 */
export interface ICMPPacketConfig {
  type: ICMPType;
  code: number;
  identifier?: number;      // For Echo Request/Reply
  sequenceNumber?: number;  // For Echo Request/Reply
  data: Buffer;            // Payload data
}

/**
 * ICMPPacket - ICMP message implementation
 */
export class ICMPPacket {
  private readonly type: ICMPType;
  private readonly code: number;
  private readonly identifier: number;
  private readonly sequenceNumber: number;
  private readonly data: Buffer;

  constructor(config: ICMPPacketConfig) {
    this.type = config.type;
    this.code = config.code;
    this.identifier = config.identifier ?? 0;
    this.sequenceNumber = config.sequenceNumber ?? 0;
    this.data = config.data;
  }

  /**
   * Returns ICMP type
   */
  public getType(): ICMPType {
    return this.type;
  }

  /**
   * Returns ICMP code
   */
  public getCode(): number {
    return this.code;
  }

  /**
   * Returns identifier (for Echo Request/Reply)
   */
  public getIdentifier(): number {
    return this.identifier;
  }

  /**
   * Returns sequence number (for Echo Request/Reply)
   */
  public getSequenceNumber(): number {
    return this.sequenceNumber;
  }

  /**
   * Returns packet data
   */
  public getData(): Buffer {
    return this.data;
  }

  /**
   * Checks if this is an Echo Request
   */
  public isEchoRequest(): boolean {
    return this.type === ICMPType.ECHO_REQUEST;
  }

  /**
   * Checks if this is an Echo Reply
   */
  public isEchoReply(): boolean {
    return this.type === ICMPType.ECHO_REPLY;
  }

  /**
   * Checks if this is a Time Exceeded message
   */
  public isTimeExceeded(): boolean {
    return this.type === ICMPType.TIME_EXCEEDED;
  }

  /**
   * Checks if this is a Destination Unreachable message
   */
  public isDestUnreachable(): boolean {
    return this.type === ICMPType.DEST_UNREACHABLE;
  }

  /**
   * Returns human-readable type name
   */
  public getTypeName(): string {
    switch (this.type) {
      case ICMPType.ECHO_REPLY:
        return 'Echo Reply';
      case ICMPType.DEST_UNREACHABLE:
        return 'Destination Unreachable';
      case ICMPType.SOURCE_QUENCH:
        return 'Source Quench';
      case ICMPType.REDIRECT:
        return 'Redirect';
      case ICMPType.ECHO_REQUEST:
        return 'Echo Request';
      case ICMPType.TIME_EXCEEDED:
        return 'Time Exceeded';
      case ICMPType.PARAMETER_PROBLEM:
        return 'Parameter Problem';
      case ICMPType.TIMESTAMP_REQUEST:
        return 'Timestamp Request';
      case ICMPType.TIMESTAMP_REPLY:
        return 'Timestamp Reply';
      default:
        return `Unknown (${this.type})`;
    }
  }

  /**
   * Serializes ICMP packet to bytes
   *
   * @returns Buffer containing ICMP packet
   */
  public toBytes(): Buffer {
    // ICMP header: 8 bytes + data
    const totalLength = 8 + this.data.length;
    const buffer = Buffer.alloc(totalLength);

    // Type (1 byte)
    buffer.writeUInt8(this.type, 0);

    // Code (1 byte)
    buffer.writeUInt8(this.code, 1);

    // Checksum (2 bytes) - set to 0 initially
    buffer.writeUInt16BE(0, 2);

    // Rest of header (4 bytes) - depends on type
    // For Echo Request/Reply: identifier + sequence number
    // For others: typically unused (0) or specific data
    if (this.type === ICMPType.ECHO_REQUEST || this.type === ICMPType.ECHO_REPLY) {
      buffer.writeUInt16BE(this.identifier, 4);
      buffer.writeUInt16BE(this.sequenceNumber, 6);
    } else {
      // For error messages, rest of header is typically 0
      buffer.writeUInt32BE(0, 4);
    }

    // Data
    this.data.copy(buffer, 8);

    // Calculate and set checksum
    const checksum = this.calculateChecksum(buffer);
    buffer.writeUInt16BE(checksum, 2);

    return buffer;
  }

  /**
   * Deserializes ICMP packet from bytes
   *
   * @param bytes - Buffer containing ICMP packet
   * @returns ICMPPacket instance
   */
  public static fromBytes(bytes: Buffer): ICMPPacket {
    // Validate minimum size
    if (bytes.length < 8) {
      throw new Error(`ICMP packet too small: ${bytes.length} bytes (minimum 8)`);
    }

    // Parse header
    const type = bytes.readUInt8(0) as ICMPType;
    const code = bytes.readUInt8(1);
    const checksum = bytes.readUInt16BE(2);

    // Verify checksum
    const calculatedChecksum = ICMPPacket.calculateChecksum(bytes);
    if (checksum !== calculatedChecksum) {
      throw new Error(`Invalid ICMP checksum: expected ${calculatedChecksum}, got ${checksum}`);
    }

    // Parse rest of header
    let identifier = 0;
    let sequenceNumber = 0;

    if (type === ICMPType.ECHO_REQUEST || type === ICMPType.ECHO_REPLY) {
      identifier = bytes.readUInt16BE(4);
      sequenceNumber = bytes.readUInt16BE(6);
    }

    // Extract data
    const data = bytes.subarray(8);

    return new ICMPPacket({
      type,
      code,
      identifier,
      sequenceNumber,
      data
    });
  }

  /**
   * Calculates ICMP checksum (RFC 792)
   *
   * The checksum is the 16-bit one's complement of the one's complement sum
   * of the ICMP message starting with the ICMP Type.
   *
   * @param buffer - Buffer to calculate checksum for (checksum field must be 0)
   * @returns Calculated checksum
   */
  private static calculateChecksum(buffer: Buffer): number {
    let sum = 0;

    // Sum all 16-bit words
    for (let i = 0; i < buffer.length; i += 2) {
      if (i === 2) {
        // Skip checksum field
        continue;
      }

      if (i + 1 < buffer.length) {
        // Read 16-bit word
        sum += buffer.readUInt16BE(i);
      } else {
        // Odd byte at end - pad with 0
        sum += buffer[i] << 8;
      }
    }

    // Fold 32-bit sum to 16 bits
    while (sum >> 16) {
      sum = (sum & 0xFFFF) + (sum >> 16);
    }

    // One's complement
    return ~sum & 0xFFFF;
  }

  /**
   * Calculates checksum for this packet
   */
  private calculateChecksum(buffer: Buffer): number {
    return ICMPPacket.calculateChecksum(buffer);
  }

  /**
   * Creates an Echo Reply from an Echo Request
   *
   * @param request - Original Echo Request
   * @returns Echo Reply packet
   */
  public static createEchoReply(request: ICMPPacket): ICMPPacket {
    if (!request.isEchoRequest()) {
      throw new Error('Can only create Echo Reply from Echo Request');
    }

    return new ICMPPacket({
      type: ICMPType.ECHO_REPLY,
      code: 0,
      identifier: request.getIdentifier(),
      sequenceNumber: request.getSequenceNumber(),
      data: request.getData()
    });
  }

  /**
   * Creates a Time Exceeded message
   *
   * @param originalPacketHeader - First 8 bytes of original IP header + 8 bytes of data
   * @param code - Time exceeded code (default: TTL_EXCEEDED)
   * @returns Time Exceeded packet
   */
  public static createTimeExceeded(
    originalPacketHeader: Buffer,
    code: number = ICMPCode.TTL_EXCEEDED
  ): ICMPPacket {
    return new ICMPPacket({
      type: ICMPType.TIME_EXCEEDED,
      code,
      data: originalPacketHeader
    });
  }

  /**
   * Creates a Destination Unreachable message
   *
   * @param originalPacketHeader - First 8 bytes of original IP header + 8 bytes of data
   * @param code - Unreachable code
   * @returns Destination Unreachable packet
   */
  public static createDestUnreachable(
    originalPacketHeader: Buffer,
    code: number
  ): ICMPPacket {
    return new ICMPPacket({
      type: ICMPType.DEST_UNREACHABLE,
      code,
      data: originalPacketHeader
    });
  }
}
