/**
 * RDP — reactive event taxonomy (PRD-Windows-Server-Advanced.md §5 P23),
 * transverse to §5 P17: session establishment (`RdpServerHandler`) and
 * closure (`RdpSessionTable.logoff`) publish through this topic —
 * mirrors the established `kerberos.*`/`replication.*` convention (§5
 * P12). No graphical content is ever part of this payload, per §5 P17's
 * own scope boundary.
 */

export interface RdpSessionEstablishedPayload {
  deviceId: string;
  sessionId: number;
  userName: string;
  clientAddress: string;
}
export interface RdpSessionClosedPayload {
  deviceId: string;
  sessionId: number;
}

export type RdpDomainEvent =
  | { topic: 'rdp.session.established'; payload: RdpSessionEstablishedPayload }
  | { topic: 'rdp.session.closed'; payload: RdpSessionClosedPayload };
