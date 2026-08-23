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

export interface PoolDeps {
  readonly sessionsTo?: (address: string, port: number) => number;
}

export class RealServerPool {
  private servers: RealServer[] = [];
  private readonly dead = new Set<string>();
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
    const candidates = this.alive();
    if (candidates.length === 0) return undefined;

    const chosen = this.choose(candidates);
    return chosen === undefined
      ? undefined : Object.freeze({ address: chosen.address, port: chosen.port });
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
    const load = this.deps.sessionsTo;
    if (load === undefined) return this.nextInTurn(candidates);
    return candidates.reduce((best, server) =>
      load(server.address, server.port) < load(best.address, best.port) ? server : best);
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
