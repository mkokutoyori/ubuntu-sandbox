import type { NetworkOsAccount, SshAuthMethod } from '../../../devices/router/aaa/NetworkOsAccount';

export interface AccountSnapshot {
  readonly name: string;
  readonly secret: string;
  readonly privilege: number;
  readonly groups: readonly string[];
  readonly serviceTypes: readonly string[];
  readonly publicKeys: readonly string[];
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly lockReason: string | null;
  readonly expireAt: number | null;
  readonly passwordExpireAt: number | null;
  /**
   * La vue CLI attachee au compte (`username X view NOC`). Elle etait
   * portee par `NetworkOsAccount` et perdue en chemin ici, donc la
   * session ouverte pour ce compte ne pouvait pas y entrer : le lien
   * entre un compte et son role n'existait qu'a l'ecrit.
   */
  readonly view?: string | null;
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
    privilege: account.privilege,
    groups: Object.freeze([]),
    serviceTypes: account.serviceTypes,
    publicKeys: account.publicKeys,
    locked: account.locked,
    disabled: account.disabled,
    lockReason: account.lockReason,
    expireAt: account.expireAt,
    passwordExpireAt: account.passwordExpireAt,
    view: account.view,
  };
}
