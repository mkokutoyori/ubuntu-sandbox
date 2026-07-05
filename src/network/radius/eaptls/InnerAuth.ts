/**
 * PEAP/EAP-TTLS inner authentication — once the outer TLS tunnel
 * (`EapTlsServerSession`/`EapTlsPeerSession`) is established, these run
 * inside it, exchanging opaque tunneled byte messages instead of raw
 * EAP-Message RADIUS attributes. `TtlsInnerAuth.ts`/`PeapInnerAuth.ts`
 * implement these for the two supported inner methods.
 */
export interface InnerAuthServer {
  /** The first tunneled message to send once the tunnel is up. */
  start(): Uint8Array;
  /** Process the peer's tunneled response; `result` stays null while more rounds are needed. */
  handle(incoming: Uint8Array): { next: Uint8Array | null; result: 'accept' | 'reject' | null };
}

export interface InnerAuthPeer {
  /** Process one tunneled message from the server; returns the next tunneled response to send. `result`, once non-null, is the peer's own best-effort read of the outcome — the authoritative signal is still the outer (unwrapped) EAP-Success/Failure the server sends once its own `InnerAuthServer.handle()` returns a result. */
  handle(incoming: Uint8Array): { next: Uint8Array; result: 'success' | 'failure' | null };
}
