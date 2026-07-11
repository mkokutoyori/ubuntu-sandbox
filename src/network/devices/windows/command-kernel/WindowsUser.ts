import { Capability, User } from '@/command-kernel/session/types';
import type { WindowsUserManager } from '../WindowsUserManager';

/**
 * Windows accounts are identified by SID strings, not POSIX uid/gid — this
 * derives a stable numeric id from a SID so `User.uid` / `GroupInfo.gid`
 * (required by the vendor-agnostic command-kernel contract) stay consistent
 * across calls without inventing a parallel identity store.
 */
export function numericIdFromSid(sid: string): number {
  let hash = 0;
  for (let i = 0; i < sid.length; i++) {
    hash = (hash * 31 + sid.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export class WindowsUser implements User {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
  readonly groups: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<Capability> = new Set();

  constructor(account: { name: string; sid: string }, isAdmin: boolean, groupNames: readonly string[]) {
    this.uid = isAdmin ? 0 : numericIdFromSid(account.sid);
    this.gid = numericIdFromSid(account.sid);
    this.name = account.name;
    this.groups = new Set(groupNames);
  }

  isRoot(): boolean {
    return this.uid === 0;
  }
}

export function resolveWindowsUser(userManager: WindowsUserManager, username: string): WindowsUser {
  const account = userManager.getUser(username);
  if (!account) {
    throw new Error(`compte Windows introuvable : ${username}`);
  }
  const groups = userManager.getGroupsForUser(username).map((g) => g.name);
  return new WindowsUser(account, userManager.isAdmin(username), groups);
}
