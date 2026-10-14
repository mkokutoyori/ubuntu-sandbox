export const VID_NULL = 0;
export const VID_DEFAULT_PVID = 1;
export const VID_DEFAULT_SR_PVID = 2;
export const VID_MAX_CONFIGURABLE = 4094;
export const VID_WILDCARD = 0xfff;

export class VlanId {
  private constructor(readonly value: number) {}

  static of(value: number): VlanId {
    if (!Number.isInteger(value) || value < 0 || value > VID_WILDCARD) {
      throw new RangeError(`VLAN identifier ${value} does not fit the 12-bit VID field`);
    }
    return new VlanId(value);
  }

  static tryParse(text: string | number | undefined): VlanId | undefined {
    if (text === undefined) return undefined;
    const numeric = typeof text === 'number' ? text : /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= VID_WILDCARD ? new VlanId(numeric) : undefined;
  }

  get isNull(): boolean { return this.value === VID_NULL; }

  get isWildcard(): boolean { return this.value === VID_WILDCARD; }

  get isConfigurable(): boolean {
    return this.value >= 1 && this.value <= VID_MAX_CONFIGURABLE;
  }

  equals(other: VlanId): boolean { return this.value === other.value; }

  toString(): string { return String(this.value); }
}
