export const MPLS_LABEL_BITS = 20;
export const MPLS_LABEL_MAX = (1 << MPLS_LABEL_BITS) - 1;
export const MPLS_FIRST_UNRESERVED_LABEL = 16;

export const ETHERTYPE_MPLS_UNICAST = 0x8847;
export const ETHERTYPE_MPLS_MULTICAST = 0x8848;

export class MplsLabel {
  private constructor(readonly value: number) {}

  static of(value: number): MplsLabel {
    if (!Number.isInteger(value) || value < 0 || value > MPLS_LABEL_MAX) {
      throw new RangeError(`Invalid MPLS label ${value}: must be an integer in 0-${MPLS_LABEL_MAX}`);
    }
    return new MplsLabel(value);
  }

  static tryParse(text: string): MplsLabel | null {
    if (!/^\d+$/.test(text.trim())) return null;
    const value = Number(text.trim());
    return value <= MPLS_LABEL_MAX ? new MplsLabel(value) : null;
  }

  static readonly IPV4_EXPLICIT_NULL = new MplsLabel(0);
  static readonly ROUTER_ALERT = new MplsLabel(1);
  static readonly IPV6_EXPLICIT_NULL = new MplsLabel(2);
  static readonly IMPLICIT_NULL = new MplsLabel(3);
  static readonly ENTROPY_LABEL_INDICATOR = new MplsLabel(7);
  static readonly GENERIC_ASSOCIATED_CHANNEL = new MplsLabel(13);
  static readonly EXTENSION = new MplsLabel(15);

  isSpecialPurpose(): boolean {
    return this.value < MPLS_FIRST_UNRESERVED_LABEL;
  }

  isExplicitNull(): boolean {
    return this.value === 0 || this.value === 2;
  }

  isImplicitNull(): boolean {
    return this.value === 3;
  }

  equals(other: MplsLabel): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }

  toJSON(): number {
    return this.value;
  }
}
