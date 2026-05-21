/**
 * LoginDefs — model of `/etc/login.defs`, the system-wide shadow-suite policy.
 *
 * This file is the single source of truth a real host consults when `useradd`,
 * `usermod`, `passwd` and friends need a default: the UID/GID allocation
 * ranges, password-aging policy, the mail directory, whether a user-private
 * group is created (`USERGROUPS_ENAB`), and so on.
 *
 * Modelled as a class — not a bag of constants — because the simulator reads
 * it back: `LinuxUserManager` seeds its UID/GID counters from `uidMin` /
 * `sysUidMin`, so editing the policy genuinely changes allocation behaviour,
 * exactly as on real equipment.
 */

export interface LoginDefsInit {
  mailDir?: string;
  passMaxDays?: number;
  passMinDays?: number;
  passWarnAge?: number;
  uidMin?: number;
  uidMax?: number;
  sysUidMin?: number;
  sysUidMax?: number;
  gidMin?: number;
  gidMax?: number;
  sysGidMin?: number;
  sysGidMax?: number;
  createHome?: boolean;
  umask?: string;
  usergroupsEnab?: boolean;
  encryptMethod?: string;
}

export class LoginDefs {
  /** Mailbox spool directory (`MAIL_DIR`). */
  mailDir: string;
  /** Password aging policy (`PASS_MAX_DAYS` / `PASS_MIN_DAYS` / `PASS_WARN_AGE`). */
  passMaxDays: number;
  passMinDays: number;
  passWarnAge: number;
  /** Regular-account UID window (`UID_MIN` / `UID_MAX`). */
  uidMin: number;
  uidMax: number;
  /** System-account UID window (`SYS_UID_MIN` / `SYS_UID_MAX`). */
  sysUidMin: number;
  sysUidMax: number;
  /** Regular-group GID window. */
  gidMin: number;
  gidMax: number;
  /** System-group GID window. */
  sysGidMin: number;
  sysGidMax: number;
  /** `CREATE_HOME` — create the home directory by default. */
  createHome: boolean;
  /** Default `UMASK` for newly created home directories. */
  umask: string;
  /** `USERGROUPS_ENAB` — give each user a private group of the same name. */
  usergroupsEnab: boolean;
  /** `ENCRYPT_METHOD` — the shadow hashing scheme. */
  encryptMethod: string;

  constructor(init: LoginDefsInit = {}) {
    this.mailDir = init.mailDir ?? '/var/mail';
    this.passMaxDays = init.passMaxDays ?? 99999;
    this.passMinDays = init.passMinDays ?? 0;
    this.passWarnAge = init.passWarnAge ?? 7;
    this.uidMin = init.uidMin ?? 1000;
    this.uidMax = init.uidMax ?? 60000;
    this.sysUidMin = init.sysUidMin ?? 100;
    this.sysUidMax = init.sysUidMax ?? 999;
    this.gidMin = init.gidMin ?? 1000;
    this.gidMax = init.gidMax ?? 60000;
    this.sysGidMin = init.sysGidMin ?? 100;
    this.sysGidMax = init.sysGidMax ?? 999;
    this.createHome = init.createHome ?? true;
    this.umask = init.umask ?? '022';
    this.usergroupsEnab = init.usergroupsEnab ?? true;
    this.encryptMethod = init.encryptMethod ?? 'YESCRYPT';
  }

  /** Stock Debian/Ubuntu policy. */
  static defaults(): LoginDefs {
    return new LoginDefs();
  }

  /** Render the canonical `/etc/login.defs` file content. */
  render(): string {
    return [
      '#',
      '# /etc/login.defs - Configuration control definitions for the login package.',
      '#',
      '',
      `MAIL_DIR        ${this.mailDir}`,
      '',
      `PASS_MAX_DAYS   ${this.passMaxDays}`,
      `PASS_MIN_DAYS   ${this.passMinDays}`,
      `PASS_WARN_AGE   ${this.passWarnAge}`,
      '',
      `UID_MIN         ${this.uidMin}`,
      `UID_MAX         ${this.uidMax}`,
      `SYS_UID_MIN     ${this.sysUidMin}`,
      `SYS_UID_MAX     ${this.sysUidMax}`,
      '',
      `GID_MIN         ${this.gidMin}`,
      `GID_MAX         ${this.gidMax}`,
      `SYS_GID_MIN     ${this.sysGidMin}`,
      `SYS_GID_MAX     ${this.sysGidMax}`,
      '',
      `CREATE_HOME     ${this.createHome ? 'yes' : 'no'}`,
      `UMASK           ${this.umask}`,
      `USERGROUPS_ENAB ${this.usergroupsEnab ? 'yes' : 'no'}`,
      `ENCRYPT_METHOD  ${this.encryptMethod}`,
      '',
    ].join('\n');
  }
}
