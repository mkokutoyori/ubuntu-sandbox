/**
 * PRD-QUIC.md §5 P12 — observable read-model (Signal) over `events.ts`'s
 * `quic.*` topics, mirroring `src/network/tls/observables.ts`'s shape: a
 * pure subscription over the event bus, keyed by `connectionId`, with no
 * projection over a long-lived engine.
 */
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';
import type { QuicRole } from './events';

export interface QuicConnectionVM {
  readonly connectionId: string;
  readonly role: QuicRole;
  readonly status: 'handshaking' | 'established' | 'closing' | 'closed';
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly packetsLost: number;
  readonly congestionWindow: number | null;
  readonly openStreamIds: ReadonlyArray<number>;
}

const EMPTY_CONNECTION: Omit<QuicConnectionVM, 'connectionId' | 'role'> = {
  status: 'handshaking', packetsSent: 0, packetsReceived: 0, packetsLost: 0, congestionWindow: null, openStreamIds: [],
};

export class QuicSignalStore {
  readonly connections = new WritableSignal<ReadonlyArray<QuicConnectionVM>>([]);

  upsert(connectionId: string, role: QuicRole, patch: Partial<Omit<QuicConnectionVM, 'connectionId' | 'role'>>): QuicConnectionVM {
    const current = this.connections.get();
    const index = current.findIndex((c) => c.connectionId === connectionId);
    const base = index >= 0 ? current[index] : { connectionId, role, ...EMPTY_CONNECTION };
    const next = { ...base, ...patch };
    this.connections.set(index >= 0 ? current.map((c, i) => (i === index ? next : c)) : [...current, next]);
    return next;
  }
}

export function connectionSignal(store: QuicSignalStore, connectionId: string): Signal<QuicConnectionVM | undefined> {
  return {
    get: () => store.connections.get().find((c) => c.connectionId === connectionId),
    subscribe: (listener) => store.connections.subscribe(listener),
  };
}

/** Wires a `QuicSignalStore` to an event bus's `quic.*` topics; returns a single combined unsubscribe. */
export function subscribeQuicObservables(bus: IEventBus, store: QuicSignalStore): Unsubscribe {
  const currentOf = (connectionId: string): QuicConnectionVM | undefined =>
    store.connections.get().find((c) => c.connectionId === connectionId);

  const unsubs: Unsubscribe[] = [
    bus.subscribe('quic.connection.established', ({ payload }) => {
      store.upsert(payload.connectionId, payload.role, { status: 'established' });
    }),
    bus.subscribe('quic.connection.closing', ({ payload }) => {
      store.upsert(payload.connectionId, payload.role, { status: 'closing' });
    }),
    bus.subscribe('quic.connection.closed', ({ payload }) => {
      store.upsert(payload.connectionId, payload.role, { status: 'closed' });
    }),
    bus.subscribe('quic.packet.sent', ({ payload }) => {
      const current = currentOf(payload.connectionId);
      store.upsert(payload.connectionId, payload.role, { packetsSent: (current?.packetsSent ?? 0) + 1 });
    }),
    bus.subscribe('quic.packet.received', ({ payload }) => {
      const current = currentOf(payload.connectionId);
      store.upsert(payload.connectionId, payload.role, { packetsReceived: (current?.packetsReceived ?? 0) + 1 });
    }),
    bus.subscribe('quic.packet.lost', ({ payload }) => {
      const current = currentOf(payload.connectionId);
      store.upsert(payload.connectionId, payload.role, { packetsLost: (current?.packetsLost ?? 0) + 1 });
    }),
    bus.subscribe('quic.congestion.window_changed', ({ payload }) => {
      store.upsert(payload.connectionId, payload.role, { congestionWindow: payload.congestionWindow });
    }),
    bus.subscribe('quic.stream.opened', ({ payload }) => {
      const current = currentOf(payload.connectionId);
      const ids = current?.openStreamIds ?? [];
      if (!ids.includes(payload.streamId)) store.upsert(payload.connectionId, payload.role, { openStreamIds: [...ids, payload.streamId] });
    }),
    bus.subscribe('quic.stream.closed', ({ payload }) => {
      const current = currentOf(payload.connectionId);
      const ids = current?.openStreamIds ?? [];
      store.upsert(payload.connectionId, payload.role, { openStreamIds: ids.filter((id) => id !== payload.streamId) });
    }),
  ];
  return () => unsubs.forEach((u) => u());
}
