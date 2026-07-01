import { IPAddress, SubnetMask } from '../core/types';

export type VpnTunnelMode = 'split' | 'full';

export interface RemoteAccessVpnConfig {
  readonly gatewayPublicIp: string;
  readonly corporateSubnets: readonly string[];
  readonly mode: VpnTunnelMode;
  readonly virtualIp?: string;
  readonly tunnelIface?: string;
}

export interface VpnRoutingSurface {
  getDefaultGateway(): IPAddress | null;
  installTunnelRoute(
    network: IPAddress,
    mask: SubnetMask,
    nextHop: IPAddress | null,
    iface: string,
    type: 'static' | 'default',
    metric?: number,
  ): void;
  removeTunnelRoute(network: IPAddress, mask: SubnetMask, iface: string): boolean;
}

export interface InstalledVpnRoute {
  readonly network: IPAddress;
  readonly mask: SubnetMask;
  readonly nextHop: IPAddress | null;
  readonly iface: string;
  readonly type: 'static' | 'default';
  readonly metric: number;
}

const SPLIT_METRIC = 50;
const FULL_PEER_HOST_METRIC = 1;
const FULL_DEFAULT_METRIC = 5;
const DEFAULT_TUN_IFACE = 'tun0';

function parseCidr(cidr: string): { network: IPAddress; mask: SubnetMask } {
  const slash = cidr.indexOf('/');
  if (slash < 0) throw new Error(`Invalid CIDR: ${cidr}`);
  const netStr = cidr.slice(0, slash);
  const cidrN = parseInt(cidr.slice(slash + 1), 10);
  if (Number.isNaN(cidrN) || cidrN < 0 || cidrN > 32) {
    throw new Error(`Invalid CIDR length: ${cidr}`);
  }
  return { network: new IPAddress(netStr), mask: SubnetMask.fromCIDR(cidrN) };
}

export class RemoteAccessVpnClient {
  private readonly cfg: RemoteAccessVpnConfig;
  private readonly kernel: VpnRoutingSurface;
  private readonly gateway: IPAddress;
  private readonly tunIface: string;
  private savedDefault: IPAddress | null = null;
  private installed: InstalledVpnRoute[] = [];
  private connected = false;

  constructor(cfg: RemoteAccessVpnConfig, kernel: VpnRoutingSurface) {
    this.cfg = cfg;
    this.kernel = kernel;
    this.gateway = new IPAddress(cfg.gatewayPublicIp);
    this.tunIface = cfg.tunnelIface ?? DEFAULT_TUN_IFACE;
  }

  get isConnected(): boolean { return this.connected; }
  get mode(): VpnTunnelMode { return this.cfg.mode; }
  get gatewayIp(): IPAddress { return this.gateway; }

  getInstalledRoutes(): readonly InstalledVpnRoute[] {
    return [...this.installed];
  }

  connect(): void {
    if (this.connected) throw new Error('VPN client already connected');
    this.savedDefault = this.kernel.getDefaultGateway();
    if (this.cfg.mode === 'split') {
      this.installSplit();
    } else {
      this.installFull();
    }
    this.connected = true;
  }

  disconnect(): void {
    if (!this.connected) return;
    for (const r of this.installed) {
      this.kernel.removeTunnelRoute(r.network, r.mask, r.iface);
    }
    this.installed = [];
    if (this.cfg.mode === 'full' && this.savedDefault) {
      const anyMask = new SubnetMask('0.0.0.0');
      const anyNet = new IPAddress('0.0.0.0');
      this.kernel.installTunnelRoute(anyNet, anyMask, this.savedDefault, 'eth0', 'default', 0);
    }
    this.savedDefault = null;
    this.connected = false;
  }

  private installSplit(): void {
    for (const cidr of this.cfg.corporateSubnets) {
      const { network, mask } = parseCidr(cidr);
      this.kernel.installTunnelRoute(network, mask, this.gateway, this.tunIface, 'static', SPLIT_METRIC);
      this.installed.push({
        network, mask, nextHop: this.gateway, iface: this.tunIface, type: 'static', metric: SPLIT_METRIC,
      });
    }
  }

  private installFull(): void {
    const savedDef = this.savedDefault;
    if (savedDef) {
      const host32 = SubnetMask.fromCIDR(32);
      this.kernel.installTunnelRoute(this.gateway, host32, savedDef, 'eth0', 'static', FULL_PEER_HOST_METRIC);
      this.installed.push({
        network: this.gateway, mask: host32, nextHop: savedDef,
        iface: 'eth0', type: 'static', metric: FULL_PEER_HOST_METRIC,
      });
    }
    const anyMask = new SubnetMask('0.0.0.0');
    const anyNet = new IPAddress('0.0.0.0');
    this.kernel.installTunnelRoute(anyNet, anyMask, this.gateway, this.tunIface, 'default', FULL_DEFAULT_METRIC);
    this.installed.push({
      network: anyNet, mask: anyMask, nextHop: this.gateway,
      iface: this.tunIface, type: 'default', metric: FULL_DEFAULT_METRIC,
    });
  }
}
