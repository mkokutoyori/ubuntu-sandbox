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

import { pwqualityCheck } from './LibPwquality';
import { PasswordQualityResult } from './PasswordQualityResult';

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
  dictionaryWords?: readonly string[];
  userSubstr?: number;
}

const DEFAULT_DICTIONARY_WORDS = [
  'password', 'passwd', 'admin', 'root', 'qwerty', 'azerty',
  'letmein', 'welcome', 'login', 'secret', 'changeme', 'ubuntu',
];

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
  /** `usersubstr` — the substring length of the login name checked (0 = whole name). */
  userSubstr: number;
  /** `dictcheck` — reject cracklib dictionary words (a built-in word list stands in). */
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
  /** `badwords` — extra forbidden words, checked like the login name. */
  badWords: string[];
  /** A small built-in word list standing in for the cracklib dictionary. */
  dictionaryWords: string[];

  constructor(init: PasswordQualityPolicyInit = {}) {
    this.minLength = init.minLength ?? 8;
    this.digitCredit = init.digitCredit ?? 0;
    this.uppercaseCredit = init.uppercaseCredit ?? 0;
    this.lowercaseCredit = init.lowercaseCredit ?? 0;
    this.otherCredit = init.otherCredit ?? 0;
    this.minClasses = init.minClasses ?? 0;
    this.maxRepeat = init.maxRepeat ?? 0;
    this.maxClassRepeat = init.maxClassRepeat ?? 0;
    this.maxSequence = init.maxSequence ?? 0;
    this.difOk = init.difOk ?? 1;
    this.gecosCheck = init.gecosCheck ?? true;
    this.userCheck = init.userCheck ?? true;
    this.userSubstr = init.userSubstr ?? 0;
    this.dictCheck = init.dictCheck ?? true;
    this.enforcing = init.enforcing ?? true;
    this.enforceForRoot = init.enforceForRoot ?? false;
    this.localUsersOnly = init.localUsersOnly ?? false;
    this.retry = init.retry ?? 3;
    this.dictPath = init.dictPath ?? '';
    this.badWords = [...(init.badWords ?? [])];
    this.dictionaryWords = [...(init.dictionaryWords ?? DEFAULT_DICTIONARY_WORDS)];
  }

  /** The libpwquality defaults (`pwquality_default_settings`), with Ubuntu's `retry=3`. */
  static defaults(): PasswordQualityPolicy {
    return new PasswordQualityPolicy();
  }

  /** Apply a partial set of overrides, returning the names of changed fields. */
  apply(changes: PasswordQualityPolicyInit): string[] {
    const changed: string[] = [];
    const set = <K extends keyof PasswordQualityPolicy>(key: K, value: PasswordQualityPolicy[K] | undefined) => {
      if (value !== undefined && this[key] !== value) {
        this[key] = value as this[K];
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
    set('userSubstr', changes.userSubstr);
    set('dictCheck', changes.dictCheck);
    set('enforcing', changes.enforcing);
    set('enforceForRoot', changes.enforceForRoot);
    set('localUsersOnly', changes.localUsersOnly);
    set('retry', changes.retry);
    return changed;
  }

  /**
   * Judge a candidate password with libpwquality's own algorithm
   * ({@link pwqualityCheck}): the first failing check is the verdict.
   */
  evaluate(password: string, ctx: PasswordQualityContext = {}): PasswordQualityResult {
    const verdict = pwqualityCheck(this, password, ctx.oldPassword ?? null, ctx.username ?? null, ctx.gecos ?? null);
    if (!('failure' in verdict)) return PasswordQualityResult.accepted();
    return PasswordQualityResult.rejected([verdict.failure]);
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
      `usersubstr = ${this.userSubstr}`,
      `enforcing = ${this.enforcing ? 1 : 0}`,
      `retry = ${this.retry}`,
      `enforce_for_root = ${this.enforceForRoot ? 'true' : 'false'}`,
      `local_users_only = ${this.localUsersOnly ? 'true' : 'false'}`,
      ...(this.badWords.length > 0 ? [`badwords = ${this.badWords.join(' ')}`] : []),
      '',
    ].join('\n');
  }
}
