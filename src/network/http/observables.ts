/**
 * PRD-HTTP.md §5 P11 — observable read-model (Signal) over `events.ts`'s
 * topics. Unlike `src/network/quic/observables.ts` (one long-lived
 * connection per `connectionId`, naturally modeled as a per-entity view),
 * HTTP requests and cache lookups are short-lived, high-cardinality events
 * — the useful read-model here is a single aggregate counters view, the
 * same shape a real metrics dashboard would show.
 */
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';

export interface HttpMetricsVM {
  readonly requestsStarted: number;
  readonly requestsCompleted: number;
  readonly requestsFailed: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheRevalidations: number;
  readonly openWebSocketConnections: number;
  readonly openHttp2Streams: number;
}

const EMPTY_METRICS: HttpMetricsVM = {
  requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0,
  cacheHits: 0, cacheMisses: 0, cacheRevalidations: 0,
  openWebSocketConnections: 0, openHttp2Streams: 0,
};

export class HttpSignalStore {
  readonly metrics = new WritableSignal<HttpMetricsVM>(EMPTY_METRICS);

  private bump(patch: Partial<HttpMetricsVM>): void {
    const current = this.metrics.get();
    this.metrics.set({ ...current, ...patch });
  }

  incrementRequestsStarted(): void { this.bump({ requestsStarted: this.metrics.get().requestsStarted + 1 }); }
  incrementRequestsCompleted(): void { this.bump({ requestsCompleted: this.metrics.get().requestsCompleted + 1 }); }
  incrementRequestsFailed(): void { this.bump({ requestsFailed: this.metrics.get().requestsFailed + 1 }); }
  incrementCacheHits(): void { this.bump({ cacheHits: this.metrics.get().cacheHits + 1 }); }
  incrementCacheMisses(): void { this.bump({ cacheMisses: this.metrics.get().cacheMisses + 1 }); }
  incrementCacheRevalidations(): void { this.bump({ cacheRevalidations: this.metrics.get().cacheRevalidations + 1 }); }
  adjustOpenWebSocketConnections(delta: number): void { this.bump({ openWebSocketConnections: this.metrics.get().openWebSocketConnections + delta }); }
  adjustOpenHttp2Streams(delta: number): void { this.bump({ openHttp2Streams: this.metrics.get().openHttp2Streams + delta }); }
}

export function metricsSignal(store: HttpSignalStore): Signal<HttpMetricsVM> {
  return { get: () => store.metrics.get(), subscribe: (listener) => store.metrics.subscribe(listener) };
}

/** Wires an `HttpSignalStore` to an event bus's `http.*`/`websocket.*`/`http2.stream.*` topics; returns a single combined unsubscribe. */
export function subscribeHttpObservables(bus: IEventBus, store: HttpSignalStore): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    bus.subscribe('http.request.started', () => store.incrementRequestsStarted()),
    bus.subscribe('http.request.completed', () => store.incrementRequestsCompleted()),
    bus.subscribe('http.request.failed', () => store.incrementRequestsFailed()),
    bus.subscribe('http.cache.hit', () => store.incrementCacheHits()),
    bus.subscribe('http.cache.miss', () => store.incrementCacheMisses()),
    bus.subscribe('http.cache.revalidated', () => store.incrementCacheRevalidations()),
    bus.subscribe('websocket.opened', () => store.adjustOpenWebSocketConnections(1)),
    bus.subscribe('websocket.closed', () => store.adjustOpenWebSocketConnections(-1)),
    bus.subscribe('http2.stream.opened', () => store.adjustOpenHttp2Streams(1)),
    bus.subscribe('http2.stream.closed', () => store.adjustOpenHttp2Streams(-1)),
  ];
  return () => unsubs.forEach((u) => u());
}
