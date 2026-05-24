import type { IAccountAuthority, AccountSnapshot } from '../../../protocols/ssh/server/IAccountAuthority';
import type { SshAuthMethod } from '../../router/aaa/NetworkOsAccount';

interface UserEntryLike {
  name?: string;
  username?: string;
  uid?: number;
  gid?: number;
  home?: string;
  shell?: string;
  password?: string;
  locked?: boolean;
  expireDate?: number;
  groups?: string[];
  publicKeys?: string[];
  serviceTypes?: string[];
}

interface UserManagerLike {
  listUsers?(): ReadonlyArray<{ name?: string; username?: string }>;
  getUser(name: string): UserEntryLike | undefined;
}

interface VfsLike {
  readFile(path: string): string | null;
  writeFile?(path: string, content: string, uid: number, gid: number, umask: number): void;
}

interface ExecutorLike {
  userMgr: UserManagerLike;
  vfs: VfsLike;
}

export interface LinuxUserManagerAuthorityOptions {
  executor: ExecutorLike;
  deviceId: string;
  hostname: string;
  recordSshLogin?: (
    user: string,
    fromIp: string,
    fromHost: string,
    accepted: boolean,
    method?: SshAuthMethod,
  ) => void;
  now?: () => number;
}

export class LinuxUserManagerAuthority implements IAccountAuthority {
  private readonly opts: LinuxUserManagerAuthorityOptions;

  constructor(opts: LinuxUserManagerAuthorityOptions) {
    this.opts = opts;
  }

  count(): number {
    const list = this.opts.executor.userMgr.listUsers?.();
    if (list) return list.length;
    return 1;
  }

  lookup(name: string): AccountSnapshot | undefined {
    const u = this.opts.executor.userMgr.getUser(name);
    if (!u) return undefined;

    const shadow = this.opts.executor.vfs.readFile('/etc/shadow') ?? '';
    const shadowLine = shadow.split('\n').find(l => l.startsWith(`${name}:`));
    const shadowPwd = shadowLine?.split(':')[1] ?? '';
    const shadowExpireDays = shadowLine
      ? Number.parseInt(shadowLine.split(':')[7] ?? '', 10)
      : NaN;

    const locked = (u.locked ?? false) || /^!/.test(shadowPwd);
    const disabled = u.password === '!';
    const userMgrExpireMs = u.expireDate !== undefined && u.expireDate > 0
      ? u.expireDate * 86_400_000
      : null;
    const shadowExpireMs = Number.isFinite(shadowExpireDays) && shadowExpireDays > 0
      ? shadowExpireDays * 86_400_000
      : null;
    const expireAt = userMgrExpireMs !== null && shadowExpireMs !== null
      ? Math.min(userMgrExpireMs, shadowExpireMs)
      : userMgrExpireMs ?? shadowExpireMs;

    const accountName = u.name ?? u.username ?? name;
    return {
      name: accountName,
      secret: u.password ?? '',
      secretAlgorithm: 'plain',
      privilege: 0,
      groups: Object.freeze([...(u.groups ?? [])]),
      serviceTypes: Object.freeze([...(u.serviceTypes ?? [])]),
      publicKeys: Object.freeze([...(u.publicKeys ?? [])]),
      locked,
      disabled,
      lockReason: locked ? 'account locked' : null,
      expireAt,
      passwordExpireAt: null,
    };
  }

  authenticate(name: string, password: string): boolean {
    const u = this.opts.executor.userMgr.getUser(name);
    if (!u) return false;
    if (u.password === undefined) return true;
    if (u.password === '!' || u.password === '') return password === u.password;
    return u.password === password;
  }

  recordLoginSuccess(name: string, fromIp: string, method: SshAuthMethod): void {
    this.opts.recordSshLogin?.(name, fromIp, this.opts.hostname, true, method);
  }

  recordLoginFailure(name: string, fromIp: string): void {
    this.opts.recordSshLogin?.(name, fromIp, this.opts.hostname, false);
  }
}
