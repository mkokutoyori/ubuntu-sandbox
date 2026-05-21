/**
 * PasswordQualityPolicy — model of `/etc/security/pwquality.conf`, the
 * configuration `pam_pwquality` consults whenever `passwd` validates a new
 * secret on a Debian/Ubuntu host.
 *
 * Modelled as a class — not a bag of constants — because the simulator both
 * *renders* it (the on-disk config file stays coherent with the model) and
 * *reads* it back (`evaluate()` is the real strength check `passwd` runs).
 * Editing the policy genuinely changes which passwords are accepted, exactly
 * as on real equipment.
 *
 * Every key a real `pwquality.conf` carries is modelled, even the ones the
 * simulator does not consume yet (`dictPath`, `badWords`, `localUsersOnly`):
 * a later dictionary-check or strength-meter enhancement is then a pure
 * addition, never a schema change.
 */

import {
  PasswordQualityResult,
  PasswordQualityRule,
  type PasswordQualityViolation,
} from './PasswordQualityResult';

/** Context a password is judged against (the account it is being set for). */
export interface PasswordQualityContext {
  /** The account's login name — drives the `usercheck` rule. */
  username?: string;
  /** The account's GECOS comment — drives the `gecoscheck` rule. */
  gecos?: string;
  /** The previous password — drives the `difok` similarity rule. */
  oldPassword?: string;
}

export interface PasswordQualityPolicyInit {
  minLength?: number;
  digitCredit?: number;
  uppercaseCredit?: number;
  lowercaseCredit?: number;
  otherCredit?: number;
  minClasses?: number;
  maxRepeat?: number;
  maxClassRepeat?: number;
  maxSequence?: number;
  difOk?: number;
  gecosCheck?: boolean;
  userCheck?: boolean;
  dictCheck?: boolean;
  enforcing?: boolean;
  enforceForRoot?: boolean;
  localUsersOnly?: boolean;
  retry?: number;
  dictPath?: string;
  badWords?: readonly string[];
}

/** The four character classes `pam_pwquality` recognises. */
const enum CharClass {
  Lower = 'lowercase',
  Upper = 'uppercase',
  Digit = 'digit',
  Other = 'other',
}

/** Hard floor `pam_pwquality` imposes on `minlen` regardless of config. */
const MINLEN_FLOOR = 6;

export class PasswordQualityPolicy {
  /** `minlen` — required length, offset by per-class credits. */
  minLength: number;
  /** `dcredit` / `ucredit` / `lcredit` / `ocredit` — see {@link evaluate}. */
  digitCredit: number;
  uppercaseCredit: number;
  lowercaseCredit: number;
  otherCredit: number;
  /** `minclass` — minimum number of distinct character classes. */
  minClasses: number;
  /** `maxrepeat` — longest run of one identical character (0 = unchecked). */
  maxRepeat: number;
  /** `maxclassrepeat` — longest run of one character class (0 = unchecked). */
  maxClassRepeat: number;
  /** `maxsequence` — longest monotonic run, e.g. `abcd`/`4321` (0 = unchecked). */
  maxSequence: number;
  /** `difok` — characters that must differ from the previous password. */
  difOk: number;
  /** `gecoscheck` — reject passwords containing words from the GECOS field. */
  gecosCheck: boolean;
  /** `usercheck` — reject passwords containing the login name. */
  userCheck: boolean;
  /** `dictcheck` — reject cracklib dictionary words (modelled, see badWords). */
  dictCheck: boolean;
  /** `enforcing` — when false, weak passwords are only warned about. */
  enforcing: boolean;
  /** `enforce_for_root` — apply `enforcing` to uid 0 as well. */
  enforceForRoot: boolean;
  /** `local_users_only` — skip the check for NSS/remote accounts. */
  localUsersOnly: boolean;
  /** `retry` — how many times `passwd` re-prompts after a rejection. */
  retry: number;
  /** `dictpath` — cracklib dictionary location (modelled, not consumed yet). */
  dictPath: string;
  /** A small built-in word list standing in for the cracklib dictionary. */
  badWords: string[];

  constructor(init: PasswordQualityPolicyInit = {}) {
    this.minLength = init.minLength ?? 8;
    this.digitCredit = init.digitCredit ?? 1;
    this.uppercaseCredit = init.uppercaseCredit ?? 1;
    this.lowercaseCredit = init.lowercaseCredit ?? 1;
    this.otherCredit = init.otherCredit ?? 1;
    this.minClasses = init.minClasses ?? 0;
    this.maxRepeat = init.maxRepeat ?? 0;
    this.maxClassRepeat = init.maxClassRepeat ?? 0;
    this.maxSequence = init.maxSequence ?? 0;
    this.difOk = init.difOk ?? 1;
    this.gecosCheck = init.gecosCheck ?? true;
    this.userCheck = init.userCheck ?? true;
    this.dictCheck = init.dictCheck ?? true;
    this.enforcing = init.enforcing ?? true;
    this.enforceForRoot = init.enforceForRoot ?? false;
    this.localUsersOnly = init.localUsersOnly ?? true;
    this.retry = init.retry ?? 3;
    this.dictPath = init.dictPath ?? '';
    this.badWords = [...(init.badWords ?? DEFAULT_BAD_WORDS)];
  }

  /** Stock Debian/Ubuntu policy. */
  static defaults(): PasswordQualityPolicy {
    return new PasswordQualityPolicy();
  }

  /** Apply a partial set of overrides, returning the names of changed fields. */
  apply(changes: PasswordQualityPolicyInit): string[] {
    const changed: string[] = [];
    const set = <K extends keyof PasswordQualityPolicy>(key: K, value: PasswordQualityPolicy[K] | undefined) => {
      if (value !== undefined && this[key] !== value) {
        this[key] = value;
        changed.push(String(key));
      }
    };
    set('minLength', changes.minLength);
    set('digitCredit', changes.digitCredit);
    set('uppercaseCredit', changes.uppercaseCredit);
    set('lowercaseCredit', changes.lowercaseCredit);
    set('otherCredit', changes.otherCredit);
    set('minClasses', changes.minClasses);
    set('maxRepeat', changes.maxRepeat);
    set('maxClassRepeat', changes.maxClassRepeat);
    set('maxSequence', changes.maxSequence);
    set('difOk', changes.difOk);
    set('gecosCheck', changes.gecosCheck);
    set('userCheck', changes.userCheck);
    set('dictCheck', changes.dictCheck);
    set('enforcing', changes.enforcing);
    set('enforceForRoot', changes.enforceForRoot);
    set('localUsersOnly', changes.localUsersOnly);
    set('retry', changes.retry);
    return changed;
  }

  // ─── Evaluation ────────────────────────────────────────────────────────

  /**
   * Judge a candidate password. Returns a {@link PasswordQualityResult}
   * carrying every violation, in the order `pam_pwquality` reports them.
   */
  evaluate(password: string, ctx: PasswordQualityContext = {}): PasswordQualityResult {
    const violations: PasswordQualityViolation[] = [];

    if (password.length === 0) {
      return PasswordQualityResult.rejected([
        { rule: PasswordQualityRule.Empty, message: 'No password supplied' },
      ]);
    }

    const counts = countClasses(password);

    this.checkCreditedLength(password, counts, violations);
    this.checkClassMinimums(counts, violations);
    this.checkClassCount(counts, violations);
    this.checkRepeats(password, violations);
    this.checkSequence(password, violations);
    this.checkSimilarity(password, ctx.oldPassword, violations);
    this.checkPalindrome(password, violations);
    this.checkUserName(password, ctx.username, violations);
    this.checkGecos(password, ctx.gecos, violations);
    this.checkDictionary(password, violations);

    return new PasswordQualityResult(violations);
  }

  /**
   * Whether a rejection should *block* the change for a given actor. `passwd`
   * run by root only warns (unless `enforce_for_root`); a non-enforcing
   * policy never blocks anyone.
   */
  blocksFor(actorUid: number): boolean {
    if (!this.enforcing) return false;
    if (actorUid === 0) return this.enforceForRoot;
    return true;
  }

  // ─── Individual rules ──────────────────────────────────────────────────

  /**
   * Credited length: every character of a class with a *positive* credit
   * shortens the required length by up to that credit. A *negative* credit
   * is handled as a class minimum (see {@link checkClassMinimums}).
   */
  private checkCreditedLength(
    password: string,
    counts: Record<CharClass, number>,
    out: PasswordQualityViolation[],
  ): void {
    let credited = password.length;
    credited += earnedCredit(counts[CharClass.Digit], this.digitCredit);
    credited += earnedCredit(counts[CharClass.Upper], this.uppercaseCredit);
    credited += earnedCredit(counts[CharClass.Lower], this.lowercaseCredit);
    credited += earnedCredit(counts[CharClass.Other], this.otherCredit);

    const required = Math.max(this.minLength, MINLEN_FLOOR);
    if (credited < required) {
      out.push({
        rule: PasswordQualityRule.MinLength,
        message: `The password is shorter than ${required} characters`,
      });
    }
  }

  private checkClassMinimums(
    counts: Record<CharClass, number>,
    out: PasswordQualityViolation[],
  ): void {
    requireClass(counts[CharClass.Digit], this.digitCredit, out, PasswordQualityRule.MinDigits, 'digits');
    requireClass(counts[CharClass.Upper], this.uppercaseCredit, out, PasswordQualityRule.MinUppercase, 'uppercase letters');
    requireClass(counts[CharClass.Lower], this.lowercaseCredit, out, PasswordQualityRule.MinLowercase, 'lowercase letters');
    requireClass(counts[CharClass.Other], this.otherCredit, out, PasswordQualityRule.MinOther, 'non-alphanumeric characters');
  }

  private checkClassCount(
    counts: Record<CharClass, number>,
    out: PasswordQualityViolation[],
  ): void {
    if (this.minClasses <= 0) return;
    const present = Object.values(counts).filter((n) => n > 0).length;
    if (present < this.minClasses) {
      out.push({
        rule: PasswordQualityRule.MinClasses,
        message: `The password contains less than ${this.minClasses} character classes`,
      });
    }
  }

  private checkRepeats(password: string, out: PasswordQualityViolation[]): void {
    if (this.maxRepeat > 0 && longestIdenticalRun(password) > this.maxRepeat) {
      out.push({
        rule: PasswordQualityRule.MaxRepeat,
        message: `The password contains more than ${this.maxRepeat} same characters consecutively`,
      });
    }
    if (this.maxClassRepeat > 0 && longestClassRun(password) > this.maxClassRepeat) {
      out.push({
        rule: PasswordQualityRule.MaxClassRepeat,
        message: `The password contains more than ${this.maxClassRepeat} characters of the same class consecutively`,
      });
    }
  }

  private checkSequence(password: string, out: PasswordQualityViolation[]): void {
    if (this.maxSequence > 0 && longestMonotonicRun(password) > this.maxSequence) {
      out.push({
        rule: PasswordQualityRule.MaxSequence,
        message: `The password contains monotonic sequence longer than ${this.maxSequence} characters`,
      });
    }
  }

  private checkSimilarity(
    password: string,
    oldPassword: string | undefined,
    out: PasswordQualityViolation[],
  ): void {
    if (!oldPassword || this.difOk <= 0) return;
    if (password === oldPassword) {
      out.push({ rule: PasswordQualityRule.TooSimilar, message: 'The password is the same as the old one' });
      return;
    }
    if (differingCharacters(password, oldPassword) < this.difOk) {
      out.push({ rule: PasswordQualityRule.TooSimilar, message: 'The password is too similar to the old one' });
    }
  }

  private checkPalindrome(password: string, out: PasswordQualityViolation[]): void {
    if (password.length >= 3 && isPalindrome(password)) {
      out.push({ rule: PasswordQualityRule.Palindrome, message: 'The password is a palindrome' });
    }
  }

  private checkUserName(
    password: string,
    username: string | undefined,
    out: PasswordQualityViolation[],
  ): void {
    if (!this.userCheck || !username || username.length < 3) return;
    const lower = password.toLowerCase();
    if (lower.includes(username.toLowerCase()) || lower.includes(reverse(username.toLowerCase()))) {
      out.push({
        rule: PasswordQualityRule.ContainsUsername,
        message: 'The password contains the user name in some form',
      });
    }
  }

  private checkGecos(
    password: string,
    gecos: string | undefined,
    out: PasswordQualityViolation[],
  ): void {
    if (!this.gecosCheck || !gecos) return;
    const lower = password.toLowerCase();
    const words = gecos.split(/[\s,]+/).filter((w) => w.length >= 3);
    if (words.some((w) => lower.includes(w.toLowerCase()))) {
      out.push({
        rule: PasswordQualityRule.ContainsGecos,
        message: 'The password contains words from the real name of the user in some form',
      });
    }
  }

  private checkDictionary(password: string, out: PasswordQualityViolation[]): void {
    if (!this.dictCheck) return;
    const lower = password.toLowerCase();
    if (this.badWords.some((w) => lower === w || lower.startsWith(w))) {
      out.push({
        rule: PasswordQualityRule.DictionaryWord,
        message: 'The password fails the dictionary check - it is based on a dictionary word',
      });
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  /** Render the canonical `/etc/security/pwquality.conf` file content. */
  render(): string {
    return [
      '# Configuration for systemwide password quality limits',
      '# Built and kept coherent by the simulator IAM layer.',
      '',
      `difok = ${this.difOk}`,
      `minlen = ${this.minLength}`,
      `dcredit = ${this.digitCredit}`,
      `ucredit = ${this.uppercaseCredit}`,
      `lcredit = ${this.lowercaseCredit}`,
      `ocredit = ${this.otherCredit}`,
      `minclass = ${this.minClasses}`,
      `maxrepeat = ${this.maxRepeat}`,
      `maxclassrepeat = ${this.maxClassRepeat}`,
      `maxsequence = ${this.maxSequence}`,
      `gecoscheck = ${this.gecosCheck ? 1 : 0}`,
      `dictcheck = ${this.dictCheck ? 1 : 0}`,
      `usercheck = ${this.userCheck ? 1 : 0}`,
      `enforcing = ${this.enforcing ? 1 : 0}`,
      `retry = ${this.retry}`,
      `enforce_for_root = ${this.enforceForRoot ? 'true' : 'false'}`,
      `local_users_only = ${this.localUsersOnly ? 'true' : 'false'}`,
      '',
    ].join('\n');
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

/** A few obvious cracklib-style words the dictionary check rejects. */
const DEFAULT_BAD_WORDS = [
  'password', 'passwd', 'admin', 'root', 'qwerty', 'azerty',
  'letmein', 'welcome', 'login', 'secret', 'changeme', 'ubuntu',
];

function classOf(ch: string): CharClass {
  if (ch >= 'a' && ch <= 'z') return CharClass.Lower;
  if (ch >= 'A' && ch <= 'Z') return CharClass.Upper;
  if (ch >= '0' && ch <= '9') return CharClass.Digit;
  return CharClass.Other;
}

function countClasses(password: string): Record<CharClass, number> {
  const counts: Record<CharClass, number> = {
    [CharClass.Lower]: 0,
    [CharClass.Upper]: 0,
    [CharClass.Digit]: 0,
    [CharClass.Other]: 0,
  };
  for (const ch of password) counts[classOf(ch)] += 1;
  return counts;
}

/** Length credit earned from a class: only positive credits shorten `minlen`. */
function earnedCredit(present: number, credit: number): number {
  return credit > 0 ? Math.min(present, credit) : 0;
}

/** A negative credit means "require at least |credit| characters of this class". */
function requireClass(
  present: number,
  credit: number,
  out: PasswordQualityViolation[],
  rule: PasswordQualityRule,
  label: string,
): void {
  if (credit < 0 && present < -credit) {
    out.push({ rule, message: `The password contains less than ${-credit} ${label}` });
  }
}

function longestIdenticalRun(password: string): number {
  let longest = 1;
  let run = 1;
  for (let i = 1; i < password.length; i++) {
    run = password[i] === password[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return password.length === 0 ? 0 : longest;
}

function longestClassRun(password: string): number {
  let longest = 1;
  let run = 1;
  for (let i = 1; i < password.length; i++) {
    run = classOf(password[i]) === classOf(password[i - 1]) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return password.length === 0 ? 0 : longest;
}

function longestMonotonicRun(password: string): number {
  let longest = 1;
  let asc = 1;
  let desc = 1;
  for (let i = 1; i < password.length; i++) {
    const delta = password.charCodeAt(i) - password.charCodeAt(i - 1);
    asc = delta === 1 ? asc + 1 : 1;
    desc = delta === -1 ? desc + 1 : 1;
    longest = Math.max(longest, asc, desc);
  }
  return password.length === 0 ? 0 : longest;
}

function differingCharacters(a: string, b: string): number {
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff;
}

function isPalindrome(text: string): boolean {
  return text === reverse(text);
}

function reverse(text: string): string {
  return [...text].reverse().join('');
}
