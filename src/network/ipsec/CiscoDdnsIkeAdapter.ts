import { CiscoRouter } from '../devices/CiscoRouter';
import { LinuxPC } from '../devices/LinuxPC';
import type { IkeInitiator } from './DdnsSiteTunnelController';

export interface CiscoDdnsIkeAdapterConfig {
  readonly router: CiscoRouter;
  readonly triggerHost: LinuxPC;
  readonly triggerTarget: string;
  readonly pingCount?: number;
}

interface EngineFacade {
  ipsecSADB: Map<string, unknown[]>;
  clearSAsForPeer: (peer: string, reason: 'manual' | 'lifetime' | 'dpd' | 'replaced' | 'shutdown') => void;
}

export class CiscoDdnsIkeAdapter implements IkeInitiator {
  private readonly cfg: CiscoDdnsIkeAdapterConfig;
  private pendingOperation: Promise<void> = Promise.resolve();

  constructor(cfg: CiscoDdnsIkeAdapterConfig) {
    this.cfg = cfg;
  }

  open(peerIp: string): boolean {
    void peerIp;
    const count = this.cfg.pingCount ?? 2;
    this.pendingOperation = this.cfg.triggerHost
      .executeCommand(`ping -c ${count} ${this.cfg.triggerTarget}`)
      .then(() => {});
    return true;
  }

  close(peerIp: string): void {
    this.getEngine()?.clearSAsForPeer(peerIp, 'manual');
  }

  hasSaForPeer(peerIp: string): boolean {
    const engine = this.getEngine();
    if (!engine) return false;
    const sas = engine.ipsecSADB.get(peerIp);
    return !!sas && sas.length > 0;
  }

  async waitForPendingOperation(): Promise<void> {
    await this.pendingOperation;
  }

  private getEngine(): EngineFacade | null {
    const r = this.cfg.router as unknown as { _getIPSecEngineInternal?(): EngineFacade };
    return r._getIPSecEngineInternal?.() ?? null;
  }
}
