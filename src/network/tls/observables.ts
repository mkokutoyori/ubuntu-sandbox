/**
 * TLS 1.3 — observable read-model (Signal) over `events.ts`'s `tls.*`
 * topics (`PRD-TLS.md` §2.1.12). Unlike OSPF/DHCP/IPSec's observables,
 * there is no long-lived per-device engine to poll here — sessions are
 * ephemeral, so this is a pure subscription over the event bus, keyed by
 * `sessionId`, rather than a projection over an engine's live state.
 */
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';
import type { CipherSuite } from './types';
import type { TlsAlert } from './alerts';
import type { TlsSessionRole } from './events';

export interface TlsSessionVM {
  readonly sessionId: string;
  readonly role: TlsSessionRole;
  readonly status: 'in-progress' | 'established' | 'failed';
  readonly cipherSuite: CipherSuite | null;
  readonly alpnProtocol: string | null;
  readonly resumed: boolean;
  readonly alert: TlsAlert | null;
  readonly keyUpdateCount: number;
}

const EMPTY_SESSION: Omit<TlsSessionVM, 'sessionId' | 'role'> = {
  status: 'in-progress', cipherSuite: null, alpnProtocol: null, resumed: false, alert: null, keyUpdateCount: 0,
};

export class TlsSignalStore {
  readonly sessions = new WritableSignal<ReadonlyArray<TlsSessionVM>>([]);

  upsert(sessionId: string, role: TlsSessionRole, patch: Partial<Omit<TlsSessionVM, 'sessionId' | 'role'>>): void {
    const current = this.sessions.get();
    const index = current.findIndex((s) => s.sessionId === sessionId);
    const base = index >= 0 ? current[index] : { sessionId, role, ...EMPTY_SESSION };
    const next = { ...base, ...patch };
    this.sessions.set(index >= 0 ? current.map((s, i) => (i === index ? next : s)) : [...current, next]);
  }
}

export function sessionSignal(store: TlsSignalStore, sessionId: string): Signal<TlsSessionVM | undefined> {
  return {
    get: () => store.sessions.get().find((s) => s.sessionId === sessionId),
    subscribe: (listener) => store.sessions.subscribe(listener),
  };
}

/** Wires a `TlsSignalStore` to an event bus's `tls.*` topics; returns a single combined unsubscribe. */
export function subscribeTlsObservables(bus: IEventBus, store: TlsSignalStore): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    bus.subscribe('tls.handshake.started', ({ payload }) => {
      store.upsert(payload.sessionId, payload.role, { status: 'in-progress' });
    }),
    bus.subscribe('tls.handshake.completed', ({ payload }) => {
      store.upsert(payload.sessionId, payload.role, {
        status: 'established', cipherSuite: payload.cipherSuite, alpnProtocol: payload.alpnProtocol, resumed: payload.resumed,
      });
    }),
    bus.subscribe('tls.handshake.failed', ({ payload }) => {
      store.upsert(payload.sessionId, payload.role, { status: 'failed', alert: payload.alert });
    }),
    bus.subscribe('tls.session.resumed', ({ payload }) => {
      store.upsert(payload.sessionId, payload.role, { resumed: true });
    }),
    bus.subscribe('tls.key_update', ({ payload }) => {
      const current = store.sessions.get().find((s) => s.sessionId === payload.sessionId);
      store.upsert(payload.sessionId, payload.role, { keyUpdateCount: (current?.keyUpdateCount ?? 0) + 1 });
    }),
  ];
  return () => unsubs.forEach((u) => u());
}
