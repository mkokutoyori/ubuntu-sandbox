export interface DpdConfig {
  readonly intervalMs: number;
  readonly maxRetries: number;
  readonly probe: (peer: string) => boolean;
  readonly onDead: () => void;
  readonly peer?: string;
}

export class DeadPeerDetector {
  private readonly cfg: DpdConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private misses = 0;
  private dead = false;

  constructor(cfg: DpdConfig) {
    if (cfg.intervalMs <= 0) throw new Error('DPD intervalMs must be > 0');
    if (cfg.maxRetries <= 0) throw new Error('DPD maxRetries must be > 0');
    this.cfg = cfg;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { this.tick(); }, this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  markAlive(): void {
    this.misses = 0;
  }

  isDead(): boolean {
    return this.dead;
  }

  private tick(): void {
    if (this.dead) return;
    let ok: boolean;
    try {
      ok = this.cfg.probe(this.cfg.peer ?? '');
    } catch {
      ok = false;
    }
    if (ok) {
      this.misses = 0;
      return;
    }
    this.misses += 1;
    if (this.misses >= this.cfg.maxRetries) {
      this.dead = true;
      this.stop();
      this.cfg.onDead();
    }
  }
}
