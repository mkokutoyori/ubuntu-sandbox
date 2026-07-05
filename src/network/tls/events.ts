/**
 * TLS 1.3 (RFC 8446 §4) — reactive event taxonomy (`PRD-TLS.md` §2.1.12).
 *
 * Unlike the long-lived per-device engines other protocols publish from
 * (OSPF, DHCP, IPSec…), a `TlsClientSession`/`TlsServerSession` is an
 * ephemeral, connection-scoped state machine with no device context of its
 * own — no consumer wires one to a real device before `PRD-TLS.md` P11's
 * migration (§2.1.14). Every payload is therefore keyed by `sessionId`
 * alone; a device-bound consumer can attach `deviceId`/`hostname` at its
 * own layer once one exists.
 *
 * `tls.alert.received` is deliberately not modeled: at this fidelity level
 * a fatal condition is never actually transmitted to the peer as a wire
 * `alert` record (see `TlsServerSession.reject`/`TlsClientSession.fail`) —
 * only the side that raises it ever "sends" one.
 */
import type { CipherSuite } from './types';
import type { TlsAlert } from './alerts';

export type TlsSessionRole = 'client' | 'server';

export interface TlsSessionRef {
  readonly sessionId: string;
  readonly role: TlsSessionRole;
}

export type TlsHandshakeStartedPayload = TlsSessionRef;

export interface TlsHandshakeCompletedPayload extends TlsSessionRef {
  readonly cipherSuite: CipherSuite;
  readonly alpnProtocol: string | null;
  readonly resumed: boolean;
}

export interface TlsHandshakeFailedPayload extends TlsSessionRef {
  readonly alert: TlsAlert;
}

export type TlsAlertSentPayload = TlsHandshakeFailedPayload;

export interface TlsSessionResumedPayload extends TlsSessionRef {
  readonly ticket: string;
}

export interface TlsKeyUpdatePayload extends TlsSessionRef {
  readonly direction: 'client-to-server' | 'server-to-client';
  readonly requestUpdate: boolean;
}

export type TlsDomainEvent =
  | { topic: 'tls.handshake.started'; payload: TlsHandshakeStartedPayload }
  | { topic: 'tls.handshake.completed'; payload: TlsHandshakeCompletedPayload }
  | { topic: 'tls.handshake.failed'; payload: TlsHandshakeFailedPayload }
  | { topic: 'tls.alert.sent'; payload: TlsAlertSentPayload }
  | { topic: 'tls.session.resumed'; payload: TlsSessionResumedPayload }
  | { topic: 'tls.key_update'; payload: TlsKeyUpdatePayload };
