/**
 * IPAddress Value Object
 *
 * Represents a 32-bit IPv4 address.
 * Immutable value object following Domain-Driven Design principles.
 *
 * @example
 * ```typescript
 * const ip = new IPAddress('192.168.1.1');
 * console.log(ip.toString()); // '192.168.1.1'
 * console.log(ip.isPrivate()); // true
 * ```
 */
export class IPAddress {
  private readonly value: string;
  private readonly bytes: number[];
  private readonly numeric: number;

  /**
   * Creates a new IPv4 address
   *
   * @param address - IPv4 address in dotted decimal format (e.g., '192.168.1.1')
   * @throws {Error} If address format is invalid
   */
  constructor(address: string) {
    if (!address) {
      throw new Error('Invalid IPv4 address format: address cannot be empty');
    }

    const parts = address.split('.');

    // Validate format: must be 4 octets
    if (parts.length !== 4) {
      throw new Error('Invalid IPv4 address format: must have 4 octets');
    }

    // Validate and convert octets
    const bytes: number[] = [];
    for (const part of parts) {
      const num = parseInt(part, 10);

      // Check if valid number
      if (isNaN(num) || num.toString() !== part) {
        throw new Error('Invalid IPv4 address format: octets must be valid numbers');
      }

      // Check range [0, 255]
      if (num < 0 || num > 255) {
        throw new Error('Invalid IPv4 address format: octets must be between 0 and 255');
      }

      bytes.push(num);
    }

    this.bytes = bytes;
    this.value = bytes.join('.');

    // Calculate numeric representation
    this.numeric = bytes.reduce((acc, byte, i) => acc + byte * Math.pow(256, 3 - i), 0);
  }

  /**
   * Creates an IP address from byte array
   *
   * @param bytes - Array of 4 bytes
   * @returns IPAddress instance
   * @throws {Error} If byte array is invalid
   */
  public static fromBytes(bytes: number[]): IPAddress {
    if (bytes.length !== 4) {
      throw new Error('IPv4 address must be 4 bytes');
    }

    for (const byte of bytes) {
      if (byte < 0 || byte > 255 || !Number.isInteger(byte)) {
        throw new Error('Invalid byte value: must be integer between 0 and 255');
      }
    }

    return new IPAddress(bytes.join('.'));
  }

  /**
   * Creates an IP address from a 32-bit number
   *
   * @param num - 32-bit unsigned integer
   * @returns IPAddress instance
   * @throws {Error} If number is invalid
   */
  public static fromNumber(num: number): IPAddress {
    if (!Number.isInteger(num) || num < 0 || num > 4294967295) {
      throw new Error('Invalid number: must be integer between 0 and 4294967295');
    }

    const bytes = [
      (num >>> 24) & 0xff,
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff
    ];

    return IPAddress.fromBytes(bytes);
  }

  /**
   * Static helper to convert IPAddress to 32-bit number
   *
   * @param ip - IPAddress instance
   * @returns 32-bit numeric representation
   */
  public static toNumber(ip: IPAddress): number {
    return ip.toNumber();
  }

  /**
   * Returns string representation in dotted decimal format
   */
  public toString(): string {
    return this.value;
  }

  /**
   * Returns byte array representation
   */
  public toBytes(): number[] {
    return [...this.bytes];
  }

  /**
   * Returns 32-bit numeric representation
   */
  public toNumber(): number {
    return this.numeric;
  }

  /**
   * Checks if this is a private IP address (RFC 1918)
   * - 10.0.0.0/8
   * - 172.16.0.0/12
   * - 192.168.0.0/16
   */
  public isPrivate(): boolean {
    const [first, second] = this.bytes;

    // 10.0.0.0/8
    if (first === 10) {
      return true;
    }

    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }

    // 192.168.0.0/16
    if (first === 192 && second === 168) {
      return true;
    }

    return false;
  }

  /**
   * Checks if this is a loopback address (127.0.0.0/8)
   */
  public isLoopback(): boolean {
    return this.bytes[0] === 127;
  }

  /**
   * Checks if this is the broadcast address (255.255.255.255)
   */
  public isBroadcast(): boolean {
    return this.bytes.every(byte => byte === 255);
  }

  /**
   * Checks if this is a multicast address (224.0.0.0/4)
   */
  public isMulticast(): boolean {
    const first = this.bytes[0];
    return first >= 224 && first <= 239;
  }

  /**
   * Checks equality with another IP address
   *
   * @param other - Another IPAddress to compare
   * @returns true if IP addresses are equal
   */
  public equals(other: IPAddress): boolean {
    return this.value === other.value;
  }

  /**
   * Checks if this IP address is in the specified subnet
   *
   * @param network - Network address (e.g., '192.168.1.0')
   * @param mask - Subnet mask (e.g., '255.255.255.0')
   * @returns true if IP is in the subnet
   */
  public isInSubnet(network: string | IPAddress, mask: string | IPAddress): boolean {
    const networkIP = typeof network === 'string' ? new IPAddress(network) : network;
    const maskIP = typeof mask === 'string' ? new IPAddress(mask) : mask;

    const ipNum = this.toNumber();
    const networkNum = networkIP.toNumber();
    const maskNum = maskIP.toNumber();

    return (ipNum & maskNum) === (networkNum & maskNum);
  }

  /**
   * Returns the network address for this IP with the given mask
   *
   * @param mask - Subnet mask
   * @returns Network address
   */
  public getNetworkAddress(mask: string | IPAddress): IPAddress {
    const maskIP = typeof mask === 'string' ? new IPAddress(mask) : mask;
    const networkNum = this.toNumber() & maskIP.toNumber();
    return IPAddress.fromNumber(networkNum);
  }

  /**
   * Returns the broadcast address for this IP with the given mask
   *
   * @param mask - Subnet mask
   * @returns Broadcast address
   */
  public getBroadcastAddress(mask: string | IPAddress): IPAddress {
    const maskIP = typeof mask === 'string' ? new IPAddress(mask) : mask;
    const networkNum = this.toNumber() & maskIP.toNumber();
    const broadcastNum = networkNum | (~maskIP.toNumber() & 0xffffffff);
    return IPAddress.fromNumber(broadcastNum);
  }
}
