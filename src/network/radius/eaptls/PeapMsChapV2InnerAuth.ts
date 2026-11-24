import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import { type EapPacket, encodeEapPacket, decodeEapPacket } from '../eap';
import { randomOpaqueToken } from '../authenticators';
import { generateNtResponse, generateAuthenticatorResponse } from '../mschapv2';
import type { InnerAuthServer, InnerAuthPeer } from './InnerAuth';
import type { RadiusUser } from '../types';

const OP_CHALLENGE = 1;
const OP_RESPONSE = 2;
const OP_SUCCESS = 3;
const OP_FAILURE = 4;
const SERVER_NAME = 'freeradius';

function frame(opCode: number, mschapId: number, body: Uint8Array): string {
  const out = new Uint8Array(4 + body.length);
  out[0] = opCode;
  out[1] = mschapId & 0xff;
  out[2] = ((4 + body.length) >> 8) & 0xff;
  out[3] = (4 + body.length) & 0xff;
  out.set(body, 4);
  return bytesToHex(out);
}

function parts(hex: string): { opCode: number; mschapId: number; body: Uint8Array } | null {
  const bytes = hexToBytes(hex);
  if (bytes.length < 4) return null;
  return { opCode: bytes[0], mschapId: bytes[1], body: bytes.subarray(4, Math.max(4, Math.min(bytes.length, (bytes[2] << 8) | bytes[3]))) };
}

const request = (identifier: number, data: string): EapPacket => ({ type: 'eap', code: 'request', identifier, eapType: 'mschapv2', mschapv2Data: data });
const response = (identifier: number, data: string): EapPacket => ({ type: 'eap', code: 'response', identifier, eapType: 'mschapv2', mschapv2Data: data });

export class PeapMsChapV2InnerAuthServer implements InnerAuthServer {
  private identifier = 1;
  private mschapId = 0;
  private username: string | null = null;
  private authChallenge: Uint8Array | null = null;
  private state: 'identity' | 'challenge' | 'success' | 'failure' = 'identity';

  constructor(private readonly lookupUser: (username: string) => RadiusUser | undefined) {}

  authenticatedUser(): string | null { return this.state === 'success' ? this.username : null; }

  start(): Uint8Array {
    return encodeEapPacket({ type: 'eap', code: 'request', identifier: this.identifier, eapType: 'identity', payload: '' });
  }

  handle(incoming: Uint8Array): { next: Uint8Array | null; result: 'accept' | 'reject' | null } {
    const eap = decodeEapPacket(incoming);
    if (!eap) return { next: null, result: 'reject' };
    if (this.state === 'identity' && eap.eapType === 'identity') {
      this.username = eap.payload ?? '';
      this.authChallenge = hexToBytes(randomOpaqueToken(16));
      this.identifier = (eap.identifier + 1) & 0xff;
      this.state = 'challenge';
      const body = new Uint8Array(1 + 16 + SERVER_NAME.length);
      body[0] = 16;
      body.set(this.authChallenge, 1);
      body.set(utf8ToBytes(SERVER_NAME), 17);
      return { next: encodeEapPacket(request(this.identifier, frame(OP_CHALLENGE, this.mschapId, body))), result: null };
    }
    const framed = eap.eapType === 'mschapv2' ? parts(eap.mschapv2Data ?? '') : null;
    if (framed === null) return { next: null, result: 'reject' };
    if (this.state === 'challenge' && framed.opCode === OP_RESPONSE && this.username !== null && this.authChallenge !== null && framed.body.length >= 50) {
      const peerChallenge = framed.body.subarray(1, 17);
      const ntResponse = framed.body.subarray(25, 49);
      const user = this.lookupUser(this.username);
      const expected = user === undefined ? null : generateNtResponse(this.authChallenge, peerChallenge, this.username, user.password);
      const accepted = expected !== null && bytesToHex(expected) === bytesToHex(ntResponse);
      this.identifier = (this.identifier + 1) & 0xff;
      if (accepted) {
        this.state = 'success';
        const message = `${generateAuthenticatorResponse(user!.password, ntResponse, peerChallenge, this.authChallenge, this.username)} M=Authentication succeeded`;
        return { next: encodeEapPacket(request(this.identifier, frame(OP_SUCCESS, framed.mschapId, utf8ToBytes(message)))), result: null };
      }
      this.state = 'failure';
      const message = `E=691 R=0 C=${bytesToHex(this.authChallenge).toUpperCase()} V=3 M=Authentication failed`;
      return { next: encodeEapPacket(request(this.identifier, frame(OP_FAILURE, framed.mschapId, utf8ToBytes(message)))), result: null };
    }
    if (this.state === 'success' && framed.opCode === OP_SUCCESS) return { next: null, result: 'accept' };
    if (this.state === 'failure' && framed.opCode === OP_FAILURE) return { next: null, result: 'reject' };
    return { next: null, result: 'reject' };
  }
}

export class PeapMsChapV2InnerAuthPeer implements InnerAuthPeer {
  private authChallenge: Uint8Array | null = null;
  private peerChallenge: Uint8Array | null = null;
  private ntResponse: Uint8Array | null = null;

  constructor(private readonly identity: string, private readonly password: string) {}

  handle(incoming: Uint8Array): { next: Uint8Array; result: 'success' | 'failure' | null } {
    const eap = decodeEapPacket(incoming);
    if (!eap) return { next: encodeEapPacket({ type: 'eap', code: 'response', identifier: 0, eapType: 'nak' }), result: 'failure' };
    if (eap.eapType === 'identity') {
      return { next: encodeEapPacket({ type: 'eap', code: 'response', identifier: eap.identifier, eapType: 'identity', payload: this.identity }), result: null };
    }
    const framed = eap.eapType === 'mschapv2' ? parts(eap.mschapv2Data ?? '') : null;
    if (framed === null) return { next: encodeEapPacket({ type: 'eap', code: 'response', identifier: eap.identifier, eapType: 'nak' }), result: null };
    if (framed.opCode === OP_CHALLENGE && framed.body.length >= 17) {
      this.authChallenge = framed.body.slice(1, 17);
      this.peerChallenge = hexToBytes(randomOpaqueToken(16));
      this.ntResponse = generateNtResponse(this.authChallenge, this.peerChallenge, this.identity, this.password);
      const body = new Uint8Array(1 + 16 + 8 + 24 + 1 + this.identity.length);
      body[0] = 49;
      body.set(this.peerChallenge, 1);
      body.set(this.ntResponse, 25);
      body.set(utf8ToBytes(this.identity), 50);
      return { next: encodeEapPacket(response(eap.identifier, frame(OP_RESPONSE, framed.mschapId, body))), result: null };
    }
    if (framed.opCode === OP_SUCCESS && this.authChallenge !== null && this.peerChallenge !== null && this.ntResponse !== null) {
      const expected = generateAuthenticatorResponse(this.password, this.ntResponse, this.peerChallenge, this.authChallenge, this.identity);
      const verified = bytesToUtf8(framed.body).startsWith(expected);
      return { next: encodeEapPacket(response(eap.identifier, frame(verified ? OP_SUCCESS : OP_FAILURE, framed.mschapId, new Uint8Array(0)))), result: verified ? 'success' : 'failure' };
    }
    if (framed.opCode === OP_FAILURE) {
      return { next: encodeEapPacket(response(eap.identifier, frame(OP_FAILURE, framed.mschapId, new Uint8Array(0)))), result: 'failure' };
    }
    return { next: encodeEapPacket({ type: 'eap', code: 'response', identifier: eap.identifier, eapType: 'nak' }), result: null };
  }
}
