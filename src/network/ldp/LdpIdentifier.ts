import { IPAddress } from '@/network/core/types';

export const LDP_IDENTIFIER_BYTES = 6;

export class LdpIdentifier {
  private constructor(readonly lsrId: IPAddress, readonly labelSpace: number) {}

  static of(lsrId: IPAddress, labelSpace = 0): LdpIdentifier {
    if (!Number.isInteger(labelSpace) || labelSpace < 0 || labelSpace > 0xffff) {
      throw new RangeError(`Invalid label space ${labelSpace}: must be an integer in 0-65535`);
    }
    return new LdpIdentifier(lsrId, labelSpace);
  }

  static tryParse(text: string): LdpIdentifier | null {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text.trim());
    if (!match) return null;
    const lsrId = IPAddress.tryParse(match[1]);
    const labelSpace = Number(match[2]);
    return lsrId !== null && labelSpace <= 0xffff ? new LdpIdentifier(lsrId, labelSpace) : null;
  }

  static decode(bytes: Uint8Array, offset = 0): LdpIdentifier {
    const lsrId = new IPAddress([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]);
    return new LdpIdentifier(lsrId, (bytes[offset + 4] << 8) | bytes[offset + 5]);
  }

  encode(): Uint8Array {
    const [a, b, c, d] = this.lsrId.getOctets();
    return new Uint8Array([a, b, c, d, this.labelSpace >> 8, this.labelSpace & 0xff]);
  }

  isPlatformWide(): boolean {
    return this.labelSpace === 0;
  }

  equals(other: LdpIdentifier): boolean {
    return this.labelSpace === other.labelSpace && this.lsrId.equals(other.lsrId);
  }

  toString(): string {
    return `${this.lsrId}:${this.labelSpace}`;
  }
}
