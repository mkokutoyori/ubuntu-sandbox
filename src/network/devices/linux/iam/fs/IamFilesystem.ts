/**
 * IamFilesystem — keeps the on-disk view of the IAM state coherent.
 *
 * `LinuxUserManager` owns the in-memory accounts and groups; this class owns
 * their *materialisation* onto the filesystem. Separating the two honours the
 * Single Responsibility Principle — the manager reasons about identities, the
 * projector reasons about files.
 *
 * It is responsible for:
 *   - the account database — `/etc/passwd`, `/etc/shadow`, `/etc/group`,
 *     `/etc/gshadow`, plus the `/etc/subuid` & `/etc/subgid` subordinate maps
 *   - the `-` backup files real `useradd`/`passwd` leave behind
 *   - the policy / defaults configuration — `/etc/login.defs`,
 *     `/etc/default/useradd`, `/etc/adduser.conf`
 *   - the skeleton directory `/etc/skel`
 *   - per-user mail spools under `/var/mail`
 */

import type { VirtualFileSystem } from '../../VirtualFileSystem';
import type { LinuxUserAccount } from '../LinuxUserAccount';
import type { LinuxGroup } from '../LinuxGroup';
import type { LoginDefs } from './LoginDefs';
import type { UseraddDefaults } from './UseraddDefaults';
import { IAM_PATHS, ACCOUNT_DB_BACKUPS } from './IamPaths';

// ─── Skeleton templates (seeded into /etc/skel) ─────────────────────────

/** Files copied into a new home directory — the contents of `/etc/skel`. */
export const SKEL_FILES: ReadonlyArray<{ name: string; content: string }> = [
  {
    name: '.bash_logout',
    content:
      '# ~/.bash_logout: executed by bash(1) when login shell exits.\n\n' +
      '# when leaving the console clear the screen to increase privacy\n\n' +
      'if [ "$SHLVL" = 1 ]; then\n    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q\nfi\n',
  },
  {
    name: '.bashrc',
    content:
      '# ~/.bashrc: executed by bash(1) for non-login shells.\n\n' +
      "# If not running interactively, don't do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n" +
      "# don't put duplicate lines or lines starting with space in the history.\nHISTCONTROL=ignoreboth\n\n" +
      'HISTSIZE=1000\nHISTFILESIZE=2000\n',
  },
  {
    name: '.profile',
    content:
      '# ~/.profile: executed by the command interpreter for login shells.\n\n' +
      '# if running bash\nif [ -n "$BASH_VERSION" ]; then\n    # include .bashrc if it exists\n' +
      '    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n\n' +
      "# set PATH so it includes user's private bin if it exists\nif [ -d \"$HOME/bin\" ] ; then\n" +
      '    PATH="$HOME/bin:$PATH"\nfi\n',
  },
];

/** Canonical `/etc/adduser.conf` — the policy for the Debian `adduser` wrapper. */
const ADDUSER_CONF = [
  '# /etc/adduser.conf: `adduser` configuration.',
  'DSHELL=/bin/bash',
  'DHOME=/home',
  'GROUPHOMES=no',
  'LETTERHOMES=no',
  'SKEL=/etc/skel',
  'FIRST_SYSTEM_UID=100',
  'LAST_SYSTEM_UID=999',
  'FIRST_SYSTEM_GID=100',
  'LAST_SYSTEM_GID=999',
  'FIRST_UID=1000',
  'LAST_UID=59999',
  'FIRST_GID=1000',
  'LAST_GID=59999',
  'USERGROUPS=yes',
  'USERS_GID=100',
  'DIR_MODE=0755',
  'SETGID_HOME=no',
  'QUOTAUSER=""',
  'SKEL_IGNORE_REGEX="dpkg-(old|new|dist|save)"',
  '',
].join('\n');

/** Subordinate ID block size — `useradd` grants 65536 ids per regular user. */
const SUBORDINATE_BLOCK_SIZE = 65536;
const SUBORDINATE_BASE = 100000;

export class IamFilesystem {
  constructor(private readonly vfs: VirtualFileSystem) {}

  // ─── One-time seeding ──────────────────────────────────────────────────

  /**
   * Seed the policy / defaults configuration and the skeleton directory.
   * Idempotent: existing files are never clobbered, so operator edits and
   * later boots are preserved.
   */
  seedConfiguration(loginDefs: LoginDefs, useraddDefaults: UseraddDefaults): void {
    this.vfs.mkdirp(IAM_PATHS.defaultDir, 0o755, 0, 0);
    this.vfs.mkdirp(IAM_PATHS.skel, 0o755, 0, 0);
    this.vfs.mkdirp(IAM_PATHS.mailSpoolDir, 0o755, 0, 0);

    this.writeIfAbsent(IAM_PATHS.loginDefs, loginDefs.render(), 0o644);
    this.writeIfAbsent(IAM_PATHS.useraddDefaults, useraddDefaults.render(), 0o644);
    this.writeIfAbsent(IAM_PATHS.adduserConf, ADDUSER_CONF, 0o644);

    for (const file of SKEL_FILES) {
      this.writeIfAbsent(`${IAM_PATHS.skel}/${file.name}`, file.content, 0o644);
    }
  }

  // ─── Account database projection ───────────────────────────────────────

  /**
   * Rewrite the full account database from the in-memory state. Each live
   * file's previous content is first copied to its `-` backup, mirroring
   * what real `useradd` / `passwd` do.
   */
  writeAccountDatabase(users: LinuxUserAccount[], groups: LinuxGroup[]): void {
    const rendered: Record<string, string> = {
      [IAM_PATHS.passwd]: joinLines(users.map((u) => u.toPasswdLine())),
      [IAM_PATHS.shadow]: joinLines(users.map((u) => u.toShadowLine())),
      [IAM_PATHS.group]: joinLines(groups.map((g) => g.toGroupLine())),
      [IAM_PATHS.gshadow]: joinLines(groups.map((g) => g.toGshadowLine())),
    };

    for (const [live, backup] of ACCOUNT_DB_BACKUPS) {
      const previous = this.vfs.readFile(live);
      if (previous !== null) {
        this.vfs.writeFile(backup, previous, 0, 0, 0o022);
      }
      this.vfs.writeFile(live, rendered[live], 0, 0, 0o022);
    }

    this.writeSubordinateIds(users);
  }

  /**
   * Materialise `/etc/subuid` & `/etc/subgid` — the subordinate UID/GID
   * ranges delegated to each regular user for unprivileged containers.
   */
  private writeSubordinateIds(users: LinuxUserAccount[]): void {
    const regular = users
      .filter((u) => !u.systemAccount && u.uid > 0 && u.uid < 65534)
      .sort((a, b) => a.uid - b.uid);

    const lines = regular.map((u, index) => {
      const start = SUBORDINATE_BASE + index * SUBORDINATE_BLOCK_SIZE;
      return `${u.username}:${start}:${SUBORDINATE_BLOCK_SIZE}`;
    });
    const content = joinLines(lines);

    this.vfs.writeFile(IAM_PATHS.subuid, content, 0, 0, 0o022);
    this.vfs.writeFile(IAM_PATHS.subgid, content, 0, 0, 0o022);
  }

  // ─── Mail spool ────────────────────────────────────────────────────────

  /** Create an empty mailbox `/var/mail/<user>` (does nothing if it exists). */
  createMailSpool(username: string, uid: number, gid: number): void {
    const path = `${IAM_PATHS.mailSpoolDir}/${username}`;
    if (this.vfs.readFile(path) === null) {
      this.vfs.createFileAt(path, '', 0o660, uid, gid);
    }
  }

  /** Remove a user's mailbox (called by `userdel`). */
  removeMailSpool(username: string): void {
    this.vfs.rmrf(`${IAM_PATHS.mailSpoolDir}/${username}`);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private writeIfAbsent(path: string, content: string, mode: number): void {
    if (!this.vfs.exists(path)) {
      this.vfs.createFileAt(path, content, mode, 0, 0);
    }
  }
}

/** Join file lines, always terminating with a newline (empty file → ''). */
function joinLines(lines: string[]): string {
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
