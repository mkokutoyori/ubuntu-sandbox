/**
 * EAP (RFC 3748) — the packet types and wire codec needed for EAP-MD5
 * relayed inside RADIUS (RFC 3579 §3.2, EAP-Message attribute) and over
 * EAPOL (IEEE 802.1X, `src/network/dot1x/`). Lives under `radius/` because
 * RADIUS is what actually carries and terminates the EAP conversation —
 * 802.1X is just one lower-layer transport for it — so `dot1x/types.ts`
 * imports these rather than defining its own copy.
 */
import type { NetworkPdu } from '@/network/core/NetworkPdu';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import { computeChapResponse, verifyChapResponse } from './passwords';

/** RFC 2865 §5.61 NAS-Port-Type value for a wired 802.1X port (RFC 3580 §3.1 recommends this). */
export const NAS_PORT_TYPE_ETHERNET = 15;

export type EapCode = 'request' | 'response' | 'success' | 'failure';

export const EAP_CODE: Record<EapCode, number> = {
  request: 1,
  response: 2,
  success: 3,
  failure: 4,
};

const EAP_CODE_BY_NUMBER = new Map<number, EapCode>(
  (Object.keys(EAP_CODE) as EapCode[]).map((k) => [EAP_CODE[k], k]),
);

export type EapType =
  | 'identity'
  | 'notification'
  | 'nak'
  | 'md5-challenge'
  | 'tls'
  | 'peap';

export const EAP_TYPE: Record<EapType, number> = {
  identity: 1,
  notification: 2,
  nak: 3,
  'md5-challenge': 4,
  tls: 13,
  peap: 25,
};

const EAP_TYPE_BY_NUMBER = new Map<number, EapType>(
  (Object.keys(EAP_TYPE) as EapType[]).map((k) => [EAP_TYPE[k], k]),
);

export interface EapPacket extends NetworkPdu {
  type: 'eap';
  code: EapCode;
  identifier: number;
  eapType?: EapType;
  /** Identity string (Type 1). */
  payload?: string;
  /** MD5-Challenge (Type 4) Request: the challenge Value, hex-encoded. */
  md5Challenge?: string;
  /** MD5-Challenge (Type 4) Response: the response Value, hex-encoded. */
  md5Response?: string;
}

/** Encode an `EapPacket` to its real RFC 3748 §4 wire bytes. */
export function encodeEapPacket(eap: EapPacket): Uint8Array {
  const code = EAP_CODE[eap.code];
  const hasType = eap.code === 'request' || eap.code === 'response';
  let typeData = new Uint8Array(0);
  if (hasType && eap.eapType === 'identity') {
    typeData = utf8ToBytes(eap.payload ?? '');
  } else if (hasType && eap.eapType === 'md5-challenge') {
    const value = hexToBytes(eap.code === 'request' ? (eap.md5Challenge ?? '') : (eap.md5Response ?? ''));
    typeData = new Uint8Array(1 + value.length);
    typeData[0] = value.length;
    typeData.set(value, 1);
  }
  const length = 4 + (hasType ? 1 + typeData.length : 0);
  const out = new Uint8Array(length);
  out[0] = code;
  out[1] = eap.identifier & 0xff;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  if (hasType) {
    out[4] = EAP_TYPE[eap.eapType!];
    out.set(typeData, 5);
  }
  return out;
}

/** Decode wire bytes into an `EapPacket`; null if malformed. */
export function decodeEapPacket(bytes: Uint8Array): EapPacket | null {
  if (bytes.length < 4) return null;
  const code = EAP_CODE_BY_NUMBER.get(bytes[0]);
  if (!code) return null;
  const identifier = bytes[1];
  const length = (bytes[2] << 8) | bytes[3];
  if (length < 4 || length > bytes.length) return null;
  if (code === 'success' || code === 'failure') return { type: 'eap', code, identifier };
  if (length < 5) return null;
  const eapType = EAP_TYPE_BY_NUMBER.get(bytes[4]);
  const typeData = bytes.subarray(5, length);
  if (eapType === 'identity') {
    return { type: 'eap', code, identifier, eapType, payload: bytesToUtf8(typeData) };
  }
  if (eapType === 'md5-challenge') {
    if (typeData.length < 1) return null;
    const valueSize = typeData[0];
    const value = bytesToHex(typeData.subarray(1, 1 + valueSize));
    return code === 'request'
      ? { type: 'eap', code, identifier, eapType, md5Challenge: value }
      : { type: 'eap', code, identifier, eapType, md5Response: value };
  }
  return { type: 'eap', code, identifier, eapType };
}

export function eapPacketToWireHex(eap: EapPacket): string {
  return bytesToHex(encodeEapPacket(eap));
}

export function eapPacketFromWireHex(hex: string): EapPacket | null {
  return decodeEapPacket(hexToBytes(hex));
}

/**
 * EAP-MD5 (RFC 3748 §4.2) response: MD5(EAP-Identifier + Password + Challenge)
 * — structurally identical to PPP CHAP (RFC 1994), so this just wraps the
 * CHAP math with hex in/out for callers working with EAP packets.
 */
export function computeEapMd5Response(eapIdentifier: number, password: string, challengeHex: string): string {
  return bytesToHex(computeChapResponse(eapIdentifier, password, hexToBytes(challengeHex)));
}

export function verifyEapMd5Response(
  eapIdentifier: number, responseHex: string, password: string, challengeHex: string,
): boolean {
  return verifyChapResponse(eapIdentifier, hexToBytes(responseHex), password, hexToBytes(challengeHex));
}
