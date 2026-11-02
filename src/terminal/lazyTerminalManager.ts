import type { Equipment } from '@/network/equipment/Equipment';
import type { LigneTerminal, TerminalManager } from './sessions/TerminalManager';
import type { TerminalSession } from './sessions/TerminalSession';

const NO_SESSIONS: Map<string, TerminalSession> = new Map();

class LazyTerminalManager {
  private real: TerminalManager | null = null;
  private loading: Promise<TerminalManager> | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => (this.real === null ? 0 : this.real.getVersion() + 1);

  getAllSessions(): Map<string, TerminalSession> {
    return this.real === null ? NO_SESSIONS : this.real.getAllSessions();
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.real?.getSession(sessionId);
  }

  closeTerminal(sessionId: string): void {
    this.real?.closeTerminal(sessionId);
  }

  async openTerminal(device: Equipment, line?: LigneTerminal): Promise<string | null> {
    const manager = await this.load();
    return manager.openTerminal(device, line);
  }

  load(): Promise<TerminalManager> {
    if (this.loading === null) {
      this.loading = import('./sessions/TerminalManager').then(({ getTerminalManager }) => {
        const manager = getTerminalManager();
        this.real = manager;
        manager.subscribe(() => this.notify());
        this.notify();
        return manager;
      }, (error) => {
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const lazyTerminalManager = new LazyTerminalManager();
