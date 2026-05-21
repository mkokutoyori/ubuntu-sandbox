/**
 * UseraddDefaults — model of `/etc/default/useradd`.
 *
 * The fallback values `useradd` applies when an option is omitted: the
 * default primary group, the parent of new home directories, the skeleton
 * directory, the login shell, password inactivity, account expiry, and
 * whether a mail spool is created.
 *
 * Like {@link LoginDefs} this is a read-back model — `LinuxUserManager`
 * consults `createMailSpool` to decide whether to materialise a mailbox.
 */

export interface UseraddDefaultsInit {
  group?: string;
  home?: string;
  inactiveDays?: number;
  expireDate?: string;
  shell?: string;
  skel?: string;
  createMailSpool?: boolean;
}

export class UseraddDefaults {
  /** `GROUP` — default primary group GID when not using user-private groups. */
  group: string;
  /** `HOME` — parent directory of new home directories. */
  home: string;
  /** `INACTIVE` — days after expiry before the account is disabled (-1 = off). */
  inactiveDays: number;
  /** `EXPIRE` — default account expiry date (empty = never). */
  expireDate: string;
  /** `SHELL` — default login shell. */
  shell: string;
  /** `SKEL` — skeleton directory copied into new home directories. */
  skel: string;
  /** `CREATE_MAIL_SPOOL` — create `/var/mail/<user>` on account creation. */
  createMailSpool: boolean;

  constructor(init: UseraddDefaultsInit = {}) {
    this.group = init.group ?? '100';
    this.home = init.home ?? '/home';
    this.inactiveDays = init.inactiveDays ?? -1;
    this.expireDate = init.expireDate ?? '';
    this.shell = init.shell ?? '/bin/sh';
    this.skel = init.skel ?? '/etc/skel';
    this.createMailSpool = init.createMailSpool ?? true;
  }

  static defaults(): UseraddDefaults {
    return new UseraddDefaults();
  }

  /** Render the canonical `/etc/default/useradd` file content. */
  render(): string {
    return [
      '# useradd defaults file',
      `GROUP=${this.group}`,
      `HOME=${this.home}`,
      `INACTIVE=${this.inactiveDays}`,
      `EXPIRE=${this.expireDate}`,
      `SHELL=${this.shell}`,
      `SKEL=${this.skel}`,
      `CREATE_MAIL_SPOOL=${this.createMailSpool ? 'yes' : 'no'}`,
      '',
    ].join('\n');
  }
}
