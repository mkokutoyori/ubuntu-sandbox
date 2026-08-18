import type { IEventBus } from '@/events/EventBus';
import {
  huaweiIrreversibleCipher, huaweiDecipher,
  looksLikeIrreversibleCipher, looksLikeReversibleCipher,
} from '@/crypto/passwords/huawei';
import { ciscoPasswordMatches } from '../../shells/cisco/ciscoPasswordVerify';

export type SshAuthMethod = 'password' | 'publickey' | 'keyboard-interactive';
export type PasswordHashAlgorithm =
  | 'plain' | 'plain-password' | 'md5' | 'sha256' | 'scrypt' | 'sha512' | 'cipher' | 'irreversible-cipher' | 'type-7';
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
  /** Previous secrets, most-recent-first — checked against a history policy (Huawei `password-policy history-record`). */
  readonly passwordHistory: readonly string[];
  readonly idleTimeoutSeconds: number;
  readonly maxConcurrentSessions: number;
  readonly accessClassIn: number | null;
  readonly accessClassOut: number | null;
  readonly ftpDirectory: string | null;
  readonly homeDirectory: string | null;
  readonly publicKeys: readonly string[];
  readonly description: string | null;
  readonly noPassword: boolean;
  readonly oneTime: boolean;
  readonly autocommand: string | null;
  readonly noHangup: boolean;
  /**
   * La vue CLI attachee au compte (`username X view NOC_VIEW`).
   *
   * Elle vit sur le COMPTE et non a cote, parce que c'est le compte qui
   * porte le role : un lien range ailleurs se perdrait a la relecture,
   * ce qui est exactement le defaut que le mecanisme referme.
   */
  readonly view: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly factoryDefault: boolean;
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
  factoryDefault?: boolean;
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
  readonly passwordHistory: readonly string[];
  readonly idleTimeoutSeconds: number;
  readonly maxConcurrentSessions: number;
  readonly accessClassIn: number | null;
  readonly accessClassOut: number | null;
  readonly ftpDirectory: string | null;
  readonly homeDirectory: string | null;
  readonly publicKeys: readonly string[];
  readonly description: string | null;
  readonly noPassword: boolean;
  readonly oneTime: boolean;
  readonly autocommand: string | null;
  readonly noHangup: boolean;
  readonly view: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly factoryDefault: boolean;

  private constructor(s: NetworkOsAccountSnapshot) {
    this.name = s.name;
    this.view = s.view;
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
    this.passwordHistory = s.passwordHistory;
    this.idleTimeoutSeconds = s.idleTimeoutSeconds;
    this.maxConcurrentSessions = s.maxConcurrentSessions;
    this.accessClassIn = s.accessClassIn;
    this.accessClassOut = s.accessClassOut;
    this.ftpDirectory = s.ftpDirectory;
    this.homeDirectory = s.homeDirectory;
    this.publicKeys = s.publicKeys;
    this.description = s.description;
    this.noPassword = s.noPassword;
    this.oneTime = s.oneTime;
    this.autocommand = s.autocommand;
    this.noHangup = s.noHangup;
    this.createdAt = s.createdAt;
    this.updatedAt = s.updatedAt;
    this.factoryDefault = s.factoryDefault;
  }

  static create(init: NetworkOsAccountInit): NetworkOsAccount {
    const now = init.now ?? Date.now();
    return new NetworkOsAccount({
      name: init.name,
      view: null,
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
      passwordHistory: Object.freeze([]),
      idleTimeoutSeconds: init.idleTimeoutSeconds ?? 0,
      maxConcurrentSessions: init.maxConcurrentSessions ?? 0,
      accessClassIn: init.accessClassIn ?? null,
      accessClassOut: init.accessClassOut ?? null,
      ftpDirectory: init.ftpDirectory ?? null,
      homeDirectory: init.homeDirectory ?? null,
      publicKeys: Object.freeze([]),
      description: init.description ?? null,
      noPassword: false,
      oneTime: false,
      autocommand: null,
      noHangup: false,
      createdAt: now,
      updatedAt: now,
      factoryDefault: init.factoryDefault ?? false,
    });
  }

  asFactoryDefault(): NetworkOsAccount {
    return this.mutate({ factoryDefault: true });
  }

  asOperatorOwned(): NetworkOsAccount {
    return this.mutate({ factoryDefault: false });
  }

  snapshot(): NetworkOsAccountSnapshot {
    return {
      name: this.name, secret: this.secret, passwordHashAlgorithm: this.passwordHashAlgorithm,
      privilege: this.privilege, serviceTypes: this.serviceTypes, locked: this.locked,
      lockReason: this.lockReason, disabled: this.disabled, failedLoginCount: this.failedLoginCount,
      lastLoginAt: this.lastLoginAt, lastLoginFrom: this.lastLoginFrom,
      lastLoginMethod: this.lastLoginMethod, lastFailedLoginAt: this.lastFailedLoginAt,
      lastFailedLoginFrom: this.lastFailedLoginFrom, expireAt: this.expireAt,
      passwordExpireAt: this.passwordExpireAt, passwordHistory: this.passwordHistory,
      idleTimeoutSeconds: this.idleTimeoutSeconds,
      maxConcurrentSessions: this.maxConcurrentSessions, accessClassIn: this.accessClassIn,
      accessClassOut: this.accessClassOut, ftpDirectory: this.ftpDirectory,
      homeDirectory: this.homeDirectory, publicKeys: this.publicKeys,
      description: this.description, view: this.view,
      noPassword: this.noPassword, oneTime: this.oneTime,
      autocommand: this.autocommand, noHangup: this.noHangup,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
      factoryDefault: this.factoryDefault,
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
    return this.mutate({ secret, passwordHashAlgorithm: algo, noPassword: false });
  }

  withoutPassword(): NetworkOsAccount {
    return this.mutate({ noPassword: true, secret: '', passwordHashAlgorithm: 'plain' });
  }

  withOneTime(oneTime: boolean): NetworkOsAccount {
    return this.mutate({ oneTime });
  }

  withAutocommand(line: string | null, noHangup: boolean): NetworkOsAccount {
    return this.mutate({ autocommand: line, noHangup });
  }

  withPasswordExpireAt(at: number | null): NetworkOsAccount {
    return this.mutate({ passwordExpireAt: at });
  }

  /** True when `secret` matches the current password or one still retained in history (Huawei `password-policy history-record`). */
  wouldReuseSecret(secret: string, maxHistory: number): boolean {
    if (maxHistory <= 0) return false;
    if (this.secret !== '' && this.secret === secret) return true;
    return this.passwordHistory.slice(0, maxHistory).includes(secret);
  }

  /** Like withSecret(), but pushes the outgoing secret onto the history list (bounded to maxHistory). */
  withSecretRetainingHistory(secret: string, algo: PasswordHashAlgorithm, maxHistory: number): NetworkOsAccount {
    const history = maxHistory > 0
      ? Object.freeze([this.secret, ...this.passwordHistory].filter(s => s !== '').slice(0, maxHistory))
      : this.passwordHistory;
    return this.mutate({ secret, passwordHashAlgorithm: algo, passwordHistory: history });
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

  withView(view: string | null): NetworkOsAccount {
    return this.mutate({ view });
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

  /**
   * Le secret range est sous la forme que la configuration rend : une
   * empreinte pour `irreversible-cipher`, un chiffre pour `cipher`. La
   * comparaison doit donc passer par l'algorithme, sinon un compte
   * recharge depuis une configuration n'ouvre plus — la configuration ne
   * porte pas le clair, et c'est bien son role.
   */
  authenticate(password: string): boolean {
    // Un compte VERROUILLE n'authentifie plus, et un compte desactive non
    // plus. Les deux drapeaux existaient, etaient poses au bon moment par
    // `aaa local authentication attempts max-fail`, rendus par `show aaa
    // local user lockout` — et consultes par PERSONNE : apres trois
    // echecs le compte etait marque verrouille et le bon mot de passe
    // continuait de l'ouvrir. Le mecanisme entier ne protegeait rien, et
    // la vue affirmait le contraire.
    if (this.locked || this.disabled) return false;
    if (this.noPassword) return true;
    if (!this.secret) return false;
    if (this.passwordHashAlgorithm === 'irreversible-cipher') {
      return looksLikeIrreversibleCipher(this.secret)
        ? huaweiIrreversibleCipher(password) === this.secret
        : this.secret === password;
    }
    if (this.passwordHashAlgorithm === 'cipher') {
      return looksLikeReversibleCipher(this.secret)
        ? huaweiDecipher(this.secret) === password
        : this.secret === password;
    }
    // Cote Cisco, le meme raisonnement — la configuration ne porte pas le
    // clair — n'etait applique NULLE PART : `username X secret <mot>` est
    // rendu `username X secret 5 $1$...`, donc l'import d'une topologie
    // rangeait le condense et le compte ne se connectait plus jamais ;
    // et `service password-encryption` cassait `username X password`
    // sur-le-champ, sans meme attendre un rechargement. Mesure :
    // `authenticate('admin','Admin@2025')` vrai avant sauvegarde, faux
    // apres. `ciscoPasswordMatches` retombe sur l'egalite pour une valeur
    // en clair, donc le cas ordinaire ne change pas.
    return ciscoPasswordMatches(password, this.secret, this.passwordHashAlgorithm);
  }

  allowsService(service: AccountServiceType): boolean {
    if (this.serviceTypes.length === 0) return true;
    if (service === 'ssh' && this.serviceTypes.includes('stelnet')) return true;
    if (service === 'stelnet' && this.serviceTypes.includes('ssh')) return true;
    return this.serviceTypes.includes(service);
  }
}

export interface CiscoUsernamePatch {
  privilege?: number;
  secret?: string;
  secretAlgo?: PasswordHashAlgorithm;
  nopassword?: boolean;
  description?: string;
  view?: string;
  autocommand?: string;
  nohangup?: boolean;
  oneTime?: boolean;
  accessClass?: number;
  maxLinks?: number;
}

export function applyCiscoUsernamePatch(
  base: NetworkOsAccount, kv: CiscoUsernamePatch,
): NetworkOsAccount {
  let account = base;
  if (kv.privilege !== undefined) account = account.withPrivilege(kv.privilege);
  if (kv.nopassword) account = account.withoutPassword();
  else if (kv.secret !== undefined) account = account.withSecret(kv.secret, kv.secretAlgo ?? 'plain');
  if (kv.description) account = account.withDescription(kv.description);
  if (kv.view !== undefined) account = account.withView(kv.view);
  if (kv.autocommand !== undefined || kv.nohangup) {
    account = account.withAutocommand(kv.autocommand ?? account.autocommand, kv.nohangup ?? account.noHangup);
  }
  if (kv.oneTime) account = account.withOneTime(true);
  if (kv.accessClass !== undefined) account = account.withAccessClass('in', kv.accessClass);
  if (kv.maxLinks !== undefined) account = account.withMaxSessions(kv.maxLinks);
  if (account.factoryDefault) account = account.asOperatorOwned();
  return account;
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
