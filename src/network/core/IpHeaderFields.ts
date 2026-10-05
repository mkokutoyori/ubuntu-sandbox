export class TimeToLive {
  static readonly MIN = 1;
  static readonly MAX = 255;
  readonly value: number;

  constructor(value: number) {
    if (!TimeToLive.isValid(value)) {
      throw new RangeError(
        `Invalid time to live ${value}: must be an integer in ${TimeToLive.MIN}–${TimeToLive.MAX}`,
      );
    }
    this.value = value;
  }

  static of(value: number): TimeToLive {
    return new TimeToLive(value);
  }

  static isValid(value: number): boolean {
    return Number.isInteger(value) && value >= TimeToLive.MIN && value <= TimeToLive.MAX;
  }

  equals(other: TimeToLive): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}

export class DiffServField {
  static readonly MAX = 255;
  static readonly DSCP_SHIFT = 2;
  static readonly DSCP_MAX = 63;
  static readonly DEFAULT = new DiffServField(0);
  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > DiffServField.MAX) {
      throw new RangeError(
        `Invalid differentiated services field ${value}: must be an integer in 0–${DiffServField.MAX}`,
      );
    }
    this.value = value;
  }

  static of(value: number): DiffServField {
    return new DiffServField(value);
  }

  static fromDscp(dscp: number): DiffServField {
    if (!Number.isInteger(dscp) || dscp < 0 || dscp > DiffServField.DSCP_MAX) {
      throw new RangeError(`Invalid DSCP ${dscp}: must be an integer in 0–${DiffServField.DSCP_MAX}`);
    }
    return new DiffServField(dscp << DiffServField.DSCP_SHIFT);
  }

  get dscp(): number {
    return this.value >>> DiffServField.DSCP_SHIFT;
  }

  equals(other: DiffServField): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return `0x${this.value.toString(16).padStart(2, '0')}`;
  }
}
