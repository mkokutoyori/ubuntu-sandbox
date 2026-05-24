import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { NetworkOsAccountEventEnvelope } from './NetworkOsAccount';

export interface LoginBlockerOptions {
  deviceId: string;
  bus: IEventBus;
  attempts: number;
  withinSeconds: number;
  blockSeconds: number;
  now?: () => number;
}

interface ClientHistory {
  failureTimes: number[];
  blockedUntil: number;
}

export class LoginBlocker {
  private readonly deviceId: string;
  private readonly attempts: number;
  private readonly withinMs: number;
  private readonly blockMs: number;
  private readonly clients: Map<string, ClientHistory> = new Map();
  private readonly subs: Unsubscribe[] = [];
  private readonly now: () => number;

  constructor(opts: LoginBlockerOptions) {
    this.deviceId = opts.deviceId;
    this.attempts = opts.attempts;
    this.withinMs = opts.withinSeconds * 1000;
    this.blockMs = opts.blockSeconds * 1000;
    this.now = opts.now ?? Date.now;
    this.subs.push(opts.bus.subscribe('router.aaa.account.login.failure', this.onFailure));
    this.subs.push(opts.bus.subscribe('router.aaa.account.login.success', this.onSuccess));
  }

  detach(): void { for (const s of this.subs) s(); this.subs.length = 0; }

  private onFailure = (e: { topic: string; payload: unknown }) => {
    const env = e as unknown as NetworkOsAccountEventEnvelope;
    if (env.payload.deviceId !== this.deviceId) return;
    const ip = env.payload.from ?? 'unknown';
    const at = env.payload.at ?? this.now();
    const hist = this.history(ip);
    hist.failureTimes = hist.failureTimes.filter(t => at - t <= this.withinMs);
    hist.failureTimes.push(at);
    if (hist.failureTimes.length >= this.attempts) {
      hist.blockedUntil = at + this.blockMs;
    }
  };

  private onSuccess = (e: { topic: string; payload: unknown }) => {
    const env = e as unknown as NetworkOsAccountEventEnvelope;
    if (env.payload.deviceId !== this.deviceId) return;
    const ip = env.payload.from ?? 'unknown';
    const hist = this.history(ip);
    hist.failureTimes = [];
    hist.blockedUntil = 0;
  };

  private history(ip: string): ClientHistory {
    let h = this.clients.get(ip);
    if (!h) { h = { failureTimes: [], blockedUntil: 0 }; this.clients.set(ip, h); }
    return h;
  }

  isBlocked(ip: string, at: number = this.now()): boolean {
    const h = this.clients.get(ip);
    if (!h) return false;
    if (h.blockedUntil && at < h.blockedUntil) return true;
    if (h.blockedUntil && at >= h.blockedUntil) {
      h.blockedUntil = 0;
      h.failureTimes = [];
    }
    return false;
  }

  remainingFailuresBeforeBlock(ip: string, at: number = this.now()): number {
    const h = this.clients.get(ip);
    if (!h) return this.attempts;
    const recent = h.failureTimes.filter(t => at - t <= this.withinMs).length;
    return Math.max(0, this.attempts - recent);
  }

  reset(ip?: string): void {
    if (ip === undefined) this.clients.clear();
    else this.clients.delete(ip);
  }
}
