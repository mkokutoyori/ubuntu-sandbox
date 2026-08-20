/**
 * AccountDatabaseParser — reading `/etc/passwd`, `/etc/shadow`, `/etc/group`
 * and `/etc/gshadow` BACK into live account objects.
 *
 * This is the inverse of `LinuxUserAccount.toPasswdLine()` and friends, and
 * it is what makes the account database genuinely file-backed rather than a
 * write-only projection. Without it, the in-memory maps were the sole source
 * of truth and the files were a rendering of them: `vim /etc/passwd`,
 * `sed -i`, `rm`, or restoring `/etc/passwd-` changed the text and nothing
 * else, so the machine kept behaving as if the edit had never happened.
 *
 * With it, the two directions agree:
 *   - a tool that mutates accounts (`useradd`, `passwd`, `usermod`) writes
 *     the files, exactly as before;
 *   - an operator who edits or deletes the files changes the accounts.
 *
 * Three details are worth knowing, because they are where a naive parser
 * would quietly lose information:
 *
 * 1. **Fields the files do not carry.** `lastLoginAt`, the faillock tally
 *    and `createdAt` are not in `/etc/passwd` or `/etc/shadow` on a real
 *    system either — they live in `/var/log/lastlog` and faillock's own
 *    tally directory. So they are carried over from the account of the same
 *    name rather than reset, which is what a real reload does too.
 *
 * 2. **The password.** `passwd` stores the secret as `$6$simulated$<clear>`,
 *    so the cleartext round-trips through the file. A secret that does NOT
 *    have that shape — a hash pasted in by hand, a `*`, a `!` — yields no
 *    usable cleartext, and the account simply cannot authenticate by
 *    password. That is the real consequence of hand-editing a hash, not a
 *    parser limitation.
 *
 * 3. **`shadow` is optional.** A user present in `/etc/passwd` with no
 *    `/etc/shadow` line still exists and still resolves; it just has no
 *    password entry. `pwck` reports exactly this as an inconsistency, so
 *    the parser must be able to represent it rather than drop the account.
 */

import { LinuxUserAccount } from '../LinuxUserAccount';
import { LinuxGroup } from '../LinuxGroup';

/** The password prefix `passwd` writes; the cleartext is recoverable from it. */
export const SIMULATED_HASH_PREFIX = '$6$simulated$';

/** Cleartext behind a stored secret, or null when it is not recoverable. */
export function cleartextOf(secret: string): string | null {
  const bare = secret.startsWith('!') ? secret.slice(1) : secret;
  return bare.startsWith(SIMULATED_HASH_PREFIX)
    ? bare.slice(SIMULATED_HASH_PREFIX.length)
    : null;
}

/** One parsed `/etc/shadow` record. */
interface ShadowRecord {
  secret: string;
  locked: boolean;
  lastChange: number;
  minDays: number;
  maxDays: number;
  warnDays: number;
  inactiveDays: number;
  expireDate: number;
}

function num(field: string | undefined, fallback: number): number {
  if (field === undefined || field.trim() === '') return fallback;
  const n = parseInt(field, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Split into records, dropping blank lines and `#` comments as libc does. */
function records(text: string): string[][] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => l.split(':'));
}

export function parseShadowFile(text: string): Map<string, ShadowRecord> {
  const out = new Map<string, ShadowRecord>();
  for (const f of records(text)) {
    if (f.length < 2) continue;
    const raw = f[1];
    // A leading `!` is the lock marker `usermod -L` / `passwd -l` adds; the
    // secret underneath is preserved so unlocking restores the old password.
    const locked = raw.startsWith('!');
    out.set(f[0], {
      secret: locked ? raw.slice(1) : raw,
      locked,
      lastChange: num(f[2], 0),
      minDays: num(f[3], 0),
      maxDays: num(f[4], 99999),
      warnDays: num(f[5], 7),
      inactiveDays: num(f[6], -1),
      expireDate: num(f[7], -1),
    });
  }
  return out;
}

export interface ParsedAccountDatabase {
  users: LinuxUserAccount[];
  groups: LinuxGroup[];
  /** Cleartext recovered per user, for the simulator's password store. */
  cleartext: Map<string, string>;
}

/**
 * Rebuild accounts and groups from the four files' text.
 *
 * `previous` supplies the accounts currently in memory so the fields the
 * files cannot carry survive the reload (see the header, point 1).
 */
export function parseAccountDatabase(
  text: { passwd: string; shadow: string; group: string; gshadow: string },
  previous: { users: readonly LinuxUserAccount[]; groups: readonly LinuxGroup[] },
): ParsedAccountDatabase {
  const priorUsers = new Map(previous.users.map((u) => [u.username, u]));
  const priorGroups = new Map(previous.groups.map((g) => [g.name, g]));
  const shadow = parseShadowFile(text.shadow);

  const users: LinuxUserAccount[] = [];
  const cleartext = new Map<string, string>();

  const seenUsers = new Set<string>();
  for (const f of records(text.passwd)) {
    if (f.length < 7) continue;
    const username = f[0];
    const uid = num(f[2], -1);
    const gid = num(f[3], -1);
    if (uid < 0 || gid < 0) continue;
    // libc walks the file top-down and stops at the FIRST match, so a
    // duplicated name is shadowed by the earlier line rather than
    // overriding it. `pwck` flags the duplicate; lookups ignore it.
    if (seenUsers.has(username)) continue;
    seenUsers.add(username);

    const sh = shadow.get(username);
    const prior = priorUsers.get(username);
    const account = new LinuxUserAccount({
      username,
      uid,
      gid,
      gecos: f[4],
      home: f[5],
      shell: f[6],
      // No shadow line at all: the account exists with no password entry,
      // which is a state `pwck` names rather than one that deletes the user.
      password: sh ? sh.secret : '!',
      locked: sh ? sh.locked : false,
      lastChange: sh ? sh.lastChange : 0,
      minDays: sh?.minDays,
      maxDays: sh?.maxDays,
      warnDays: sh?.warnDays,
      inactiveDays: sh?.inactiveDays,
      expireDate: sh?.expireDate,
      // Not in any file — preserved across the reload, like the real
      // lastlog/faillock stores that live outside /etc.
      systemAccount: prior?.systemAccount,
      nonUnique: prior?.nonUnique,
      createdAt: prior?.createdAt,
    });
    if (prior) {
      account.lastLoginAt = prior.lastLoginAt;
      account.failedLoginCount = prior.failedLoginCount;
      account.lastFailedLoginAt = prior.lastFailedLoginAt;
    }
    users.push(account);

    const clear = sh ? cleartextOf(sh.secret) : null;
    if (clear !== null) cleartext.set(username, clear);
  }

  // `/etc/gshadow` carries the administrator roster and the group password;
  // `/etc/group` carries the membership. Both are read, and gshadow only
  // fills in what group cannot express.
  const gshadow = new Map<string, { password: string; admins: string[] }>();
  for (const f of records(text.gshadow)) {
    if (f.length < 3) continue;
    gshadow.set(f[0], {
      password: f[1] === '!' ? '' : f[1],
      admins: f[2] ? f[2].split(',').filter(Boolean) : [],
    });
  }

  const groups: LinuxGroup[] = [];
  const seenGroups = new Set<string>();
  for (const f of records(text.group)) {
    if (f.length < 3) continue;
    const gid = num(f[2], -1);
    if (gid < 0) continue;
    if (seenGroups.has(f[0])) continue;
    seenGroups.add(f[0]);
    const gs = gshadow.get(f[0]);
    const prior = priorGroups.get(f[0]);
    groups.push(new LinuxGroup({
      name: f[0],
      gid,
      members: f[3] ? f[3].split(',').filter(Boolean) : [],
      admins: gs?.admins,
      password: gs?.password,
      systemGroup: prior?.systemGroup,
      userPrivateGroup: prior?.userPrivateGroup,
      createdAt: prior?.createdAt,
    }));
  }

  return { users, groups, cleartext };
}
