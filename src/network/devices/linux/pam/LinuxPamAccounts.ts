import type { LinuxUserManager } from '../LinuxUserManager';
import { PamOpasswd } from './PamOpasswd';
import type {
  PamAccountsPort,
  PamGroupRecord,
  PamUserRecord,
  PamWritableFiles,
} from './PamLinuxHost';

export class LinuxPamAccounts implements PamAccountsPort {
  private readonly opasswd: PamOpasswd;

  constructor(
    private readonly users: LinuxUserManager,
    readFile: (path: string) => string | null,
    files: PamWritableFiles,
  ) {
    this.opasswd = new PamOpasswd(readFile, files);
  }

  findUser(name: string): PamUserRecord | null {
    if (this.users.getUser(name) === undefined) return null;
    const account = this.users.getAccount(name);
    return account === undefined ? null : this.record(account);
  }

  findUserByUid(uid: number): PamUserRecord | null {
    const entry = this.users.getUserByUid(uid);
    return entry === undefined ? null : this.findUser(entry.username);
  }

  findGroup(name: string): PamGroupRecord | null {
    const group = this.users.getGroup(name);
    return group === undefined ? null : { name: group.name, gid: group.gid, members: [...group.members] };
  }

  findGroupByGid(gid: number): PamGroupRecord | null {
    const group = this.users.getGroupByGid(gid);
    return group === undefined ? null : { name: group.name, gid: group.gid, members: [...group.members] };
  }

  passwordMatches(name: string, password: string): boolean {
    return this.users.passwordMatches(name, password);
  }

  setPassword(name: string, password: string): void {
    this.users.setPassword(name, password);
  }

  rememberedPasswordUsed(name: string, password: string, depth: number): boolean {
    return this.opasswd.used(name, password, depth);
  }

  rememberPassword(name: string, oldPassword: string, depth: number): void {
    const account = this.users.getAccount(name);
    this.opasswd.remember(name, account?.uid ?? 0, oldPassword, depth);
  }

  groupNames(name: string): readonly string[] {
    return this.users.getUserGroups(name).map((group) => group.name);
  }

  private record(account: NonNullable<ReturnType<LinuxUserManager['getAccount']>>): PamUserRecord {
    const shadowAvailable = !this.users.isShadowDatabaseMissing();
    return {
      name: account.username,
      uid: account.uid,
      gid: account.gid,
      home: account.home,
      shell: account.shell,
      gecos: account.gecos,
      shadow: {
        hash: shadowAvailable ? (account.locked ? `!${account.password}` : account.password) : 'x',
        lastChange: account.lastChange,
        min: account.minDays,
        max: account.maxDays,
        warn: account.warnDays,
        inactive: account.inactiveDays,
        expire: account.expireDate,
      },
    };
  }
}
