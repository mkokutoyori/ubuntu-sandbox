export class ChecksumCoverage {
  static readonly MIN_PARTIAL = 8;
  static readonly MAX = 65535;
  static readonly FULL = new ChecksumCoverage(0);
  readonly value: number;

  constructor(value: number) {
    if (!ChecksumCoverage.isValid(value)) {
      throw new RangeError(
        `Invalid checksum coverage ${value}: must be 0 (the whole datagram) or an integer in `
        + `${ChecksumCoverage.MIN_PARTIAL}–${ChecksumCoverage.MAX}`,
      );
    }
    this.value = value;
  }

  static of(value: number): ChecksumCoverage {
    return new ChecksumCoverage(value);
  }

  static isValid(value: number): boolean {
    return Number.isInteger(value)
      && (value === 0 || (value >= ChecksumCoverage.MIN_PARTIAL && value <= ChecksumCoverage.MAX));
  }

  get coversWholeDatagram(): boolean {
    return this.value === 0;
  }

  equals(other: ChecksumCoverage): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}
