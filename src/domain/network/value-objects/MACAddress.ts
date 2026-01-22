/**
 * MACAddress Value Object
 *
 * Represents a 48-bit MAC (Media Access Control) address.
 * Immutable value object following Domain-Driven Design principles.
 *
 * @example
 * ```typescript
 * const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
 * console.log(mac.toString()); // 'AA:BB:CC:DD:EE:FF'
 * console.log(mac.isBroadcast()); // false
 * ```
 */
export class MACAddress {
  private readonly value: string;
  private readonly bytes: number[];

  // Constants
  public static readonly BROADCAST = new MACAddress('FF:FF:FF:FF:FF:FF');
  public static readonly ZERO = new MACAddress('00:00:00:00:00:00');

  /**
   * Creates a new MAC address
   *
   * @param address - MAC address in format 'AA:BB:CC:DD:EE:FF', 'AA-BB-CC-DD-EE-FF', or 'aabbccddeeff'
   * @throws {Error} If address format is invalid
   */
  constructor(address: string) {
    if (!address) {
      throw new Error('Invalid MAC address format: address cannot be empty');
    }

    // Normalize address: remove separators and convert to uppercase
    const normalized = address.replace(/[:-]/g, '').toUpperCase();

    // Validate format: must be 12 hex characters
    if (!/^[0-9A-F]{12}$/.test(normalized)) {
      throw new Error('Invalid MAC address format: must be 12 hexadecimal characters');
    }

    // Convert to standard colon-separated format
    const parts: string[] = [];
    for (let i = 0; i < 12; i += 2) {
      parts.push(normalized.slice(i, i + 2));
    }
    this.value = parts.join(':');

    // Store byte representation
    this.bytes = parts.map(part => parseInt(part, 16));
  }

  /**
   * Creates a MAC address from byte array
   *
   * @param bytes - Array of 6 bytes
   * @returns MACAddress instance
   * @throws {Error} If byte array is invalid
   */
  public static fromBytes(bytes: number[]): MACAddress {
    if (bytes.length !== 6) {
      throw new Error('MAC address must be 6 bytes');
    }

    for (const byte of bytes) {
      if (byte < 0 || byte > 255 || !Number.isInteger(byte)) {
        throw new Error('Invalid byte value: must be integer between 0 and 255');
      }
    }

    const address = bytes
      .map(byte => byte.toString(16).toUpperCase().padStart(2, '0'))
      .join(':');

    return new MACAddress(address);
  }

  /**
   * Returns string representation in format AA:BB:CC:DD:EE:FF
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
   * Checks if this is a broadcast MAC address (FF:FF:FF:FF:FF:FF)
   */
  public isBroadcast(): boolean {
    return this.bytes.every(byte => byte === 0xFF);
  }

  /**
   * Checks if this is a multicast MAC address
   * A multicast address has the LSB of the first octet set to 1
   */
  public isMulticast(): boolean {
    return (this.bytes[0] & 0x01) === 0x01;
  }

  /**
   * Checks if this is a unicast MAC address
   */
  public isUnicast(): boolean {
    return !this.isMulticast();
  }

  /**
   * Checks equality with another MAC address
   *
   * @param other - Another MACAddress to compare
   * @returns true if MAC addresses are equal
   */
  public equals(other: MACAddress): boolean {
    return this.value === other.value;
  }

  /**
   * Returns vendor/OUI part (first 3 bytes)
   */
  public getOUI(): string {
    return this.value.slice(0, 8); // AA:BB:CC
  }

  /**
   * Returns device/NIC part (last 3 bytes)
   */
  public getNIC(): string {
    return this.value.slice(9); // DD:EE:FF
  }
}
