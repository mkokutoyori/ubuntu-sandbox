/**
 * Logger - Pub/Sub event system for network debugging
 *
 * Every equipment in the network publishes events (frame sent, frame received,
 * frame dropped, etc.). Subscribers can listen to all events or filter by
 * equipment ID, event type, etc.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NetworkLog {
  timestamp: number;
  level: LogLevel;
  source: string;        // equipment ID that emitted the event
  sourceLabel?: string;   // human-readable label (e.g. "PC1 (eth0)")
  event: string;          // event name (e.g. "frame:sent", "frame:received", "arp:request")
  message: string;        // human-readable description
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

  /**
   * Publish a log event
   */
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

    for (const sub of this.subscriptions) {
      if (sub.filter) {
        if (sub.filter.source && sub.filter.source !== source) continue;
        if (sub.filter.event && !event.startsWith(sub.filter.event)) continue;
        if (sub.filter.level && sub.filter.level !== level) continue;
      }
      sub.subscriber(entry);
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

  /**
   * Subscribe to log events with optional filter
   */
  subscribe(subscriber: LogSubscriber, filter?: Subscription['filter']): number {
    const id = this.nextId++;
    this.subscriptions.push({ id, subscriber, filter });
    return id;
  }

  /**
   * Unsubscribe by subscription ID
   */
  unsubscribe(id: number): void {
    this.subscriptions = this.subscriptions.filter(s => s.id !== id);
  }

  /**
   * Get all stored logs
   */
  getLogs(): NetworkLog[] {
    return [...this.logs];
  }

  /**
   * Get logs filtered by source
   */
  getLogsBySource(source: string): NetworkLog[] {
    return this.logs.filter(l => l.source === source);
  }

  /**
   * Clear all logs and subscriptions
   */
  reset(): void {
    this.logs = [];
    this.subscriptions = [];
    this.nextId = 1;
  }
}

export const Logger = new LoggerSingleton();
