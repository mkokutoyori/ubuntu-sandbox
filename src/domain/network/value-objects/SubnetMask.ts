/**
 * SubnetMask Value Object
 *
 * Represents an IPv4 subnet mask.
 * Immutable value object following Domain-Driven Design principles.
 *
 * @example
 * ```typescript
 * const mask = new SubnetMask('255.255.255.0');
 * const mask2 = new SubnetMask('/24');
 * const mask3 = SubnetMask.fromCIDR(24);
 * console.log(mask.getCIDR()); // 24
 * console.log(mask.getHostCount()); // 254
 * ```
 */
export class SubnetMask {
  private readonly value: string;
  private readonly cidr: number;
  private readonly numeric: number;

  /**
   * Creates a new subnet mask
   *
   * @param mask - Subnet mask in dotted decimal format ('255.255.255.0') or CIDR notation ('/24')
   * @throws {Error} If mask format is invalid
   */
  constructor(mask: string) {
    if (mask.startsWith('/')) {
      // CIDR notation
      const cidr = parseInt(mask.slice(1), 10);
      if (isNaN(cidr) || cidr < 0 || cidr > 32) {
        throw new Error('Invalid CIDR notation: must be between /0 and /32');
      }
      this.cidr = cidr;
      this.numeric = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
      this.value = this.numberToIPString(this.numeric);
    } else {
      // Dotted decimal notation
      const parts = mask.split('.');

      if (parts.length !== 4) {
        throw new Error('Invalid subnet mask: must have 4 octets');
      }

      const bytes: number[] = [];
      for (const part of parts) {
        const num = parseInt(part, 10);
        if (isNaN(num) || num < 0 || num > 255) {
          throw new Error('Invalid subnet mask: octets must be between 0 and 255');
        }
        bytes.push(num);
      }

      this.value = bytes.join('.');
      this.numeric = bytes.reduce((acc, byte, i) => acc + byte * Math.pow(256, 3 - i), 0);

      // Validate that it's a proper subnet mask (contiguous 1s followed by 0s)
      if (!this.isValidSubnetMask(this.numeric)) {
        throw new Error('Invalid subnet mask: must be contiguous 1s followed by 0s');
      }

      // Calculate CIDR
      this.cidr = this.countLeadingOnes(this.numeric);
    }
  }

  /**
   * Creates a subnet mask from CIDR notation
   *
   * @param cidr - CIDR value (0-32)
   * @returns SubnetMask instance
   * @throws {Error} If CIDR is invalid
   */
  public static fromCIDR(cidr: number): SubnetMask {
    if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) {
      throw new Error('Invalid CIDR: must be integer between 0 and 32');
    }
    return new SubnetMask(`/${cidr}`);
  }

  /**
   * Returns string representation in dotted decimal format
   */
  public toString(): string {
    return this.value;
  }

  /**
   * Returns CIDR notation (0-32)
   */
  public getCIDR(): number {
    return this.cidr;
  }

  /**
   * Returns number of usable host addresses (total - 2 for network and broadcast)
   */
  public getHostCount(): number {
    if (this.cidr === 32) return 0;
    if (this.cidr === 31) return 2; // Special case: point-to-point links
    return Math.pow(2, 32 - this.cidr) - 2;
  }

  /**
   * Returns total number of addresses in subnet
   */
  public getTotalAddresses(): number {
    return Math.pow(2, 32 - this.cidr);
  }

  /**
   * Returns numeric representation
   */
  public toNumber(): number {
    return this.numeric;
  }

  /**
   * Returns byte array representation
   */
  public toBytes(): number[] {
    return [
      (this.numeric >>> 24) & 0xff,
      (this.numeric >>> 16) & 0xff,
      (this.numeric >>> 8) & 0xff,
      this.numeric & 0xff
    ];
  }

  /**
   * Checks equality with another subnet mask
   */
  public equals(other: SubnetMask): boolean {
    return this.numeric === other.numeric;
  }

  /**
   * Validates if a number is a valid subnet mask
   * (contiguous 1s followed by contiguous 0s)
   */
  private isValidSubnetMask(num: number): boolean {
    // XOR with inverted gives all 1s after the mask bits
    // Adding 1 should give a power of 2 (single 1 bit)
    const inverted = ~num >>> 0;
    const plusOne = (inverted + 1) >>> 0;
    // Check if plusOne is a power of 2 or zero
    return plusOne === 0 || (plusOne & (plusOne - 1)) === 0;
  }

  /**
   * Counts leading ones in a 32-bit number
   */
  private countLeadingOnes(num: number): number {
    let count = 0;
    for (let i = 31; i >= 0; i--) {
      if ((num & (1 << i)) !== 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Converts a 32-bit number to IP string
   */
  private numberToIPString(num: number): string {
    return [
      (num >>> 24) & 0xff,
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff
    ].join('.');
  }
}
