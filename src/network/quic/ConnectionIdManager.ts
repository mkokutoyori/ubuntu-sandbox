import type { QuicFrame } from './frames';

export interface ConnectionIdEntry {
  sequenceNumber: number;
  connectionId: string;
  statelessResetToken: Uint8Array;
}

/**
 * Tracks the two independent sets of connection IDs a QUIC endpoint keeps
 * (RFC 9000 §5.1.1/§5.1.2, §19.15/§19.16): the ones this endpoint has
 * issued for the peer to use as destination CID, and the ones the peer
 * has issued for this endpoint to use. Supports rotating which
 * peer-issued CID is currently in use — deliberately without active
 * connection migration (no reaction to a change in the peer's UDP
 * address), which PRD-QUIC.md §2.2 excludes.
 */
export class ConnectionIdManager {
  private localIssued: ConnectionIdEntry[] = [];
  private localNextSequence = 0;

  private peerIssued = new Map<number, ConnectionIdEntry>();
  private peerRetiredPriorTo = 0;
  private activeConnectionId: string | null = null;

  /** Issues a new local connection ID for the peer to use, returning the NEW_CONNECTION_ID frame to send. */
  issueLocal(connectionId: string, statelessResetToken: Uint8Array): QuicFrame {
    const sequenceNumber = this.localNextSequence++;
    this.localIssued.push({ sequenceNumber, connectionId, statelessResetToken });
    return { type: 'NEW_CONNECTION_ID', sequenceNumber, retirePriorTo: 0, connectionId, statelessResetToken };
  }

  /** The peer retiring one of our issued connection IDs. */
  onRetireConnectionId(frame: Extract<QuicFrame, { type: 'RETIRE_CONNECTION_ID' }>): void {
    this.localIssued = this.localIssued.filter((e) => e.sequenceNumber !== frame.sequenceNumber);
  }

  countLocalActive(): number {
    return this.localIssued.length;
  }

  /** Registers a connection ID the peer issued to us. The first one received becomes the active outgoing CID. */
  receiveNewConnectionId(frame: Extract<QuicFrame, { type: 'NEW_CONNECTION_ID' }>): void {
    this.peerIssued.set(frame.sequenceNumber, {
      sequenceNumber: frame.sequenceNumber, connectionId: frame.connectionId, statelessResetToken: frame.statelessResetToken,
    });
    if (this.activeConnectionId === null) this.activeConnectionId = frame.connectionId;
    if (frame.retirePriorTo > this.peerRetiredPriorTo) this.peerRetiredPriorTo = frame.retirePriorTo;
  }

  /** Peer-issued sequence numbers that must now be retired per the highest retire_prior_to seen. */
  pendingRetirements(): number[] {
    return [...this.peerIssued.keys()].filter((seq) => seq < this.peerRetiredPriorTo);
  }

  /** Call once a RETIRE_CONNECTION_ID has actually been sent for this sequence number. */
  confirmRetired(sequenceNumber: number): void {
    const entry = this.peerIssued.get(sequenceNumber);
    this.peerIssued.delete(sequenceNumber);
    if (entry && entry.connectionId === this.activeConnectionId) this.activeConnectionId = this.pickAnyAvailable();
  }

  private pickAnyAvailable(): string | null {
    const first = this.peerIssued.values().next();
    return first.done ? null : first.value.connectionId;
  }

  getActiveConnectionId(): string | null {
    return this.activeConnectionId;
  }

  /** Rotates to a different, not-yet-retired peer-issued connection ID (no address migration). */
  rotateActiveConnectionId(): string | null {
    const candidates = [...this.peerIssued.values()].filter((e) => e.connectionId !== this.activeConnectionId);
    if (candidates.length === 0) return this.activeConnectionId;
    this.activeConnectionId = candidates[0].connectionId;
    return this.activeConnectionId;
  }

  countPeerIssued(): number {
    return this.peerIssued.size;
  }
}
