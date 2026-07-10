import { Capability, User } from '@/command-kernel/session/types';
import type { LinuxUserAccount } from '../iam/LinuxUserAccount';
import type { LinuxUserManager } from '../LinuxUserManager';

const SUDO_GROUPS = new Set(['sudo', 'wheel', 'admin']);

function capabilitiesFor(groupNames: ReadonlySet<string>): ReadonlySet<Capability> {
  if (![...groupNames].some((g) => SUDO_GROUPS.has(g))) return new Set();
  return new Set([
    Capability.FS_CHOWN,
    Capability.PROC_KILL,
    Capability.PROC_SPAWN,
    Capability.NET_ADMIN,
    Capability.USER_MANAGE,
    Capability.SYS_SHUTDOWN,
  ]);
}

export class LinuxUser implements User {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
  readonly groups: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<Capability>;
  readonly supplementaryGids: readonly number[];

  constructor(account: LinuxUserAccount, userManager: LinuxUserManager) {
    this.uid = account.uid;
    this.gid = account.gid;
    this.name = account.username;
    const groupEntries = userManager.getUserGroups(account.username);
    this.groups = new Set(groupEntries.map((g) => g.name));
    this.supplementaryGids = groupEntries.map((g) => g.gid);
    this.capabilities = capabilitiesFor(this.groups);
  }

  isRoot(): boolean {
    return this.uid === 0;
  }
}

export function resolveLinuxUser(userManager: LinuxUserManager, username: string): LinuxUser {
  const account = userManager.getAccount(username);
  if (!account) {
    throw new Error(`compte Linux introuvable : ${username}`);
  }
  return new LinuxUser(account, userManager);
}
