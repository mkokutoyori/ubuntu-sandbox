import type { IAccountAuthority, AccountSnapshot } from '../../../protocols/ssh/server/IAccountAuthority';
import type { SshAuthMethod } from '../../router/aaa/NetworkOsAccount';

interface WindowsUserLike {
  name: string;
  enabled?: boolean;
  passwordRequired?: boolean;
  publicKeys?: string[];
  lockedOut?: boolean;
  accountExpires?: number | null;
  passwordExpired?: boolean;
}

interface WindowsGroupLike {
  name: string;
  members: string[];
}

interface WindowsUserManagerLike {
  getUser(name: string): WindowsUserLike | undefined;
  getAllUsers?(): readonly WindowsUserLike[];
  getGroupsForUser?(name: string): readonly WindowsGroupLike[];
  checkPassword?(name: string, password: string): boolean;
}

export interface WindowsUserManagerAuthorityOptions {
  userMgr: WindowsUserManagerLike;
  deviceId: string;
  hostname: string;
  recordSshLogin?: (
    user: string, fromIp: string, fromHost: string, accepted: boolean, method?: SshAuthMethod,
  ) => void;
}

export class WindowsUserManagerAuthority implements IAccountAuthority {
  private readonly opts: WindowsUserManagerAuthorityOptions;

  constructor(opts: WindowsUserManagerAuthorityOptions) {
    this.opts = opts;
  }

  count(): number {
    const list = this.opts.userMgr.getAllUsers?.();
    return list ? list.length : 0;
  }

  lookup(name: string): AccountSnapshot | undefined {
    const u = this.opts.userMgr.getUser(name);
    if (!u) return undefined;
    const groups = this.opts.userMgr.getGroupsForUser?.(u.name)?.map(g => g.name) ?? [];
    return {
      name: u.name,
      secret: '',
      secretAlgorithm: 'plain',
      privilege: 0,
      groups: Object.freeze([...groups]),
      serviceTypes: Object.freeze([]),
      publicKeys: Object.freeze([...(u.publicKeys ?? [])]),
      locked: u.lockedOut ?? false,
      disabled: u.enabled === false,
      lockReason: u.lockedOut ? 'account locked' : null,
      expireAt: u.accountExpires ?? null,
      passwordExpireAt: u.passwordExpired ? 1 : null,
    };
  }

  authenticate(name: string, password: string): boolean {
    const u = this.opts.userMgr.getUser(name);
    if (!u) return false;
    if (u.passwordRequired === false) return true;
    return this.opts.userMgr.checkPassword?.(name, password) ?? false;
  }

  recordLoginSuccess(name: string, fromIp: string, method: SshAuthMethod): void {
    this.opts.recordSshLogin?.(name, fromIp, this.opts.hostname, true, method);
  }
  recordLoginFailure(name: string, fromIp: string): void {
    this.opts.recordSshLogin?.(name, fromIp, this.opts.hostname, false);
  }
}
