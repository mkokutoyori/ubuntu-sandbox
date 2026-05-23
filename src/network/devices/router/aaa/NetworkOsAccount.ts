import type { IEventBus } from '@/events/EventBus';

export type SshAuthMethod = 'password' | 'publickey' | 'keyboard-interactive';
export type PasswordHashAlgorithm =
  | 'plain' | 'md5' | 'sha256' | 'sha512' | 'cipher' | 'irreversible-cipher' | 'type-7';
export type AccountServiceType =
  | 'ssh' | 'stelnet' | 'telnet' | 'ftp' | 'http' | 'terminal' | 'web' | 'snmp' | 'ppp' | 'mail';

export interface NetworkOsAccountSnapshot {
  readonly name: string;
  readonly secret: string;
  readonly passwordHashAlgorithm: PasswordHashAlgorithm;
  readonly privilege: number;
  readonly serviceTypes: readonly AccountServiceType[];
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly disabled: boolean;
  readonly failedLoginCount: number;
  readonly lastLoginAt: number | null;
  readonly lastLoginFrom: string | null;
  readonly lastLoginMethod: SshAuthMethod | null;
  readonly lastFailedLoginAt: number | null;
  readonly lastFailedLoginFrom: string | null;
  readonly expireAt: number | null;
  readonly passwordExpireAt: number | null;
  readonly idleTimeoutSeconds: number;
  readonly maxConcurrentSessions: number;
  readonly accessClassIn: number | null;
  readonly accessClassOut: number | null;
  readonly ftpDirectory: string | null;
  readonly homeDirectory: string | null;
  readonly publicKeys: readonly string[];
  readonly description: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NetworkOsAccountInit {
  name: string;
  secret?: string;
  passwordHashAlgorithm?: PasswordHashAlgorithm;
  privilege?: number;
  serviceTypes?: AccountServiceType[];
  locked?: boolean;
  disabled?: boolean;
  expireAt?: number | null;
  passwordExpireAt?: number | null;
  idleTimeoutSeconds?: number;
  maxConcurrentSessions?: number;
  accessClassIn?: number | null;
  accessClassOut?: number | null;
  ftpDirectory?: string | null;
  homeDirectory?: string | null;
  description?: string | null;
  now?: number;
}

export class NetworkOsAccount {
  readonly name: string;
  readonly secret: string;
  readonly passwordHashAlgorithm: PasswordHashAlgorithm;
  readonly privilege: number;
  readonly serviceTypes: readonly AccountServiceType[];
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly disabled: boolean;
  readonly failedLoginCount: number;
  readonly lastLoginAt: number | null;
  readonly lastLoginFrom: string | null;
  readonly lastLoginMethod: SshAuthMethod | null;
  readonly lastFailedLoginAt: number | null;
  readonly lastFailedLoginFrom: string | null;
  readonly expireAt: number | null;
  readonly passwordExpireAt: number | null;
  readonly idleTimeoutSeconds: number;
  readonly maxConcurrentSessions: number;
  readonly accessClassIn: number | null;
  readonly accessClassOut: number | null;
  readonly ftpDirectory: string | null;
  readonly homeDirectory: string | null;
  readonly publicKeys: readonly string[];
  readonly description: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;

  private constructor(s: NetworkOsAccountSnapshot) {
    this.name = s.name;
    this.secret = s.secret;
    this.passwordHashAlgorithm = s.passwordHashAlgorithm;
    this.privilege = s.privilege;
    this.serviceTypes = s.serviceTypes;
    this.locked = s.locked;
    this.lockReason = s.lockReason;
    this.disabled = s.disabled;
    this.failedLoginCount = s.failedLoginCount;
    this.lastLoginAt = s.lastLoginAt;
    this.lastLoginFrom = s.lastLoginFrom;
    this.lastLoginMethod = s.lastLoginMethod;
    this.lastFailedLoginAt = s.lastFailedLoginAt;
    this.lastFailedLoginFrom = s.lastFailedLoginFrom;
    this.expireAt = s.expireAt;
    this.passwordExpireAt = s.passwordExpireAt;
    this.idleTimeoutSeconds = s.idleTimeoutSeconds;
    this.maxConcurrentSessions = s.maxConcurrentSessions;
    this.accessClassIn = s.accessClassIn;
    this.accessClassOut = s.accessClassOut;
    this.ftpDirectory = s.ftpDirectory;
    this.homeDirectory = s.homeDirectory;
    this.publicKeys = s.publicKeys;
    this.description = s.description;
    this.createdAt = s.createdAt;
    this.updatedAt = s.updatedAt;
  }

  static create(init: NetworkOsAccountInit): NetworkOsAccount {
    const now = init.now ?? Date.now();
    return new NetworkOsAccount({
      name: init.name,
      secret: init.secret ?? '',
      passwordHashAlgorithm: init.passwordHashAlgorithm ?? 'plain',
      privilege: init.privilege ?? 1,
      serviceTypes: Object.freeze([...(init.serviceTypes ?? [])]),
      locked: init.locked ?? false,
      lockReason: null,
      disabled: init.disabled ?? false,
      failedLoginCount: 0,
      lastLoginAt: null,
      lastLoginFrom: null,
      lastLoginMethod: null,
      lastFailedLoginAt: null,
      lastFailedLoginFrom: null,
      expireAt: init.expireAt ?? null,
      passwordExpireAt: init.passwordExpireAt ?? null,
      idleTimeoutSeconds: init.idleTimeoutSeconds ?? 0,
      maxConcurrentSessions: init.maxConcurrentSessions ?? 0,
      accessClassIn: init.accessClassIn ?? null,
      accessClassOut: init.accessClassOut ?? null,
      ftpDirectory: init.ftpDirectory ?? null,
      homeDirectory: init.homeDirectory ?? null,
      publicKeys: Object.freeze([]),
      description: init.description ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  snapshot(): NetworkOsAccountSnapshot {
    return {
      name: this.name, secret: this.secret, passwordHashAlgorithm: this.passwordHashAlgorithm,
      privilege: this.privilege, serviceTypes: this.serviceTypes, locked: this.locked,
      lockReason: this.lockReason, disabled: this.disabled, failedLoginCount: this.failedLoginCount,
      lastLoginAt: this.lastLoginAt, lastLoginFrom: this.lastLoginFrom,
      lastLoginMethod: this.lastLoginMethod, lastFailedLoginAt: this.lastFailedLoginAt,
      lastFailedLoginFrom: this.lastFailedLoginFrom, expireAt: this.expireAt,
      passwordExpireAt: this.passwordExpireAt, idleTimeoutSeconds: this.idleTimeoutSeconds,
      maxConcurrentSessions: this.maxConcurrentSessions, accessClassIn: this.accessClassIn,
      accessClassOut: this.accessClassOut, ftpDirectory: this.ftpDirectory,
      homeDirectory: this.homeDirectory, publicKeys: this.publicKeys,
      description: this.description, createdAt: this.createdAt, updatedAt: this.updatedAt,
    };
  }

  private mutate(patch: Partial<NetworkOsAccountSnapshot>, now?: number): NetworkOsAccount {
    return new NetworkOsAccount({
      ...this.snapshot(),
      ...patch,
      updatedAt: now ?? Date.now(),
    });
  }

  withSecret(secret: string, algo: PasswordHashAlgorithm = 'plain'): NetworkOsAccount {
    return this.mutate({ secret, passwordHashAlgorithm: algo });
  }

  withPrivilege(level: number): NetworkOsAccount {
    return this.mutate({ privilege: level });
  }

  withServiceTypes(types: AccountServiceType[]): NetworkOsAccount {
    return this.mutate({ serviceTypes: Object.freeze([...types]) });
  }

  withDescription(text: string): NetworkOsAccount {
    return this.mutate({ description: text });
  }

  withIdleTimeout(seconds: number): NetworkOsAccount {
    return this.mutate({ idleTimeoutSeconds: seconds });
  }

  withMaxSessions(count: number): NetworkOsAccount {
    return this.mutate({ maxConcurrentSessions: count });
  }

  withFtpDirectory(path: string): NetworkOsAccount {
    return this.mutate({ ftpDirectory: path });
  }

  withAccessClass(direction: 'in' | 'out', acl: number | null): NetworkOsAccount {
    return this.mutate(direction === 'in' ? { accessClassIn: acl } : { accessClassOut: acl });
  }

  withPublicKey(key: string): NetworkOsAccount {
    if (this.publicKeys.includes(key)) return this;
    return this.mutate({ publicKeys: Object.freeze([...this.publicKeys, key]) });
  }

  withoutPublicKey(key: string): NetworkOsAccount {
    return this.mutate({ publicKeys: Object.freeze(this.publicKeys.filter(k => k !== key)) });
  }

  withFailedLogin(at: number, from?: string): NetworkOsAccount {
    return this.mutate({
      failedLoginCount: this.failedLoginCount + 1,
      lastFailedLoginAt: at,
      lastFailedLoginFrom: from ?? this.lastFailedLoginFrom,
    }, at);
  }

  withSuccessfulLogin(at: number, from: string, method: SshAuthMethod): NetworkOsAccount {
    return this.mutate({
      failedLoginCount: 0,
      lastLoginAt: at,
      lastLoginFrom: from,
      lastLoginMethod: method,
    }, at);
  }

  lock(reason: string, now?: number): NetworkOsAccount {
    return this.mutate({ locked: true, lockReason: reason }, now);
  }

  unlock(now?: number): NetworkOsAccount {
    return this.mutate({ locked: false, lockReason: null }, now);
  }

  disable(now?: number): NetworkOsAccount {
    return this.mutate({ disabled: true }, now);
  }

  enable(now?: number): NetworkOsAccount {
    return this.mutate({ disabled: false }, now);
  }

  isPasswordExpired(now: number = Date.now()): boolean {
    if (this.passwordExpireAt !== null && this.passwordExpireAt > 0 && this.passwordExpireAt < now) return true;
    if (this.expireAt !== null && this.expireAt > 0 && this.expireAt < now) return true;
    return false;
  }

  isLoginPermitted(now: number = Date.now()): { ok: boolean; reason?: string } {
    if (this.disabled) return { ok: false, reason: 'account disabled' };
    if (this.locked) return { ok: false, reason: this.lockReason ?? 'account locked' };
    if (this.isPasswordExpired(now)) return { ok: false, reason: 'account expired' };
    return { ok: true };
  }
}

export interface NetworkOsAccountEventEnvelope {
  topic: 'router.aaa.account.created'
    | 'router.aaa.account.updated'
    | 'router.aaa.account.deleted'
    | 'router.aaa.account.locked'
    | 'router.aaa.account.unlocked'
    | 'router.aaa.account.login.success'
    | 'router.aaa.account.login.failure';
  payload: {
    deviceId: string;
    account: NetworkOsAccountSnapshot;
    from?: string;
    method?: SshAuthMethod;
    reason?: string;
    at: number;
  };
}

export function publishAccountEvent(
  bus: IEventBus,
  topic: NetworkOsAccountEventEnvelope['topic'],
  deviceId: string,
  account: NetworkOsAccount,
  extra: { from?: string; method?: SshAuthMethod; reason?: string; at?: number } = {},
): void {
  bus.publish({
    topic,
    payload: {
      deviceId,
      account: account.snapshot(),
      from: extra.from,
      method: extra.method,
      reason: extra.reason,
      at: extra.at ?? Date.now(),
    },
  });
}
