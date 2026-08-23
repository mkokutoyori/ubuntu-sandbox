export const DEFAULT_FDB_AGING_SEC = 300;

export interface FdbEntry {
  readonly mac: string;
  readonly port: string;
  readonly ttlSeconds: number;
}

export interface BridgeFdbOptions {
  readonly now: () => number;
  readonly agingSeconds?: number;
}

export type LearnOutcome = 'new' | 'moved' | 'refreshed';

interface LearnedMac {
  port: string;
  seenAt: number;
}

export class BridgeFdb {
  private readonly macs = new Map<string, LearnedMac>();
  private readonly now: () => number;
  private agingSeconds: number;

  constructor(options: BridgeFdbOptions) {
    this.now = options.now;
    this.agingSeconds = options.agingSeconds ?? DEFAULT_FDB_AGING_SEC;
  }

  learn(mac: string, port: string): LearnOutcome {
    const key = mac.toLowerCase();
    const known = this.living(key);
    this.macs.set(key, { port, seenAt: this.now() });
    if (known === undefined) return 'new';
    return known.port === port ? 'refreshed' : 'moved';
  }

  lookup(mac: string): string | undefined {
    return this.living(mac.toLowerCase())?.port;
  }

  entries(): readonly FdbEntry[] {
    this.expire();
    return Object.freeze([...this.macs].map(([mac, learned]) => Object.freeze({
      mac,
      port: learned.port,
      ttlSeconds: this.remaining(learned),
    })));
  }

  forgetPort(port: string): number {
    let removed = 0;
    for (const [mac, learned] of this.macs) {
      if (learned.port !== port) continue;
      this.macs.delete(mac);
      removed++;
    }
    return removed;
  }

  clear(): void {
    this.macs.clear();
  }

  size(): number {
    this.expire();
    return this.macs.size;
  }

  setAging(seconds: number): void {
    this.agingSeconds = Math.max(1, seconds);
    this.expire();
  }

  getAging(): number {
    return this.agingSeconds;
  }

  private living(key: string): LearnedMac | undefined {
    const learned = this.macs.get(key);
    if (learned === undefined) return undefined;
    if (this.remaining(learned) > 0) return learned;
    this.macs.delete(key);
    return undefined;
  }

  private remaining(learned: LearnedMac): number {
    const elapsed = Math.floor((this.now() - learned.seenAt) / 1000);
    return Math.max(0, this.agingSeconds - elapsed);
  }

  private expire(): void {
    for (const [mac, learned] of this.macs) {
      if (this.remaining(learned) <= 0) this.macs.delete(mac);
    }
  }
}
