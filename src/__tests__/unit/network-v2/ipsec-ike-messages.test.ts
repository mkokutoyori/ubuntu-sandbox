/**
 * IKE wire message vocabulary (UDP/500). Pure data + the structural guard
 * that distinguishes IKE negotiation messages from DPD notifies on the
 * same port. This is the foundation for moving IKE negotiation off
 * god-mode (direct peer-engine reads) onto real datagrams over the cable.
 */
import { describe, it, expect } from 'vitest';
import {
  isIkeMessage,
  type IkeOfferMessage, type IkeAcceptMessage, type IkeRejectMessage,
  type IsakmpDpdMessage,
} from '@/network/ipsec/IPSecTypes';

const offer: IkeOfferMessage = {
  type: 'ike', step: 'offer', version: 1, exchangeMode: 'main',
  initiatorSpi: '0x1111AAAA', identity: '10.0.12.1', pskProof: 'proof-abc',
  policies: [{ priority: 10, encryption: 'aes 256', hash: 'sha256', group: 14, auth: 'pre-share', lifetime: 86400 }],
  transforms: [{ name: 'TSET', transforms: ['esp-aes-256', 'esp-sha256-hmac'], mode: 'tunnel' }],
  lifetimeSec: 3600, lifetimeKB: 4608000, ipsecSpiIn: 0xABCDEF, natTHint: false,
};

const accept: IkeAcceptMessage = {
  type: 'ike', step: 'accept', responderSpi: '0x2222BBBB', pskProof: 'proof-abc',
  chosenPolicy: offer.policies[0], chosenTransform: offer.transforms[0],
  ipsecSpiIn: 0x123456, lifetimeSec: 3600, lifetimeKB: 4608000, natT: false,
};

const reject: IkeRejectMessage = { type: 'ike', step: 'reject', reason: 'No matching policy' };

const dpd: IsakmpDpdMessage = { type: 'isakmp-dpd', notify: 'R-U-THERE', seq: 1 };

describe('IKE wire messages', () => {
  it('isIkeMessage admits offer / accept / reject', () => {
    expect(isIkeMessage(offer)).toBe(true);
    expect(isIkeMessage(accept)).toBe(true);
    expect(isIkeMessage(reject)).toBe(true);
  });

  it('isIkeMessage rejects DPD notifies and foreign payloads (same UDP/500)', () => {
    expect(isIkeMessage(dpd)).toBe(false);
    expect(isIkeMessage(null)).toBe(false);
    expect(isIkeMessage({ type: 'ike', step: 'hello' })).toBe(false);
    expect(isIkeMessage('offer')).toBe(false);
  });

  it('an offer carries both Phase 1 policies and Phase 2 transforms', () => {
    expect(offer.policies[0].encryption).toBe('aes 256');
    expect(offer.transforms[0].transforms).toContain('esp-aes-256');
    expect(offer.ipsecSpiIn).toBeGreaterThan(0);
  });
});
