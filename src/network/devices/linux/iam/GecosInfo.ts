/**
 * GecosInfo — immutable value object for the GECOS field of a Unix account.
 *
 * The 5th field of `/etc/passwd` (historically "General Electric Comprehensive
 * Operating System") is a comma-separated record. The `finger` / `chfn`
 * convention assigns five sub-fields:
 *
 *   1. Full name       (chfn -f)
 *   2. Room number     (chfn -r)
 *   3. Work phone      (chfn -w)
 *   4. Home phone      (chfn -h)
 *   5. Other           (free text)
 *
 * Modelled as an immutable value object: every mutator returns a fresh
 * instance, and equality is structural. This mirrors how a real account's
 * finger record behaves — it is data, not an entity with identity.
 */
export class GecosInfo {
  /** Number of conventional GECOS sub-fields. */
  static readonly FIELD_COUNT = 5;

  /** Canonical empty record. */
  static readonly EMPTY = new GecosInfo();

  constructor(
    readonly fullName: string = '',
    readonly roomNumber: string = '',
    readonly workPhone: string = '',
    readonly homePhone: string = '',
    readonly other: string = '',
  ) {}

  /**
   * Parse a raw comma-separated GECOS string into a structured record.
   * Any commas beyond the 5th sub-field are folded back into `other`, so a
   * round-trip never loses data.
   */
  static parse(raw: string): GecosInfo {
    if (!raw) return GecosInfo.EMPTY;
    const parts = raw.split(',');
    return new GecosInfo(
      parts[0] ?? '',
      parts[1] ?? '',
      parts[2] ?? '',
      parts[3] ?? '',
      parts.slice(4).join(','),
    );
  }

  /**
   * Render to the canonical `/etc/passwd` sub-field. Always emits the five
   * fields joined by commas (e.g. `Marie Martin,202,,,`) — the format the
   * `finger`/`chfn`/`getent` tooling expects.
   */
  toString(): string {
    return [this.fullName, this.roomNumber, this.workPhone, this.homePhone, this.other].join(',');
  }

  /** True when no sub-field carries information. */
  isEmpty(): boolean {
    return (
      this.fullName === '' &&
      this.roomNumber === '' &&
      this.workPhone === '' &&
      this.homePhone === '' &&
      this.other === ''
    );
  }

  /** Structural equality. */
  equals(other: GecosInfo): boolean {
    return (
      this.fullName === other.fullName &&
      this.roomNumber === other.roomNumber &&
      this.workPhone === other.workPhone &&
      this.homePhone === other.homePhone &&
      this.other === other.other
    );
  }

  withFullName(value: string): GecosInfo {
    return new GecosInfo(value, this.roomNumber, this.workPhone, this.homePhone, this.other);
  }

  withRoomNumber(value: string): GecosInfo {
    return new GecosInfo(this.fullName, value, this.workPhone, this.homePhone, this.other);
  }

  withWorkPhone(value: string): GecosInfo {
    return new GecosInfo(this.fullName, this.roomNumber, value, this.homePhone, this.other);
  }

  withHomePhone(value: string): GecosInfo {
    return new GecosInfo(this.fullName, this.roomNumber, this.workPhone, value, this.other);
  }

  withOther(value: string): GecosInfo {
    return new GecosInfo(this.fullName, this.roomNumber, this.workPhone, this.homePhone, value);
  }
}
