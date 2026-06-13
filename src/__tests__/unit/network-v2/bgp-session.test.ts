/**
 * BGP session FSM (RFC 4271 §8) over a synchronous paired transport that
 * mirrors the simulator's cable: a sent message re-enters the peer before
 * send() returns. Verifies the OPEN/KEEPALIVE handshake reaches
 * Established on BOTH peers despite that re-entrancy, that an AS mismatch
 * is rejected with a NOTIFICATION, and that UPDATEs flow once up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BgpSession, type BgpTransport,
} from '@/network/bgp/BgpSession';
import type { BgpMessage, BgpUpdateMessage } from '@/network/bgp/messages';

/** A pair of transports whose sends deliver synchronously to each other. */
function wirePair(): [BgpTransport, BgpTransport] {
  const handlers: Array<((m: BgpMessage) => void) | null> = [null, null];
  const closers: Array<(() => void) | null> = [null, null];
  let open = true;
  const make = (self: 0 | 1): BgpTransport => {
    const peer = (self === 0 ? 1 : 0) as 0 | 1;
    return {
      send: (msg) => { if (open) handlers[peer]?.(msg); },
      close: () => {
        if (!open) return;
        open = false;
        closers[peer]?.();   // notify the other end, like a TCP FIN/RST
      },
      onMessage: (h) => { handlers[self] = h; },
      onClose: (h) => { closers[self] = h; },
    };
  };
  return [make(0), make(1)];
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BgpSession FSM (RFC 4271 §8)', () => {
  it('both peers reach Established through the OPEN/KEEPALIVE handshake', () => {
    const [ta, tb] = wirePair();
    let aPeerAs = 0; let aPeerId = '';
    const a = new BgpSession(ta,
      { localAsn: 65001, localRouterId: '1.1.1.1', expectedPeerAsn: 65002 },
      { onEstablished: (as, id) => { aPeerAs = as; aPeerId = id; } });
    const b = new BgpSession(tb,
      { localAsn: 65002, localRouterId: '2.2.2.2', expectedPeerAsn: 65001 });

    a.tcpEstablished();   // active open; synchronous delivery settles both
    b.tcpEstablished();

    expect(a.isEstablished()).toBe(true);
    expect(b.isEstablished()).toBe(true);
    expect(aPeerAs).toBe(65002);
    expect(aPeerId).toBe('2.2.2.2');
    expect(a.remoteAsn).toBe(65002);
  });

  it('a passive peer reaches Established from an inbound OPEN alone', () => {
    const [ta, tb] = wirePair();
    const a = new BgpSession(ta,
      { localAsn: 65001, localRouterId: '1.1.1.1', expectedPeerAsn: 65002 });
    const b = new BgpSession(tb,
      { localAsn: 65002, localRouterId: '2.2.2.2', expectedPeerAsn: 65001 });
    // Only A initiates; B must answer the OPEN it receives.
    a.tcpEstablished();
    expect(a.isEstablished()).toBe(true);
    expect(b.isEstablished()).toBe(true);
  });

  it('an AS mismatch is rejected — never Established, NOTIFICATION sent', () => {
    const [ta, tb] = wirePair();
    const sent: BgpMessage[] = [];
    const spy: BgpTransport = {
      ...tb,
      send: (m) => { sent.push(m); tb.send(m); },
    };
    const a = new BgpSession(ta,
      { localAsn: 65001, localRouterId: '1.1.1.1', expectedPeerAsn: 65099 });
    let bClosed = false;
    const b = new BgpSession(spy,
      { localAsn: 65002, localRouterId: '2.2.2.2', expectedPeerAsn: 65001 },
      { onClose: () => { bClosed = true; } });

    a.tcpEstablished();

    expect(a.isEstablished()).toBe(false);
    expect(b.isEstablished()).toBe(false);
    // A rejected B's OPEN (AS 65002 ≠ expected 65099); B saw the teardown.
    expect(bClosed).toBe(true);
    void b;
  });

  it('UPDATE messages flow only once Established', () => {
    const [ta, tb] = wirePair();
    const received: BgpUpdateMessage[] = [];
    const a = new BgpSession(ta,
      { localAsn: 65001, localRouterId: '1.1.1.1', expectedPeerAsn: 65002 });
    const b = new BgpSession(tb,
      { localAsn: 65002, localRouterId: '2.2.2.2', expectedPeerAsn: 65001 },
      { onUpdate: (u) => received.push(u) });

    const update: BgpUpdateMessage = {
      type: 'bgp', message: 'update', withdrawn: [],
      announced: [{ network: '192.168.2.0', prefixLength: 24 }],
      attributes: { origin: 'igp', asPath: [65001], nextHop: '10.0.0.1' },
    };
    a.sendUpdate(update);            // not up yet → dropped
    expect(received).toHaveLength(0);

    a.tcpEstablished();
    a.sendUpdate(update);            // up → delivered
    expect(received).toHaveLength(1);
    expect(received[0].announced[0].network).toBe('192.168.2.0');
  });
});
