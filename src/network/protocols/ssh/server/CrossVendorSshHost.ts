import type { IEventBus } from '@/events/EventBus';
import { SshdServerConfig, type SshdEffectiveView } from './SshdServerConfig';
import { SshHostKeyset } from './SshHostKeyset';
import {
  SshConnectionRequest,
  SshConnectionDecision,
} from './SshConnectionRequest';
import type { NetworkOsCredentialStore } from '../../../devices/router/aaa/NetworkOsCredentialStore';
import type { NetworkOsAccount, SshAuthMethod } from '../../../devices/router/aaa/NetworkOsAccount';

export type CrossVendorSshVendor = 'cisco' | 'huawei' | 'linux' | 'windows' | 'generic';

export interface CrossVendorSshHostOptions {
  deviceId: string;
  hostname: string;
  vendor: CrossVendorSshVendor;
  bus: IEventBus;
  credentials: NetworkOsCredentialStore;
  config?: SshdServerConfig;
  keyset?: SshHostKeyset;
  banner?: string;
  motd?: string;
  active?: boolean;
  now?: () => number;
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
  private readonly credentials: NetworkOsCredentialStore;
  private readonly now: () => number;
  private nextSessionSeq = 1;

  constructor(opts: CrossVendorSshHostOptions) {
    this.deviceId = opts.deviceId;
    this.hostname = opts.hostname;
    this.vendor = opts.vendor;
    this.bus = opts.bus;
    this.credentials = opts.credentials;
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

  getCredentials(): NetworkOsCredentialStore { return this.credentials; }
  getEventBus(): IEventBus { return this.bus; }

  decide(req: SshConnectionRequest): SshConnectionDecision {
    if (!this.active) return SshConnectionDecision.drop('sshd inactive', this.now());
    if (!this.config.ports.includes(req.requestedPort)) {
      return SshConnectionDecision.drop(`port ${req.requestedPort} not listening`, this.now());
    }
    const effective = this.config.effectiveFor({ user: req.requestedUser, address: req.sourceIp });

    const account = this.credentials.size() === 0
      ? null
      : this.credentials.get(req.requestedUser);
    if (this.credentials.size() > 0 && !account) {
      this.credentials.recordLoginFailure(req.requestedUser, req.sourceIp, 'no such user', this.now());
      return SshConnectionDecision.reject('no such user', this.now());
    }

    if (account) {
      const lifecycle = account.isLoginPermitted(this.now());
      if (!lifecycle.ok) {
        this.credentials.recordLoginFailure(req.requestedUser, req.sourceIp, lifecycle.reason ?? 'denied', this.now());
        return SshConnectionDecision.reject(lifecycle.reason ?? 'denied', this.now());
      }
      const serviceOk = this.vendor === 'cisco' || this.vendor === 'huawei'
        ? account.allowsService(this.vendor === 'huawei' ? 'stelnet' : 'ssh')
        : account.allowsService('ssh');
      if (!serviceOk) {
        this.credentials.recordLoginFailure(req.requestedUser, req.sourceIp, 'service-type ssh not permitted', this.now());
        return SshConnectionDecision.reject('service-type ssh not permitted', this.now());
      }
    }

    if (!this.config.isUserAllowed(req.requestedUser, [])) {
      this.credentials.recordLoginFailure(req.requestedUser, req.sourceIp, 'AllowUsers/DenyUsers denial', this.now());
      return SshConnectionDecision.reject('user not allowed by sshd_config', this.now());
    }

    if (req.requestedUser === 'root' && effective.permitRootLogin === 'no') {
      this.credentials.recordLoginFailure(req.requestedUser, req.sourceIp, 'PermitRootLogin no', this.now());
      return SshConnectionDecision.reject('PermitRootLogin no', this.now());
    }

    const method = this.negotiateAuth(req, account, effective);
    if (!method) {
      this.credentials.recordLoginFailure(req.requestedUser, req.sourceIp, 'auth failed', this.now());
      return SshConnectionDecision.reject('authentication failed', this.now());
    }

    this.credentials.recordLoginSuccess(req.requestedUser, req.sourceIp, method, this.now());
    return SshConnectionDecision.accept(method, {
      sessionId: `ssh-${this.deviceId}-${this.nextSessionSeq++}`,
      at: this.now(),
    });
  }

  private negotiateAuth(
    req: SshConnectionRequest,
    account: NetworkOsAccount | null | undefined,
    eff: SshdEffectiveView,
  ): SshAuthMethod | null {
    if (req.offeredAuthMethods.includes('publickey') && eff.pubkeyAuthentication) {
      const offered = req.credentials.publicKey;
      if (offered && account && account.publicKeys.includes(offered)) return 'publickey';
    }
    if (req.offeredAuthMethods.includes('password') && eff.passwordAuthentication) {
      const provided = req.credentials.password;
      if (provided !== undefined && account && account.authenticate(provided)) return 'password';
      if (provided === '' && eff.permitEmptyPasswords && account && account.secret === '') return 'password';
      if (provided !== undefined && !account && this.credentials.size() === 0) return 'password';
    }
    if (req.offeredAuthMethods.includes('keyboard-interactive') && eff.kbdInteractiveAuthentication) {
      return 'keyboard-interactive';
    }
    return null;
  }
}
