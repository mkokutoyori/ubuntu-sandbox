/**
 * PEAP inner authentication — a real nested EAP conversation (Identity →
 * MD5-Challenge → Success/Failure) carried as tunneled bytes, reusing
 * `eap.ts`'s own wire codec and `passwords.ts`'s CHAP/MD5 math verbatim
 * via `eap.ts`'s existing wrappers. Real-world PEAP deployments
 * overwhelmingly nest EAP-MSCHAPv2 instead — not implemented here, since
 * EAP-MSCHAPv2 (RFC 2759's EAP encapsulation, EAP-Type 26) is a distinct
 * wire format from the RADIUS-VSA MS-CHAPv2 this project already has
 * (`mschapv2.ts`) and would need its own framing. EAP-MD5 is a real,
 * already-tested EAP method, and PEAP's inner-method framework is
 * type-agnostic — nesting it here is protocol-legitimate, just not the
 * most common deployment choice.
 */
import {
  type EapPacket, encodeEapPacket, decodeEapPacket,
  computeEapMd5Response, verifyEapMd5Response,
} from '../eap';
import { randomOpaqueToken } from '../authenticators';
import type { InnerAuthServer, InnerAuthPeer } from './InnerAuth';
import type { RadiusUser } from '../types';

export class PeapMd5InnerAuthServer implements InnerAuthServer {
  private identifier = 1;
  private challengeHex: string | null = null;
  private username: string | null = null;

  constructor(private readonly lookupUser: (username: string) => RadiusUser | undefined) {}

  start(): Uint8Array {
    const req: EapPacket = { type: 'eap', code: 'request', identifier: this.identifier, eapType: 'identity', payload: '' };
    return encodeEapPacket(req);
  }

  handle(incoming: Uint8Array): { next: Uint8Array | null; result: 'accept' | 'reject' | null } {
    const eap = decodeEapPacket(incoming);
    if (!eap) return { next: null, result: 'reject' };

    if (eap.eapType === 'identity') {
      this.username = eap.payload ?? '';
      this.challengeHex = randomOpaqueToken(16);
      this.identifier = (eap.identifier + 1) & 0xff;
      const req: EapPacket = {
        type: 'eap', code: 'request', identifier: this.identifier,
        eapType: 'md5-challenge', md5Challenge: this.challengeHex,
      };
      return { next: encodeEapPacket(req), result: null };
    }

    if (eap.eapType === 'md5-challenge' && this.challengeHex !== null && this.username !== null) {
      const user = this.lookupUser(this.username);
      const accepted = !!user && !!eap.md5Response
        && verifyEapMd5Response(eap.identifier, eap.md5Response, user.password, this.challengeHex);
      return { next: null, result: accepted ? 'accept' : 'reject' };
    }

    return { next: null, result: 'reject' };
  }
}

export class PeapMd5InnerAuthPeer implements InnerAuthPeer {
  constructor(private readonly identity: string, private readonly password: string) {}

  handle(incoming: Uint8Array): { next: Uint8Array; result: 'success' | 'failure' | null } {
    const eap = decodeEapPacket(incoming);
    if (!eap) {
      const nak: EapPacket = { type: 'eap', code: 'response', identifier: 0, eapType: 'nak' };
      return { next: encodeEapPacket(nak), result: 'failure' };
    }
    if (eap.eapType === 'identity') {
      const resp: EapPacket = { type: 'eap', code: 'response', identifier: eap.identifier, eapType: 'identity', payload: this.identity };
      return { next: encodeEapPacket(resp), result: null };
    }
    if (eap.eapType === 'md5-challenge' && eap.md5Challenge) {
      const responseHex = computeEapMd5Response(eap.identifier, this.password, eap.md5Challenge);
      const resp: EapPacket = { type: 'eap', code: 'response', identifier: eap.identifier, eapType: 'md5-challenge', md5Response: responseHex };
      return { next: encodeEapPacket(resp), result: null };
    }
    const resp: EapPacket = { type: 'eap', code: 'response', identifier: eap.identifier, eapType: 'nak' };
    return { next: encodeEapPacket(resp), result: null };
  }
}
