import type { IEventBus } from '@/events/EventBus';
import { SshdServerConfig, type SshdEffectiveView } from './SshdServerConfig';
import { SshHostKeyset } from './SshHostKeyset';
import {
  SshConnectionRequest,
  SshConnectionDecision,
} from './SshConnectionRequest';
import type { IAccountAuthority, AccountSnapshot } from './IAccountAuthority';
import type { SshAuthMethod } from '../../../devices/router/aaa/NetworkOsAccount';

export type CrossVendorSshVendor = 'cisco' | 'huawei' | 'linux' | 'windows' | 'generic';

export interface CrossVendorSshHostOptions {
  deviceId: string;
  hostname: string;
  vendor: CrossVendorSshVendor;
  bus: IEventBus;
  authority: IAccountAuthority;
  config?: SshdServerConfig;
  keyset?: SshHostKeyset;
  banner?: string;
  motd?: string;
  active?: boolean;
  now?: () => number;
}

export interface SshLoginGateResult {
  ok: boolean;
  reason?: string;
}

export class CrossVendorSshHost {
  readonly deviceId: string;
  hostname: string;
  readonly vendor: CrossVendorSshVendor;
  banner: string;
  motd: string;
  config: SshdServerConfig;
  keyset: SshHostKeyset;

  private active: boolean;
  private readonly bus: IEventBus;
  private readonly authority: IAccountAuthority;
  private readonly now: () => number;
  private nextSessionSeq = 1;

  constructor(opts: CrossVendorSshHostOptions) {
    this.deviceId = opts.deviceId;
    this.hostname = opts.hostname;
    this.vendor = opts.vendor;
    this.bus = opts.bus;
    this.authority = opts.authority;
    this.now = opts.now ?? Date.now;
    this.config = opts.config ?? SshdServerConfig.defaults();
    this.keyset = opts.keyset ?? SshHostKeyset.defaults(`${opts.vendor}:${opts.deviceId}`);
    this.banner = opts.banner ?? '';
    this.motd = opts.motd ?? '';
    this.active = opts.active ?? true;
  }

  isSshActive(): boolean { return this.active; }
  setSshActive(v: boolean): void { this.active = v; }

  setHostname(name: string): void { this.hostname = name; }
  setBanner(text: string): void { this.banner = text; }
  setMotd(text: string): void { this.motd = text; }
  applyConfig(cfg: SshdServerConfig): void { this.config = cfg; }
  applyKeyset(ks: SshHostKeyset): void { this.keyset = ks; }

  getAuthority(): IAccountAuthority { return this.authority; }
  getEventBus(): IEventBus { return this.bus; }

  /** Light-weight lifecycle/policy gate without password validation. */
  acceptsLogin(user: string): SshLoginGateResult {
    if (!user) return { ok: false, reason: 'empty user' };
    if (this.authority.count() === 0) return { ok: true };
    const account = this.authority.lookup(user);
    if (!account) return { ok: false, reason: 'no such user' };
    const lifecycle = this.lifecycleGate(account);
    if (!lifecycle.ok) return lifecycle;
    if (!this.serviceTypeAllowed(account)) return { ok: false, reason: 'service-type ssh not permitted' };
    if (!this.config.isUserAllowed(user, [...account.groups])) {
      return { ok: false, reason: 'AllowUsers/DenyUsers denial' };
    }
    return { ok: true };
  }

  /** Full real-OpenSSH gate chain. Returns a SshConnectionDecision. */
  evaluate(request: SshConnectionRequest): SshConnectionDecision {
    const now = this.now();
    if (!this.active) return SshConnectionDecision.drop('sshd inactive', now);
    if (!this.config.ports.includes(request.requestedPort)) {
      return SshConnectionDecision.drop(`port ${request.requestedPort} not listening`, now);
    }

    const account = this.authority.count() === 0 ? null : (this.authority.lookup(request.requestedUser) ?? null);
    if (this.authority.count() > 0 && !account) {
      this.authority.recordLoginFailure(request.requestedUser, request.sourceIp, 'no such user', now);
      return SshConnectionDecision.reject('no such user', now);
    }

    if (account) {
      const lifecycle = this.lifecycleGate(account);
      if (!lifecycle.ok) {
        this.authority.recordLoginFailure(request.requestedUser, request.sourceIp, lifecycle.reason ?? 'denied', now);
        return SshConnectionDecision.reject(lifecycle.reason ?? 'denied', now);
      }
      if (!this.serviceTypeAllowed(account)) {
        this.authority.recordLoginFailure(request.requestedUser, request.sourceIp, 'service-type ssh not permitted', now);
        return SshConnectionDecision.reject('service-type ssh not permitted', now);
      }
    }

    const effective = this.config.effectiveFor({
      user: request.requestedUser,
      groups: account?.groups ?? [],
      address: request.sourceIp,
      localPort: request.requestedPort,
    });

    if (!this.config.isUserAllowed(request.requestedUser, [...(account?.groups ?? [])])) {
      this.authority.recordLoginFailure(request.requestedUser, request.sourceIp, 'AllowUsers/DenyUsers denial', now);
      return SshConnectionDecision.reject('user not allowed by sshd_config', now);
    }

    if (request.requestedUser === 'root' && effective.permitRootLogin === 'no') {
      this.authority.recordLoginFailure(request.requestedUser, request.sourceIp, 'PermitRootLogin no', now);
      return SshConnectionDecision.reject('PermitRootLogin no', now);
    }

    const method = this.negotiateAuth(request, account, effective);
    if (!method) {
      this.authority.recordLoginFailure(request.requestedUser, request.sourceIp, 'authentication failed', now);
      return SshConnectionDecision.reject('authentication failed', now);
    }

    this.authority.recordLoginSuccess(request.requestedUser, request.sourceIp, method, now);
    return SshConnectionDecision.accept(method, {
      sessionId: `ssh-${this.deviceId}-${this.nextSessionSeq++}`,
      at: now,
    });
  }

  private lifecycleGate(account: AccountSnapshot): SshLoginGateResult {
    if (account.disabled) return { ok: false, reason: 'account disabled' };
    if (account.locked) return { ok: false, reason: account.lockReason ?? 'account locked' };
    const now = this.now();
    if (account.expireAt !== null && account.expireAt > 0 && account.expireAt < now) {
      return { ok: false, reason: 'account expired' };
    }
    if (account.passwordExpireAt !== null && account.passwordExpireAt > 0 && account.passwordExpireAt < now) {
      return { ok: false, reason: 'password expired' };
    }
    return { ok: true };
  }

  private serviceTypeAllowed(account: AccountSnapshot): boolean {
    if (account.serviceTypes.length === 0) return true;
    const want = this.vendor === 'huawei' ? 'stelnet' : 'ssh';
    if (account.serviceTypes.includes(want)) return true;
    if (want === 'ssh' && account.serviceTypes.includes('stelnet')) return true;
    if (want === 'stelnet' && account.serviceTypes.includes('ssh')) return true;
    return false;
  }

  private negotiateAuth(
    req: SshConnectionRequest,
    account: AccountSnapshot | null,
    eff: SshdEffectiveView,
  ): SshAuthMethod | null {
    if (req.offeredAuthMethods.includes('publickey') && eff.pubkeyAuthentication) {
      const offered = req.credentials.publicKey;
      if (offered && account && account.publicKeys.includes(offered)) return 'publickey';
    }
    if (req.offeredAuthMethods.includes('password') && eff.passwordAuthentication) {
      const provided = req.credentials.password;
      if (provided !== undefined) {
        if (account && this.authority.authenticate(account.name, provided)) return 'password';
        if (provided === '' && eff.permitEmptyPasswords && account && account.secret === '') return 'password';
      } else if (account || this.authority.count() === 0) {
        return 'password';
      }
    }
    if (req.offeredAuthMethods.includes('keyboard-interactive') && eff.kbdInteractiveAuthentication) {
      return 'keyboard-interactive';
    }
    return null;
  }
}
