export type LdbMethod =
  | 'static' | 'round-robin' | 'weighted' | 'first-alive' | 'least-session';

export interface RealServer {
  readonly id: string;
  readonly address: string;
  readonly port: number;
  readonly weight: number;
  readonly enabled: boolean;
  readonly maxConnections: number;
}

export interface RealServerChoice {
  readonly address: string;
  readonly port: number;
}

export interface RealServerStats {
  attempts: number;
  success: number;
  drop: number;
  fail: number;
}

export interface RealServerView {
  readonly server: RealServer;
  readonly healthy: boolean;
  readonly active: number;
  readonly stats: RealServerStats;
}

export interface PoolDeps {
  readonly sessionsTo?: (address: string, port: number) => number;
}

export class RealServerPool {
  private servers: RealServer[] = [];
  private readonly dead = new Set<string>();
  private readonly stats = new Map<string, RealServerStats>();
  private cursor = 0;

  constructor(
    readonly name: string,
    private method: LdbMethod = 'static',
    private readonly deps: PoolDeps = {},
  ) {}

  setServers(servers: readonly RealServer[]): void {
    this.servers = [...servers];
    for (const id of [...this.dead]) {
      if (!this.servers.some(server => server.id === id)) this.dead.delete(id);
    }
    for (const id of [...this.stats.keys()]) {
      if (!this.servers.some(server => server.id === id)) this.stats.delete(id);
    }
  }

  setMethod(method: LdbMethod): void { this.method = method; }

  getMethod(): LdbMethod { return this.method; }

  list(): readonly RealServer[] { return Object.freeze([...this.servers]); }

  markDead(id: string, dead: boolean): void {
    if (dead) this.dead.add(id);
    else this.dead.delete(id);
  }

  isDead(id: string): boolean { return this.dead.has(id); }

  alive(): readonly RealServer[] {
    return this.servers.filter(server => server.enabled && !this.dead.has(server.id));
  }

  pick(): RealServerChoice | undefined {
    let candidates = this.alive();

    while (candidates.length > 0) {
      const chosen = this.choose(candidates);
      if (chosen === undefined) return undefined;

      const stats = this.statsOf(chosen.id);
      stats.attempts++;
      if (this.atCapacity(chosen)) {
        stats.drop++;
        candidates = candidates.filter(server => server.id !== chosen.id);
        continue;
      }
      stats.success++;
      return Object.freeze({ address: chosen.address, port: chosen.port });
    }
    return undefined;
  }

  activeSessions(server: RealServer): number {
    return this.deps.sessionsTo?.(server.address, server.port) ?? 0;
  }

  view(): readonly RealServerView[] {
    return Object.freeze(this.servers.map(server => Object.freeze({
      server,
      healthy: !this.dead.has(server.id),
      active: this.activeSessions(server),
      stats: { ...this.statsOf(server.id) },
    })));
  }

  clearStats(): void {
    this.stats.clear();
  }

  private atCapacity(server: RealServer): boolean {
    return server.maxConnections > 0
      && this.activeSessions(server) >= server.maxConnections;
  }

  private statsOf(id: string): RealServerStats {
    const existing = this.stats.get(id);
    if (existing) return existing;

    const fresh: RealServerStats = { attempts: 0, success: 0, drop: 0, fail: 0 };
    this.stats.set(id, fresh);
    return fresh;
  }

  private choose(candidates: readonly RealServer[]): RealServer | undefined {
    if (this.method === 'static' || this.method === 'first-alive') return candidates[0];
    if (this.method === 'least-session') return this.leastLoaded(candidates);
    if (this.method === 'weighted') return this.byWeight(candidates);
    return this.nextInTurn(candidates);
  }

  private nextInTurn(candidates: readonly RealServer[]): RealServer {
    const chosen = candidates[this.cursor % candidates.length]!;
    this.cursor = (this.cursor + 1) % candidates.length;
    return chosen;
  }

  private leastLoaded(candidates: readonly RealServer[]): RealServer {
    if (this.deps.sessionsTo === undefined) return this.nextInTurn(candidates);
    return candidates.reduce((best, server) =>
      this.activeSessions(server) < this.activeSessions(best) ? server : best);
  }

  private byWeight(candidates: readonly RealServer[]): RealServer {
    const total = candidates.reduce((sum, server) => sum + Math.max(1, server.weight), 0);
    const step = this.cursor % total;
    this.cursor = (this.cursor + 1) % total;

    let seen = 0;
    for (const server of candidates) {
      seen += Math.max(1, server.weight);
      if (step < seen) return server;
    }
    return candidates[0]!;
  }
}
