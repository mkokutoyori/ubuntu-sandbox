/**
 * KerberosTicketCache — the per-machine ticket cache a real Kerberos
 * client (LSA on Windows) maintains after a successful logon, backing
 * `klist` (PRD-Windows-Server-Advanced.md §5 P2). Holds real `Ticket`s and
 * `EncKdcRepPart`s obtained from a genuine AS/TGS exchange — not the
 * cosmetic canned string `klist` produced before this phase.
 */
import type { EncKdcRepPart, Ticket } from './types';

export interface CachedTicket {
  readonly clientPrincipal: string; // e.g. "alice @ LAB.LOCAL"
  readonly serverPrincipal: string; // e.g. "krbtgt/LAB.LOCAL @ LAB.LOCAL"
  readonly ticket: Ticket;
  readonly sessionKey: string;
  readonly encKdcRepPart: EncKdcRepPart;
}

export class KerberosTicketCache {
  private tickets: CachedTicket[] = [];

  add(ticket: CachedTicket): void {
    this.tickets.push(ticket);
  }

  list(): readonly CachedTicket[] {
    return this.tickets;
  }

  /** The realm's own TGT (server principal `krbtgt/<REALM>`) — what a TGS exchange presents as its `PA-TGS-REQ` ticket. */
  getTgt(): CachedTicket | undefined {
    return this.tickets.find((t) => t.serverPrincipal.toLowerCase().startsWith('krbtgt/'));
  }

  clear(): void {
    this.tickets = [];
  }
}
