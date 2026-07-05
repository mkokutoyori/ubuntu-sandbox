/**
 * PRD-QUIC.md §5 P11 — multiple Connection IDs (RFC 9000 §19.15/§19.16):
 * local issuance with sequential sequence numbers, peer-issued CID
 * tracking, retirement (both directions) including retire_prior_to, and
 * rotation of the active outgoing CID — deliberately without active
 * connection migration (§2.2).
 */
import { describe, it, expect } from 'vitest';
import { ConnectionIdManager } from '@/network/quic/ConnectionIdManager';

const token = (n: number) => new Uint8Array(16).fill(n);

describe('Local connection ID issuance', () => {
  it('issues sequential sequence numbers and the correct frame shape', () => {
    const mgr = new ConnectionIdManager();
    const f1 = mgr.issueLocal('aaaa', token(1));
    const f2 = mgr.issueLocal('bbbb', token(2));
    expect(f1).toEqual({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'aaaa', statelessResetToken: token(1) });
    expect(f2).toMatchObject({ sequenceNumber: 1, connectionId: 'bbbb' });
    expect(mgr.countLocalActive()).toBe(2);
  });

  it('a RETIRE_CONNECTION_ID from the peer removes the matching local entry', () => {
    const mgr = new ConnectionIdManager();
    mgr.issueLocal('aaaa', token(1));
    mgr.issueLocal('bbbb', token(2));
    mgr.onRetireConnectionId({ type: 'RETIRE_CONNECTION_ID', sequenceNumber: 0 });
    expect(mgr.countLocalActive()).toBe(1);
  });

  it('retiring an unknown sequence number is a no-op', () => {
    const mgr = new ConnectionIdManager();
    mgr.issueLocal('aaaa', token(1));
    mgr.onRetireConnectionId({ type: 'RETIRE_CONNECTION_ID', sequenceNumber: 99 });
    expect(mgr.countLocalActive()).toBe(1);
  });
});

describe('Peer-issued connection IDs', () => {
  it('the first received connection ID becomes the active one', () => {
    const mgr = new ConnectionIdManager();
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'peer-a', statelessResetToken: token(1) });
    expect(mgr.getActiveConnectionId()).toBe('peer-a');
  });

  it('a later received connection ID does not replace the active one', () => {
    const mgr = new ConnectionIdManager();
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'peer-a', statelessResetToken: token(1) });
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 1, retirePriorTo: 0, connectionId: 'peer-b', statelessResetToken: token(2) });
    expect(mgr.getActiveConnectionId()).toBe('peer-a');
    expect(mgr.countPeerIssued()).toBe(2);
  });

  it('retire_prior_to marks older peer-issued sequence numbers for retirement', () => {
    const mgr = new ConnectionIdManager();
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'peer-a', statelessResetToken: token(1) });
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 1, retirePriorTo: 1, connectionId: 'peer-b', statelessResetToken: token(2) });
    expect(mgr.pendingRetirements()).toEqual([0]);
  });

  it('confirmRetired removes the entry and re-picks the active CID if it was retired', () => {
    const mgr = new ConnectionIdManager();
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'peer-a', statelessResetToken: token(1) });
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 1, retirePriorTo: 1, connectionId: 'peer-b', statelessResetToken: token(2) });
    expect(mgr.getActiveConnectionId()).toBe('peer-a');
    for (const seq of mgr.pendingRetirements()) mgr.confirmRetired(seq);
    expect(mgr.getActiveConnectionId()).toBe('peer-b');
    expect(mgr.countPeerIssued()).toBe(1);
  });
});

describe('Rotation of the active outgoing connection ID (no active migration)', () => {
  it('rotates to a different available peer-issued CID', () => {
    const mgr = new ConnectionIdManager();
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'peer-a', statelessResetToken: token(1) });
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 1, retirePriorTo: 0, connectionId: 'peer-b', statelessResetToken: token(2) });
    const rotated = mgr.rotateActiveConnectionId();
    expect(rotated).toBe('peer-b');
    expect(mgr.getActiveConnectionId()).toBe('peer-b');
  });

  it('rotation is a no-op when only one connection ID is available', () => {
    const mgr = new ConnectionIdManager();
    mgr.receiveNewConnectionId({ type: 'NEW_CONNECTION_ID', sequenceNumber: 0, retirePriorTo: 0, connectionId: 'peer-a', statelessResetToken: token(1) });
    expect(mgr.rotateActiveConnectionId()).toBe('peer-a');
  });
});
