/**
 * Logger — Pub/Sub event system for network debugging.
 *
 * Phase 2 of the reactive refactor (cf. docs/REFONTE-REACTIVE-EVENT-DRIVEN.md
 * §10.3): the Logger is now an adapter on top of the central `EventBus`.
 *
 * Behaviour preserved (≈ 90 callsites unchanged):
 *  - `Logger.{debug,info,warn,error}(source, event, message, data?)` still
 *    appends to an in-memory ring buffer and notifies legacy subscribers
 *    filtered by `source` / `event` prefix / `level`.
 *  - `subscribe(handler, filter?)` and `unsubscribe(id)` keep their exact
 *    signatures.
 *
 * What changed under the hood:
 *  - Every `log()` call publishes a `{ topic: 'log', payload }` event on
 *    the default `EventBus`, allowing future projections / adapters /
 *    UI hooks to consume the same stream without any new wiring.
 *  - The legacy in-memory buffer is kept *for now* to avoid a wide-area
 *    test impact; a dedicated `LogProjection` will replace it in a later
 *    phase.
 */

import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NetworkLog {
  timestamp: number;
  level: LogLevel;
  source: string;        // equipment ID that emitted the event
  sourceLabel?: string;  // human-readable label (e.g. "PC1 (eth0)")
  event: string;         // event name (e.g. "frame:sent", "frame:received", "arp:request")
  message: string;       // human-readable description
  data?: Record<string, unknown>; // optional structured data
}

export type LogSubscriber = (log: NetworkLog) => void;

interface Subscription {
  id: number;
  subscriber: LogSubscriber;
  filter?: {
    source?: string;
    event?: string;
    level?: LogLevel;
  };
}

class LoggerSingleton {
  private subscriptions: Subscription[] = [];
  private nextId = 1;
  private logs: NetworkLog[] = [];
  private maxLogs = 10000;
  /** Bus override — falls back to the lazy default singleton. */
  private busOverride: IEventBus | null = null;

  /**
   * Inject a custom bus (test-only utility). Pass `null` to revert to the
   * default singleton.
   */
  __setBus(bus: IEventBus | null): void {
    this.busOverride = bus;
  }

  private getBus(): IEventBus {
    return this.busOverride ?? getDefaultEventBus();
  }

  /** Publish a log event */
  log(level: LogLevel, source: string, event: string, message: string, data?: Record<string, unknown>): void {
    const entry: NetworkLog = {
      timestamp: Date.now(),
      level,
      source,
      event,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs / 2);
    }

    // Mirror onto the EventBus so any consumer (BusTracer, projections,
    // UI hooks, future LogProjection) can react without subscribing here.
    this.getBus().publish({
      topic: 'log',
      payload: { level, source, event, message, data },
    });

    for (const sub of this.subscriptions) {
      if (sub.filter) {
        if (sub.filter.source && sub.filter.source !== source) continue;
        if (sub.filter.event && !event.startsWith(sub.filter.event)) continue;
        if (sub.filter.level && sub.filter.level !== level) continue;
      }
      try {
        sub.subscriber(entry);
      } catch (err) {
        // A misbehaving subscriber must not break the chain.
        console.error('[Logger] subscriber threw:', err);
      }
    }
  }

  debug(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', source, event, message, data);
  }

  info(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', source, event, message, data);
  }

  warn(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', source, event, message, data);
  }

  error(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.log('error', source, event, message, data);
  }

  /** Subscribe to log events with optional filter */
  subscribe(subscriber: LogSubscriber, filter?: Subscription['filter']): number {
    const id = this.nextId++;
    this.subscriptions.push({ id, subscriber, filter });
    return id;
  }

  /** Unsubscribe by subscription ID */
  unsubscribe(id: number): void {
    this.subscriptions = this.subscriptions.filter(s => s.id !== id);
  }

  /** Get all stored logs */
  getLogs(): NetworkLog[] {
    return [...this.logs];
  }

  /** Get logs filtered by source */
  getLogsBySource(source: string): NetworkLog[] {
    return this.logs.filter(l => l.source === source);
  }

  /** Clear all logs and subscriptions */
  reset(): void {
    this.logs = [];
    this.subscriptions = [];
    this.nextId = 1;
  }
}

export const Logger = new LoggerSingleton();
