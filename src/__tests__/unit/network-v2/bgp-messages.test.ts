/**
 * BGP-4 wire message vocabulary (RFC 4271 §4). Pure data + the structural
 * guard that admits payloads arriving on the TCP/179 stream.
 */
import { describe, it, expect } from 'vitest';
import {
  isBgpMessage, keepalive,
  BGP_PORT, BGP_VERSION, BGP_DEFAULT_HOLD_SEC, BGP_DEFAULT_KEEPALIVE_SEC,
  BGP_ERROR, BGP_OPEN_ERROR,
  type BgpOpenMessage, type BgpUpdateMessage, type BgpNotificationMessage,
} from '@/network/bgp/messages';

describe('BGP messages (RFC 4271 §4)', () => {
  it('exposes the well-known transport constants', () => {
    expect(BGP_PORT).toBe(179);
    expect(BGP_VERSION).toBe(4);
    expect(BGP_DEFAULT_HOLD_SEC).toBe(90);
    expect(BGP_DEFAULT_KEEPALIVE_SEC).toBe(30);
  });

  it('keepalive() builds a header-only KEEPALIVE', () => {
    expect(keepalive()).toEqual({ type: 'bgp', message: 'keepalive' });
  });

  it('isBgpMessage admits each of the four message types', () => {
    const open: BgpOpenMessage = {
      type: 'bgp', message: 'open', version: 4, asn: 65001,
      holdTimeSec: 90, bgpIdentifier: '1.1.1.1',
    };
    const update: BgpUpdateMessage = {
      type: 'bgp', message: 'update', withdrawn: [],
      announced: [{ network: '192.168.1.0', prefixLength: 24 }],
      attributes: { origin: 'igp', asPath: [65001], nextHop: '10.0.0.1' },
    };
    const notif: BgpNotificationMessage = {
      type: 'bgp', message: 'notification',
      errorCode: BGP_ERROR.OPEN_MESSAGE,
      errorSubcode: BGP_OPEN_ERROR.BAD_PEER_AS,
    };
    expect(isBgpMessage(open)).toBe(true);
    expect(isBgpMessage(update)).toBe(true);
    expect(isBgpMessage(keepalive())).toBe(true);
    expect(isBgpMessage(notif)).toBe(true);
  });

  it('isBgpMessage rejects foreign payloads', () => {
    expect(isBgpMessage(null)).toBe(false);
    expect(isBgpMessage({ type: 'eigrp', opcode: 'hello' })).toBe(false);
    expect(isBgpMessage({ type: 'bgp', message: 'hello' })).toBe(false);
    expect(isBgpMessage('keepalive')).toBe(false);
  });

  it('error code/subcode tables match RFC 4271 §6', () => {
    expect(BGP_ERROR.HOLD_TIMER_EXPIRED).toBe(4);
    expect(BGP_ERROR.CEASE).toBe(6);
    expect(BGP_OPEN_ERROR.BAD_PEER_AS).toBe(2);
    expect(BGP_OPEN_ERROR.UNSUPPORTED_VERSION).toBe(1);
  });
});
