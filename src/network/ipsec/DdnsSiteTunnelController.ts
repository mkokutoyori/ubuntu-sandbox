import { Logger } from '../core/Logger';
import { DdnsResolver } from './DdnsResolver';
import { DeadPeerDetector } from './DeadPeerDetector';

const LOG_SRC = 'ddns-vpn';
const LOG_CTX = 'ipsec:ddns';

export interface IkeInitiator {
  open(peerIp: string): boolean;
  close(peerIp: string): void;
}

export interface DdnsSiteTunnelConfig {
  readonly hostname: string;
  readonly resolver: DdnsResolver;
  readonly dpd: {
    readonly intervalMs: number;
    readonly maxRetries: number;
    readonly probe: (peer: string) => boolean;
  };
  readonly ikeInitiator: IkeInitiator;
}

export class DdnsSiteTunnelController {
  private readonly cfg: DdnsSiteTunnelConfig;
  private activePeer: string | null = null;
  private previousPeers: string[] = [];
  private dpd: DeadPeerDetector | null = null;
  private connected = false;

  constructor(cfg: DdnsSiteTunnelConfig) {
    this.cfg = cfg;
  }

  get isConnected(): boolean { return this.connected; }
  getActivePeer(): string | null { return this.activePeer; }
  getPreviousPeers(): readonly string[] { return [...this.previousPeers]; }

  connect(): void {
    if (this.connected) throw new Error('DDNS tunnel already connected');
    const peer = this.cfg.resolver.resolve();
    Logger.info(LOG_SRC, LOG_CTX,
      `DDNS resolved ${this.cfg.hostname} to ${peer}`);
    if (!this.cfg.ikeInitiator.open(peer)) {
      throw new Error(`IKE initiation failed for ${peer}`);
    }
    this.activePeer = peer;
    this.connected = true;
    this.startDpd();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.stopDpd();
    if (this.activePeer) {
      this.cfg.ikeInitiator.close(this.activePeer);
      this.previousPeers.push(this.activePeer);
      this.activePeer = null;
    }
    this.connected = false;
  }

  private startDpd(): void {
    const peer = this.activePeer!;
    this.dpd = new DeadPeerDetector({
      intervalMs: this.cfg.dpd.intervalMs,
      maxRetries: this.cfg.dpd.maxRetries,
      probe: this.cfg.dpd.probe,
      peer,
      onDead: () => this.handlePeerDead(peer),
    });
    this.dpd.start();
  }

  private stopDpd(): void {
    if (this.dpd) {
      this.dpd.stop();
      this.dpd = null;
    }
  }

  private handlePeerDead(deadPeer: string): void {
    Logger.warn(LOG_SRC, LOG_CTX, `DPD: peer ${deadPeer} not responding`);
    this.dpd = null;
    this.cfg.ikeInitiator.close(deadPeer);
    this.previousPeers.push(deadPeer);
    this.activePeer = null;
    this.cfg.resolver.invalidate();
    const nextPeer = this.cfg.resolver.resolve();
    Logger.info(LOG_SRC, LOG_CTX,
      `DNS re-resolved ${this.cfg.hostname} to ${nextPeer}`);
    if (!this.cfg.ikeInitiator.open(nextPeer)) {
      Logger.error(LOG_SRC, LOG_CTX,
        `IKE re-initiation failed for ${nextPeer}, tunnel remains down`);
      this.connected = false;
      return;
    }
    this.activePeer = nextPeer;
    this.startDpd();
  }
}
