/**
 * PRD-HTTP.md §2.1.L / §5 P11 — reactive event taxonomy, transverse to
 * P2-P10: request lifecycle (`http.request.*`), cache decisions
 * (`http.cache.*`), WebSocket lifecycle (`websocket.*`), and HTTP/2 stream
 * lifecycle (`http2.stream.*`). `quic.connection.established/closed`,
 * also named in §2.1.L, is already emitted by `QuicConnection` itself
 * (`PRD-QUIC.md` §5 P12) — nothing to re-emit here, only to consume from
 * the same aggregated `DomainEvent` union.
 */
import type { HttpMethod } from './semantics/types';

export interface HttpRequestRef {
  readonly requestId: string;
  readonly method: HttpMethod;
  readonly target: string;
}

export interface HttpRequestCompletedPayload extends HttpRequestRef {
  readonly statusCode: number;
}

export interface HttpRequestFailedPayload extends HttpRequestRef {
  readonly error: string;
}

export interface HttpCachePayload {
  readonly uri: string;
}

export interface WebSocketRef {
  readonly connectionId: string;
}

export interface WebSocketClosedPayload extends WebSocketRef {
  readonly code: number;
  readonly reason: string;
}

export interface Http2StreamPayload {
  readonly connectionId: string;
  readonly streamId: number;
}

export type HttpDomainEvent =
  | { topic: 'http.request.started'; payload: HttpRequestRef }
  | { topic: 'http.request.completed'; payload: HttpRequestCompletedPayload }
  | { topic: 'http.request.failed'; payload: HttpRequestFailedPayload }
  | { topic: 'http.cache.hit'; payload: HttpCachePayload }
  | { topic: 'http.cache.miss'; payload: HttpCachePayload }
  | { topic: 'http.cache.revalidated'; payload: HttpCachePayload }
  | { topic: 'websocket.opened'; payload: WebSocketRef }
  | { topic: 'websocket.closed'; payload: WebSocketClosedPayload }
  | { topic: 'http2.stream.opened'; payload: Http2StreamPayload }
  | { topic: 'http2.stream.closed'; payload: Http2StreamPayload };

let requestNonceCounter = 0;

/** A stable per-request correlator, matching the shape of `QuicConnection`'s `randomConnectionId`. */
export function randomRequestId(): string {
  requestNonceCounter += 1;
  return `http-req-${requestNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let connectionNonceCounter = 0;

export function randomHttpConnectionId(): string {
  connectionNonceCounter += 1;
  return `http-conn-${connectionNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
