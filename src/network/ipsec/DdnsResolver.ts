const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;

export interface DdnsResolverConfig {
  readonly hostname: string;
  readonly ttlMs: number;
  readonly lookup: (hostname: string) => string;
  readonly now?: () => number;
}

export class DdnsResolver {
  private readonly cfg: DdnsResolverConfig;
  private cached: string | null = null;
  private cachedAt = 0;

  constructor(cfg: DdnsResolverConfig) {
    if (!cfg.hostname) throw new Error('DdnsResolver requires a hostname');
    if (cfg.ttlMs < 0) throw new Error('DdnsResolver ttlMs must be >= 0');
    this.cfg = cfg;
  }

  get hostname(): string { return this.cfg.hostname; }
  get ttlMs(): number { return this.cfg.ttlMs; }

  resolve(): string {
    const now = (this.cfg.now ?? Date.now)();
    if (this.cached !== null && (now - this.cachedAt) < this.cfg.ttlMs) {
      return this.cached;
    }
    const answer = this.cfg.lookup(this.cfg.hostname);
    if (!IPV4_RE.test(answer)) {
      throw new Error(`DdnsResolver: lookup returned invalid IPv4 address "${answer}" for ${this.cfg.hostname}`);
    }
    this.cached = answer;
    this.cachedAt = now;
    return answer;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  getLastResolvedAt(): number { return this.cachedAt; }
  getCachedAnswer(): string | null { return this.cached; }
}
