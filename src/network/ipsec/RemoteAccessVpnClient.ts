import { IPAddress, SubnetMask } from '../core/types';
import { Logger } from '../core/Logger';
import { DeadPeerDetector } from './DeadPeerDetector';

export type VpnTunnelMode = 'split' | 'full';

export interface DpdClientConfig {
  readonly intervalMs: number;
  readonly maxRetries: number;
  readonly probe: (peer: string) => boolean;
}

export interface RemoteAccessVpnConfig {
  readonly gatewayPublicIp: string;
  readonly corporateSubnets: readonly string[];
  readonly mode: VpnTunnelMode;
  readonly virtualIp?: string;
  readonly tunnelIface?: string;
  readonly backupGateways?: readonly string[];
  readonly dpd?: DpdClientConfig;
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
const LOG_CTX = 'ipsec:client';

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
  private readonly peers: string[];
  private readonly tunIface: string;
  private activePeerIdx = -1;
  private activeGateway: IPAddress | null = null;
  private savedDefault: IPAddress | null = null;
  private installed: InstalledVpnRoute[] = [];
  private connected = false;
  private dpd: DeadPeerDetector | null = null;

  constructor(cfg: RemoteAccessVpnConfig, kernel: VpnRoutingSurface) {
    this.cfg = cfg;
    this.kernel = kernel;
    this.peers = [cfg.gatewayPublicIp, ...(cfg.backupGateways ?? [])];
    this.tunIface = cfg.tunnelIface ?? DEFAULT_TUN_IFACE;
  }

  get isConnected(): boolean { return this.connected; }
  get mode(): VpnTunnelMode { return this.cfg.mode; }
  get gatewayIp(): IPAddress {
    if (!this.activeGateway) throw new Error('VPN client is not connected');
    return this.activeGateway;
  }

  getActivePeer(): string | null {
    return this.activeGateway ? this.activeGateway.toString() : null;
  }

  getInstalledRoutes(): readonly InstalledVpnRoute[] {
    return [...this.installed];
  }

  connect(): void {
    if (this.connected) throw new Error('VPN client already connected');
    this.savedDefault = this.kernel.getDefaultGateway();
    this.activePeerIdx = 0;
    this.installActivePeer();
    this.connected = true;
    this.startDpd();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.stopDpd();
    this.uninstallActivePeerRoutes();
    if (this.cfg.mode === 'full' && this.savedDefault) {
      const anyMask = new SubnetMask('0.0.0.0');
      const anyNet = new IPAddress('0.0.0.0');
      this.kernel.installTunnelRoute(anyNet, anyMask, this.savedDefault, 'eth0', 'default', 0);
    }
    this.savedDefault = null;
    this.activeGateway = null;
    this.activePeerIdx = -1;
    this.connected = false;
  }

  private installActivePeer(): void {
    this.activeGateway = new IPAddress(this.peers[this.activePeerIdx]);
    if (this.cfg.mode === 'split') this.installSplit();
    else this.installFull();
    Logger.info('vpn-client', LOG_CTX,
      `Tunnel established with peer ${this.activeGateway} (mode=${this.cfg.mode})`);
  }

  private uninstallActivePeerRoutes(): void {
    for (const r of this.installed) {
      this.kernel.removeTunnelRoute(r.network, r.mask, r.iface);
    }
    this.installed = [];
  }

  private startDpd(): void {
    if (!this.cfg.dpd) return;
    const gw = this.activeGateway!.toString();
    this.dpd = new DeadPeerDetector({
      intervalMs: this.cfg.dpd.intervalMs,
      maxRetries: this.cfg.dpd.maxRetries,
      probe: this.cfg.dpd.probe,
      peer: gw,
      onDead: () => this.onPeerDead(gw),
    });
    this.dpd.start();
  }

  private stopDpd(): void {
    if (this.dpd) {
      this.dpd.stop();
      this.dpd = null;
    }
  }

  private onPeerDead(deadPeer: string): void {
    Logger.warn('vpn-client', LOG_CTX, `DPD: peer ${deadPeer} declared dead, removing stale SAs`);
    this.dpd = null;
    this.uninstallActivePeerRoutes();
    const next = this.activePeerIdx + 1;
    if (next >= this.peers.length) {
      Logger.error('vpn-client', LOG_CTX,
        `No backup peer available after failover from ${deadPeer}, tunnel closed`);
      if (this.cfg.mode === 'full' && this.savedDefault) {
        const anyMask = new SubnetMask('0.0.0.0');
        const anyNet = new IPAddress('0.0.0.0');
        this.kernel.installTunnelRoute(anyNet, anyMask, this.savedDefault, 'eth0', 'default', 0);
      }
      this.activeGateway = null;
      this.activePeerIdx = -1;
      this.connected = false;
      return;
    }
    this.activePeerIdx = next;
    const backup = this.peers[next];
    Logger.info('vpn-client', LOG_CTX,
      `Failover: switch to backup peer ${backup}, renegotiating IKE SA`);
    this.installActivePeer();
    this.startDpd();
  }

  private installSplit(): void {
    for (const cidr of this.cfg.corporateSubnets) {
      const { network, mask } = parseCidr(cidr);
      this.kernel.installTunnelRoute(network, mask, this.activeGateway!, this.tunIface, 'static', SPLIT_METRIC);
      this.installed.push({
        network, mask, nextHop: this.activeGateway!, iface: this.tunIface, type: 'static', metric: SPLIT_METRIC,
      });
    }
  }

  private installFull(): void {
    const savedDef = this.savedDefault;
    if (savedDef) {
      const host32 = SubnetMask.fromCIDR(32);
      this.kernel.installTunnelRoute(this.activeGateway!, host32, savedDef, 'eth0', 'static', FULL_PEER_HOST_METRIC);
      this.installed.push({
        network: this.activeGateway!, mask: host32, nextHop: savedDef,
        iface: 'eth0', type: 'static', metric: FULL_PEER_HOST_METRIC,
      });
    }
    const anyMask = new SubnetMask('0.0.0.0');
    const anyNet = new IPAddress('0.0.0.0');
    this.kernel.installTunnelRoute(anyNet, anyMask, this.activeGateway!, this.tunIface, 'default', FULL_DEFAULT_METRIC);
    this.installed.push({
      network: anyNet, mask: anyMask, nextHop: this.activeGateway!,
      iface: this.tunIface, type: 'default', metric: FULL_DEFAULT_METRIC,
    });
  }
}
