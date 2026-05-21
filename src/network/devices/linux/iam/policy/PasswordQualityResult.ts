/**
 * PasswordQualityResult — value object describing the verdict of a
 * {@link PasswordQualityPolicy} evaluation.
 *
 * `pam_pwquality` does not return a boolean; it returns *why* a password was
 * rejected. Modelling the verdict as a list of structured violations (a
 * machine-readable `rule` plus the faithful human message a real host prints)
 * keeps every consumer — the `passwd` diagnostic, the audit log, a future
 * "password strength" UI meter — a pure projection of the same record.
 *
 * It is an immutable value object: two results with the same violations are
 * interchangeable, and an evaluation never mutates one in place.
 */

/** The individual rules `pam_pwquality` enforces. Extensible by design. */
export enum PasswordQualityRule {
  Empty = 'empty',
  MinLength = 'min-length',
  MinDigits = 'min-digits',
  MinUppercase = 'min-uppercase',
  MinLowercase = 'min-lowercase',
  MinOther = 'min-other',
  MinClasses = 'min-classes',
  MaxRepeat = 'max-repeat',
  MaxClassRepeat = 'max-class-repeat',
  MaxSequence = 'max-sequence',
  TooSimilar = 'too-similar',
  ContainsUsername = 'contains-username',
  ContainsGecos = 'contains-gecos',
  Palindrome = 'palindrome',
  DictionaryWord = 'dictionary-word',
}

/** A single reason a password was rejected. */
export interface PasswordQualityViolation {
  readonly rule: PasswordQualityRule;
  /** The faithful message a real host would print (English — see man pwquality). */
  readonly message: string;
}

export class PasswordQualityResult {
  private readonly _violations: readonly PasswordQualityViolation[];

  constructor(violations: readonly PasswordQualityViolation[] = []) {
    this._violations = [...violations];
  }

  /** A passing verdict — no violations. */
  static accepted(): PasswordQualityResult {
    return new PasswordQualityResult([]);
  }

  /** A failing verdict built from one or more violations. */
  static rejected(violations: readonly PasswordQualityViolation[]): PasswordQualityResult {
    return new PasswordQualityResult(violations);
  }

  get violations(): readonly PasswordQualityViolation[] {
    return this._violations;
  }

  /** True when the password satisfies every rule. */
  get acceptable(): boolean {
    return this._violations.length === 0;
  }

  /** The faithful human messages, in evaluation order. */
  get messages(): string[] {
    return this._violations.map((v) => v.message);
  }

  /** The machine-readable rule codes that failed. */
  get failedRules(): PasswordQualityRule[] {
    return this._violations.map((v) => v.rule);
  }

  /** True when a specific rule was violated. */
  violated(rule: PasswordQualityRule): boolean {
    return this._violations.some((v) => v.rule === rule);
  }

  /**
   * The single line `passwd` prints after a weak entry, e.g.
   * `BAD PASSWORD: The password is shorter than 8 characters`.
   * Returns null when the password is acceptable.
   */
  toBadPasswordLine(): string | null {
    if (this.acceptable) return null;
    return `BAD PASSWORD: ${this._violations[0].message}`;
  }
}
