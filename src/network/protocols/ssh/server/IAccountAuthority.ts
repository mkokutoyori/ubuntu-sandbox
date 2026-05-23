import type { NetworkOsAccount, SshAuthMethod } from '../../../devices/router/aaa/NetworkOsAccount';

export interface AccountSnapshot {
  readonly name: string;
  readonly secret: string;
  readonly secretAlgorithm: 'plain' | 'md5' | 'sha256' | 'sha512' | 'cipher' | 'irreversible-cipher' | 'type-7';
  readonly privilege: number;
  readonly groups: readonly string[];
  readonly serviceTypes: readonly string[];
  readonly publicKeys: readonly string[];
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly lockReason: string | null;
  readonly expireAt: number | null;
  readonly passwordExpireAt: number | null;
}

export interface IAccountAuthority {
  count(): number;
  lookup(name: string): AccountSnapshot | undefined;
  authenticate(name: string, password: string): boolean;
  recordLoginSuccess(name: string, fromIp: string, method: SshAuthMethod, at?: number): void;
  recordLoginFailure(name: string, fromIp: string, reason: string, at?: number): void;
}

export function fromNetworkOsAccount(account: NetworkOsAccount): AccountSnapshot {
  return {
    name: account.name,
    secret: account.secret,
    secretAlgorithm: account.passwordHashAlgorithm === 'type-7' ? 'type-7' : account.passwordHashAlgorithm,
    privilege: account.privilege,
    groups: Object.freeze([]),
    serviceTypes: account.serviceTypes,
    publicKeys: account.publicKeys,
    locked: account.locked,
    disabled: account.disabled,
    lockReason: account.lockReason,
    expireAt: account.expireAt,
    passwordExpireAt: account.passwordExpireAt,
  };
}
