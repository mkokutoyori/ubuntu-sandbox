/**
 * LinuxUserAccount — domain entity for a Unix user account.
 *
 * `UserEntry` is the structural contract (the union of the `/etc/passwd` and
 * `/etc/shadow` records). `LinuxUserAccount` is the class that implements it
 * with the full set of attributes and behaviour a real account carries —
 * password aging, account expiry, login accounting, system-vs-regular
 * classification — even where the simulator does not consume every field
 * yet. Modelling them now keeps later enhancements (a `lastlog` panel, a
 * `faillog` lockout policy, an audit timeline) a pure addition.
 *
 * It is an *entity*, not a value object: identity is the (uid, username)
 * pair and the manager mutates it in place via `usermod` / `chage`.
 */

import { GecosInfo } from './GecosInfo';

// ─── Structural contract ────────────────────────────────────────────────

/**
 * The persisted shape of an account — the projection written to
 * `/etc/passwd` + `/etc/shadow`. Kept as an interface so plain object
 * literals (tests, fixtures) remain assignable.
 */
export interface UserEntry {
  username: string;
  uid: number;
  gid: number;
  gecos: string;        // raw /etc/passwd field 5 (comma-separated)
  home: string;
  shell: string;
  password: string;     // hashed (simulated) shadow secret
  locked: boolean;
  lastChange: number;   // days since epoch of last password change
  minDays: number;      // shadow: minimum age
  maxDays: number;      // shadow: maximum age
  warnDays: number;     // shadow: warning period
  inactiveDays: number; // shadow: inactivity grace (-1 = disabled)
  expireDate: number;   // shadow: absolute expiry, days since epoch (-1 = never)
}

/** Whether the account is a system daemon account or an interactive login. */
export type AccountKind = 'system' | 'regular';

/** Reserved password placeholders that mean "no usable password". */
const NO_PASSWORD_TOKENS = new Set(['', '!', '*', '!!', 'x']);

/** UID below which an account is conventionally a system account on Debian/Ubuntu. */
export const SYSTEM_UID_CEILING = 1000;

// ─── Construction options ───────────────────────────────────────────────

export interface LinuxUserAccountInit {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  gecos?: string;
  password?: string;
  locked?: boolean;
  lastChange?: number;
  minDays?: number;
  maxDays?: number;
  warnDays?: number;
  inactiveDays?: number;
  expireDate?: number;
  systemAccount?: boolean;
  nonUnique?: boolean;
  createdAt?: number;
}

// ─── Entity ─────────────────────────────────────────────────────────────

export class LinuxUserAccount implements UserEntry {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  password: string;
  locked: boolean;
  lastChange: number;
  minDays: number;
  maxDays: number;
  warnDays: number;
  inactiveDays: number;
  expireDate: number;

  /** `useradd -r` — a non-interactive daemon/service account. */
  systemAccount: boolean;
  /** `useradd -o` — UID uniqueness was explicitly waived. */
  nonUnique: boolean;
  /** Wall-clock creation time (ms epoch) — audit / `chage`-style reporting. */
  readonly createdAt: number;
  /** Login accounting — mirrors `/var/log/lastlog`. Null until first login. */
  lastLoginAt: number | null = null;
  /** Consecutive failed authentications — mirrors `pam_faillock` tally. */
  failedLoginCount = 0;

  constructor(init: LinuxUserAccountInit) {
    this.username = init.username;
    this.uid = init.uid;
    this.gid = init.gid;
    this.home = init.home;
    this.shell = init.shell;
    this.gecos = init.gecos ?? '';
    this.password = init.password ?? '!';
    this.locked = init.locked ?? false;
    this.lastChange = init.lastChange ?? daysSinceEpoch();
    this.minDays = init.minDays ?? 0;
    this.maxDays = init.maxDays ?? 99999;
    this.warnDays = init.warnDays ?? 7;
    this.inactiveDays = init.inactiveDays ?? -1;
    this.expireDate = init.expireDate ?? -1;
    this.systemAccount = init.systemAccount ?? init.uid < SYSTEM_UID_CEILING;
    this.nonUnique = init.nonUnique ?? false;
    this.createdAt = init.createdAt ?? Date.now();
  }

  /** Adapt a plain `UserEntry` record (e.g. a legacy literal) into an entity. */
  static fromEntry(entry: UserEntry): LinuxUserAccount {
    const account = new LinuxUserAccount({
      username: entry.username,
      uid: entry.uid,
      gid: entry.gid,
      home: entry.home,
      shell: entry.shell,
      gecos: entry.gecos,
      password: entry.password,
      locked: entry.locked,
      lastChange: entry.lastChange,
      minDays: entry.minDays,
      maxDays: entry.maxDays,
      warnDays: entry.warnDays,
      inactiveDays: entry.inactiveDays,
      expireDate: entry.expireDate,
    });
    return account;
  }

  // ─── GECOS (structured access) ────────────────────────────────────────

  /** Parsed view of the GECOS field. */
  get gecosInfo(): GecosInfo {
    return GecosInfo.parse(this.gecos);
  }

  /** Replace the GECOS field from a structured record. */
  set gecosInfo(info: GecosInfo) {
    this.gecos = info.toString();
  }

  // ─── Classification ──────────────────────────────────────────────────

  get kind(): AccountKind {
    return this.systemAccount ? 'system' : 'regular';
  }

  /** True for shells that deny interactive login (`nologin`, `false`). */
  isLoginDisabledByShell(): boolean {
    return /(\/nologin|\/false)$/.test(this.shell);
  }

  /** True when the account holds a real (login-capable) password hash. */
  hasUsablePassword(): boolean {
    if (this.locked) return false;
    return !NO_PASSWORD_TOKENS.has(this.password);
  }

  // ─── Password / account aging ────────────────────────────────────────

  isLocked(): boolean {
    return this.locked;
  }

  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  /** Whether the password has aged past `maxDays` as of `today` (days since epoch). */
  isPasswordExpired(today: number = daysSinceEpoch()): boolean {
    if (this.maxDays >= 99999 || this.maxDays < 0) return false;
    return today > this.lastChange + this.maxDays;
  }

  /** Whether the account itself has reached its absolute expiry date. */
  isAccountExpired(today: number = daysSinceEpoch()): boolean {
    if (this.expireDate < 0) return false;
    return today >= this.expireDate;
  }

  /** Record a successful login (updates the lastlog timestamp, clears tally). */
  recordLogin(at: number = Date.now()): void {
    this.lastLoginAt = at;
    this.failedLoginCount = 0;
  }

  /** Record a failed authentication attempt (faillock tally). */
  recordFailedLogin(): void {
    this.failedLoginCount += 1;
  }

  // ─── Serialisation ───────────────────────────────────────────────────

  /** Render the `/etc/passwd` line for this account. */
  toPasswdLine(): string {
    return `${this.username}:x:${this.uid}:${this.gid}:${this.gecos}:${this.home}:${this.shell}`;
  }

  /** Render the `/etc/shadow` line for this account. */
  toShadowLine(): string {
    const secret = this.locked ? `!${this.password}` : this.password;
    const inactive = this.inactiveDays === -1 ? '' : String(this.inactiveDays);
    const expire = this.expireDate === -1 ? '' : String(this.expireDate);
    return `${this.username}:${secret}:${this.lastChange}:${this.minDays}:${this.maxDays}:${this.warnDays}:${inactive}:${expire}:`;
  }

  /** Project back to a plain `UserEntry` record. */
  toEntry(): UserEntry {
    return {
      username: this.username,
      uid: this.uid,
      gid: this.gid,
      gecos: this.gecos,
      home: this.home,
      shell: this.shell,
      password: this.password,
      locked: this.locked,
      lastChange: this.lastChange,
      minDays: this.minDays,
      maxDays: this.maxDays,
      warnDays: this.warnDays,
      inactiveDays: this.inactiveDays,
      expireDate: this.expireDate,
    };
  }
}

/** Days elapsed since the Unix epoch (shadow file time unit). */
export function daysSinceEpoch(at: number = Date.now()): number {
  return Math.floor(at / 86_400_000);
}
