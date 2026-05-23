import type { IEventBus } from '@/events/EventBus';
import { SshdServerConfig } from './SshdServerConfig';
import { SshHostKeyset } from './SshHostKeyset';
import type { NetworkOsCredentialStore } from '../../../devices/router/aaa/NetworkOsCredentialStore';

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
}
