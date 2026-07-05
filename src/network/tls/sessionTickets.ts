/**
 * TLS 1.3 (RFC 8446 §4.6.1, §4.2.11, §2.3) session ticket / PSK resumption
 * / 0-RTT. `SessionTicketStore` is a server-side registry shared across
 * `TlsServerSession` instances (like a real server's session cache) — a
 * new connection is a new session object, so resumption state can't live
 * on the session itself. Anti-replay is deliberately simplified to
 * "one ticket = one use" (documented in `PRD-TLS.md` §2.1.7): real RFC 8446
 * §8 leaves the anti-replay strategy for 0-RTT unspecified/implementation-
 * defined (a Bloom filter across a replay window is one common choice,
 * not a mandated algorithm), so this is a legitimate simplification rather
 * than a missing mandatory feature.
 */
import type { CipherSuite } from './types';
import { expandLabel } from './keySchedule';

export interface SessionTicket {
  readonly ticket: string;
  readonly resumptionMasterSecret: string;
  readonly ticketNonce: string;
  readonly cipherSuite: CipherSuite;
  readonly ticketLifetime: number;
  readonly issuedAt: number;
  consumed: boolean;
}

/** RFC 8446 §7.5.1 shape — `HKDF-Expand-Label(resumption_master_secret, "resumption", ticket_nonce, Hash.length)`. */
export function deriveResumptionPsk(ticket: Pick<SessionTicket, 'resumptionMasterSecret' | 'ticketNonce'>): string {
  return expandLabel(ticket.resumptionMasterSecret, 'resumption', ticket.ticketNonce);
}

export function isTicketFresh(ticket: SessionTicket, nowMs: number): boolean {
  return !ticket.consumed && nowMs >= ticket.issuedAt && nowMs <= ticket.issuedAt + ticket.ticketLifetime * 1000;
}

export class SessionTicketStore {
  private readonly tickets = new Map<string, SessionTicket>();

  issue(ticket: SessionTicket): void {
    this.tickets.set(ticket.ticket, ticket);
  }

  /** Looks up and consumes a ticket; returns null if unknown, expired, or already used. */
  redeem(ticketId: string, nowMs: number): SessionTicket | null {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || !isTicketFresh(ticket, nowMs)) return null;
    ticket.consumed = true;
    return ticket;
  }
}
