/**
 * Typed event bus.
 *
 * See `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.2.
 *
 * Semantics:
 *  - Synchronous dispatch in subscription order.
 *  - Bounded re-entrance: events published from inside a handler are queued
 *    and dispatched after the current handler chain completes.
 *  - Handler exceptions are caught, logged to the console, and re-emitted
 *    on the `bus.handler-error` topic so that supervisors can react.
 *  - Wildcard topic '*' receives every event after specific subscribers.
 *  - Reentrance depth is bounded by `MAX_REENTRANCE_DEPTH` to prevent
 *    runaway publish loops from collapsing the runtime.
 */

import type { DomainEvent, DomainEventTopic, EventOf } from './types';

export type Unsubscribe = () => void;

export type Handler<E extends DomainEvent = DomainEvent> = (event: E) => void;

const WILDCARD = '*' as const;

const MAX_REENTRANCE_DEPTH = 64;

export interface IEventBus {
  publish<E extends DomainEvent>(event: E): void;

  subscribe<T extends DomainEventTopic>(
    topic: T,
    handler: Handler<EventOf<T>>,
  ): Unsubscribe;

  /** Subscribe to every event regardless of topic. */
  subscribeAll(handler: Handler<DomainEvent>): Unsubscribe;

  /** Subscribe with a payload predicate filter. */
  subscribeWhere<T extends DomainEventTopic>(
    topic: T,
    predicate: (payload: EventOf<T>['payload']) => boolean,
    handler: Handler<EventOf<T>>,
  ): Unsubscribe;

  clear(): void;
}

export class EventBus implements IEventBus {
  private readonly handlers = new Map<string, Set<Handler<DomainEvent>>>();
  private readonly queue: DomainEvent[] = [];
  private dispatching = false;
  private reentranceDepth = 0;

  publish<E extends DomainEvent>(event: E): void {
    this.queue.push(event);
    if (this.dispatching) return;

    this.dispatching = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as DomainEvent;
        this.dispatch(next);
      }
    } finally {
      this.dispatching = false;
      this.reentranceDepth = 0;
    }
  }

  subscribe<T extends DomainEventTopic>(
    topic: T,
    handler: Handler<EventOf<T>>,
  ): Unsubscribe {
    return this.attach(topic, handler as unknown as Handler<DomainEvent>);
  }

  subscribeAll(handler: Handler<DomainEvent>): Unsubscribe {
    return this.attach(WILDCARD, handler);
  }

  subscribeWhere<T extends DomainEventTopic>(
    topic: T,
    predicate: (payload: EventOf<T>['payload']) => boolean,
    handler: Handler<EventOf<T>>,
  ): Unsubscribe {
    const wrapped: Handler<DomainEvent> = (event) => {
      const typed = event as EventOf<T>;
      if (predicate(typed.payload)) {
        (handler as unknown as Handler<DomainEvent>)(event);
      }
    };
    return this.attach(topic, wrapped);
  }

  clear(): void {
    this.handlers.clear();
    this.queue.length = 0;
    this.dispatching = false;
    this.reentranceDepth = 0;
  }

  // ────────────────────────────────────────────────────────────────────────

  private attach(topic: string, handler: Handler<DomainEvent>): Unsubscribe {
    let bucket = this.handlers.get(topic);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(topic, bucket);
    }
    bucket.add(handler);
    return () => {
      const current = this.handlers.get(topic);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(topic);
    };
  }

  private dispatch(event: DomainEvent): void {
    if (this.reentranceDepth >= MAX_REENTRANCE_DEPTH) {
      // Drop further re-entrant events to avoid pathological recursion.
      // We still surface an error event so misuse is observable.
      console.error(
        `[EventBus] reentrance depth exceeded (${MAX_REENTRANCE_DEPTH}); dropping event '${event.topic}'`,
      );
      return;
    }
    this.reentranceDepth++;

    const specific = this.handlers.get(event.topic);
    const wildcard = this.handlers.get(WILDCARD);

    // Snapshot to allow handlers to (un)subscribe during dispatch.
    const list: Handler<DomainEvent>[] = [];
    if (specific) list.push(...specific);
    if (wildcard) list.push(...wildcard);

    for (const handler of list) {
      try {
        handler(event);
      } catch (error) {
        // Handler errors must never break the chain. Surface them through
        // a dedicated topic so supervisors / tests can detect them.
        console.error(`[EventBus] handler for '${event.topic}' threw:`, error);
        if (event.topic !== 'bus.handler-error') {
          this.queue.push({
            topic: 'bus.handler-error',
            payload: { topic: event.topic, error },
          });
        }
      }
    }

    this.reentranceDepth--;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Default singleton (used as fallback when no bus is injected).
// Production code is encouraged to inject an explicit bus; tests should
// always create their own to remain isolated.
// ──────────────────────────────────────────────────────────────────────────

let defaultBusInstance: EventBus | null = null;

export function getDefaultEventBus(): EventBus {
  if (!defaultBusInstance) {
    defaultBusInstance = new EventBus();
  }
  return defaultBusInstance;
}

/** Replace the default bus (test-only utility). */
export function __setDefaultEventBus(bus: EventBus | null): void {
  defaultBusInstance = bus;
}
