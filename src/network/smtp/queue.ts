import type { TcpStack } from '@/network/tcp/TcpStack';
import type { IScheduler, TimerHandle } from '@/events/Scheduler';
import type { IEventBus } from '@/events/EventBus';
import { relayToRecipient, domainOf, type DnsLookup } from './relay';

export interface QueuedDelivery {
  readonly recipient: string;
  readonly envelopeFrom: string;
  readonly rawMessage: string;
  readonly heloDomain: string;
  attempts: number;
  readonly firstAttemptAt: number;
  nextAttemptAt: number;
  lastError?: string;
  readonly expiresAt: number;
}

export interface RetrySchedule {
  readonly baseDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maxTotalDurationMs: number;
}

export const DEFAULT_RETRY_SCHEDULE: RetrySchedule = {
  baseDelayMs: 15 * 60_000,
  backoffMultiplier: 2,
  maxTotalDurationMs: 3 * 24 * 3600_000,
};

export function computeNextAttemptDelay(attempts: number, schedule: RetrySchedule): number {
  return schedule.baseDelayMs * Math.pow(schedule.backoffMultiplier, attempts);
}

export function hasExpired(entry: QueuedDelivery, now: number): boolean {
  return now >= entry.expiresAt;
}

export interface DeliveryQueueDeps {
  readonly tcpStack: TcpStack;
  readonly localIp: string;
  readonly lookup: DnsLookup;
  readonly scheduler: IScheduler;
  readonly schedule?: RetrySchedule;
  readonly onDelivered?: (entry: QueuedDelivery) => void;
  readonly onExpired?: (entry: QueuedDelivery) => void;
  readonly eventBus?: IEventBus;
}

export class DeliveryQueue {
  private entries: QueuedDelivery[] = [];
  private timerHandle: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly suspendedDomains = new Set<string>();

  constructor(private readonly deps: DeliveryQueueDeps) {}

  suspend(domain: string): void {
    this.suspendedDomains.add(domain.toLowerCase());
  }

  resume(domain: string): void {
    this.suspendedDomains.delete(domain.toLowerCase());
    this.rearm();
  }

  isSuspended(domain: string): boolean {
    return this.suspendedDomains.has(domain.toLowerCase());
  }

  retryNow(domain: string): Promise<void> {
    const key = domain.toLowerCase();
    const now = this.deps.scheduler.now();
    for (const entry of this.entries) {
      if (domainOf(entry.recipient).toLowerCase() === key) entry.nextAttemptAt = now;
    }
    this.rearm();
    return this.tick();
  }

  enqueue(recipient: string, envelopeFrom: string, rawMessage: string, heloDomain: string, initialError?: string): QueuedDelivery {
    const schedule = this.deps.schedule ?? DEFAULT_RETRY_SCHEDULE;
    const now = this.deps.scheduler.now();
    const entry: QueuedDelivery = {
      recipient,
      envelopeFrom,
      rawMessage,
      heloDomain,
      attempts: 0,
      firstAttemptAt: now,
      nextAttemptAt: now + computeNextAttemptDelay(0, schedule),
      lastError: initialError,
      expiresAt: now + schedule.maxTotalDurationMs,
    };
    this.entries.push(entry);
    this.rearm();
    return entry;
  }

  size(): number {
    return this.entries.length;
  }

  peekAll(): readonly QueuedDelivery[] {
    return [...this.entries];
  }

  private rearm(): void {
    if (this.timerHandle !== null) {
      this.deps.scheduler.clear(this.timerHandle);
      this.timerHandle = null;
    }
    const active = this.entries.filter((e) => !this.isSuspended(domainOf(e.recipient)));
    if (active.length === 0) return;
    const now = this.deps.scheduler.now();
    const soonest = Math.min(...active.map((e) => e.nextAttemptAt));
    const delay = Math.max(0, soonest - now);
    this.timerHandle = this.deps.scheduler.setTimeout(() => { void this.tick(); }, delay);
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runTick(): Promise<void> {
    const now = this.deps.scheduler.now();
    const due = this.entries.filter((e) => e.nextAttemptAt <= now && !this.isSuspended(domainOf(e.recipient)));
    const schedule = this.deps.schedule ?? DEFAULT_RETRY_SCHEDULE;

    for (const entry of due) {
      if (hasExpired(entry, now)) {
        this.remove(entry);
        this.deps.onExpired?.(entry);
        this.deps.eventBus?.publish({ topic: 'smtp.queue.expired', payload: { recipient: entry.recipient } });
        continue;
      }

      const attempt = await relayToRecipient(
        this.deps.tcpStack, this.deps.localIp, this.deps.lookup, entry.heloDomain, entry.envelopeFrom, entry.recipient, entry.rawMessage,
        this.deps.eventBus,
      );

      if (attempt.outcome === 'delivered') {
        this.remove(entry);
        this.deps.onDelivered?.(entry);
        continue;
      }
      if (attempt.outcome === 'bounced') {
        this.remove(entry);
        this.deps.onExpired?.(entry);
        this.deps.eventBus?.publish({ topic: 'smtp.queue.expired', payload: { recipient: entry.recipient } });
        continue;
      }

      entry.attempts += 1;
      entry.lastError = attempt.detail;
      entry.nextAttemptAt = this.deps.scheduler.now() + computeNextAttemptDelay(entry.attempts, schedule);
      this.deps.eventBus?.publish({ topic: 'smtp.queue.retried', payload: { recipient: entry.recipient, attempt: entry.attempts } });
      if (hasExpired(entry, entry.nextAttemptAt)) {
        this.remove(entry);
        this.deps.onExpired?.(entry);
        this.deps.eventBus?.publish({ topic: 'smtp.queue.expired', payload: { recipient: entry.recipient } });
      }
    }

    this.rearm();
  }

  private remove(entry: QueuedDelivery): void {
    this.entries = this.entries.filter((e) => e !== entry);
  }
}
