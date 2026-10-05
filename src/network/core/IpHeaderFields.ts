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

export class HopLimit {
  static readonly MIN = 0;
  static readonly MAX = 255;
  readonly value: number;

  constructor(value: number) {
    if (!HopLimit.isValid(value)) {
      throw new RangeError(
        `Invalid hop limit ${value}: must be an integer in ${HopLimit.MIN}–${HopLimit.MAX}`,
      );
    }
    this.value = value;
  }

  static of(value: number): HopLimit {
    return new HopLimit(value);
  }

  static isValid(value: number): boolean {
    return Number.isInteger(value) && value >= HopLimit.MIN && value <= HopLimit.MAX;
  }

  equals(other: HopLimit): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}

export class TtlFloor {
  static readonly MIN = 0;
  static readonly MAX = 255;
  static readonly NONE = new TtlFloor(0);
  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < TtlFloor.MIN || value > TtlFloor.MAX) {
      throw new RangeError(
        `Invalid minimum incoming TTL ${value}: must be an integer in ${TtlFloor.MIN}–${TtlFloor.MAX}`,
      );
    }
    this.value = value;
  }

  static of(value: number): TtlFloor {
    return new TtlFloor(value);
  }

  admits(receivedTtl: number): boolean {
    return receivedTtl >= this.value;
  }

  equals(other: TtlFloor): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}

export const DSCP_CODEPOINTS = {
  default: 0,
  cs0: 0, cs1: 8, cs2: 16, cs3: 24, cs4: 32, cs5: 40, cs6: 48, cs7: 56,
  af11: 10, af12: 12, af13: 14, af21: 18, af22: 20, af23: 22,
  af31: 26, af32: 28, af33: 30, af41: 34, af42: 36, af43: 38, ef: 46,
} as const satisfies Readonly<Record<string, number>>;

export class EcnCodepoint {
  static readonly MASK = 0b11;
  static readonly NOT_ECT = new EcnCodepoint(0b00);
  static readonly ECT_1 = new EcnCodepoint(0b01);
  static readonly ECT_0 = new EcnCodepoint(0b10);
  static readonly CE = new EcnCodepoint(0b11);
  readonly bits: number;

  private constructor(bits: number) {
    this.bits = bits;
  }

  static of(bits: number): EcnCodepoint {
    if (!Number.isInteger(bits) || bits < 0 || bits > EcnCodepoint.MASK) {
      throw new RangeError(`Invalid ECN codepoint ${bits}: must be an integer in 0–${EcnCodepoint.MASK}`);
    }
    return [EcnCodepoint.NOT_ECT, EcnCodepoint.ECT_1, EcnCodepoint.ECT_0, EcnCodepoint.CE][bits];
  }

  static ofField(field: number): EcnCodepoint {
    return EcnCodepoint.of(field & EcnCodepoint.MASK);
  }

  get capable(): boolean {
    return this !== EcnCodepoint.NOT_ECT;
  }

  get congestionExperienced(): boolean {
    return this === EcnCodepoint.CE;
  }

  equals(other: EcnCodepoint): boolean {
    return this.bits === other.bits;
  }

  toString(): string {
    return ['Not-ECT', 'ECT(1)', 'ECT(0)', 'CE'][this.bits];
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

  get ecn(): EcnCodepoint {
    return EcnCodepoint.ofField(this.value);
  }

  withEcn(ecn: EcnCodepoint): DiffServField {
    return new DiffServField((this.value & ~EcnCodepoint.MASK) | ecn.bits);
  }

  equals(other: DiffServField): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return `0x${this.value.toString(16).padStart(2, '0')}`;
  }
}
