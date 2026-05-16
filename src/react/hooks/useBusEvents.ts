/**
 * `useBusEvents` — React hook that subscribes to a bus topic and returns
 * a bounded ring buffer of the most recent events. Useful for live trace
 * overlays, packet animation feeds, and capture-style UIs.
 *
 * Re-renders only when a new event arrives (or when topic/filter change).
 */

import { useEffect, useRef, useState } from 'react';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';
import type { DomainEventTopic, EventOf, PayloadOf } from '@/events/types';

export interface UseBusEventsOptions<T extends DomainEventTopic> {
  /** Filter applied to each event payload. Default: accept all. */
  filter?: (payload: PayloadOf<T>) => boolean;
  /** Maximum events retained in the buffer (default 100). */
  maxEntries?: number;
  /** Custom bus override (defaults to the singleton default bus). */
  bus?: IEventBus;
}

export function useBusEvents<T extends DomainEventTopic>(
  topic: T,
  opts: UseBusEventsOptions<T> = {},
): EventOf<T>[] {
  const max = opts.maxEntries ?? 100;
  const filterRef = useRef(opts.filter);
  filterRef.current = opts.filter;

  const [events, setEvents] = useState<EventOf<T>[]>([]);

  useEffect(() => {
    const bus = opts.bus ?? getDefaultEventBus();
    const unsubscribe = bus.subscribe(topic, (event) => {
      const typed = event as EventOf<T>;
      if (filterRef.current && !filterRef.current(typed.payload)) return;
      setEvents((prev) => {
        const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
        next.push(typed);
        return next;
      });
    });
    return () => { unsubscribe(); };
  }, [topic, max, opts.bus]);

  return events;
}
