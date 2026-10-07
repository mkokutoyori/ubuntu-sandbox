import { encodeTLV, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';

export const KRB5_MECHANISM_OID = '1.2.840.113554.1.2.2';

export const TOKEN_ID_AP_REQ = 0x0100;
export const TOKEN_ID_AP_REP = 0x0200;
export const TOKEN_ID_ERROR = 0x0300;
export const TOKEN_ID_MIC = 0x0404;
export const TOKEN_ID_WRAP = 0x0504;

export const GSS_C_DELEG_FLAG = 0x01;
export const GSS_C_MUTUAL_FLAG = 0x02;
export const GSS_C_REPLAY_FLAG = 0x04;
export const GSS_C_SEQUENCE_FLAG = 0x08;
export const GSS_C_CONF_FLAG = 0x10;
export const GSS_C_INTEG_FLAG = 0x20;
export const GSS_C_TRANS_FLAG = 0x100;

const OBJECT_IDENTIFIER_TAG = 0x06;
const INITIAL_CONTEXT_TOKEN_TAG = 0x60;

function encodeOid(oid: string): Uint8Array {
  const arcs = oid.split('.').map(Number);
  const content: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const groups: number[] = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) groups.unshift((rest & 0x7f) | 0x80);
    content.push(...groups);
  }
  return encodeTLV('universal', OBJECT_IDENTIFIER_TAG, false, Uint8Array.from(content));
}

function decodeOid(content: Uint8Array): string {
  const arcs: number[] = [Math.floor(content[0] / 40), content[0] % 40];
  let value = 0;
  for (const byte of content.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join('.');
}

export function frameInitialContextToken(tokenId: number, body: Uint8Array): Uint8Array {
  const identifier = new Uint8Array([tokenId >> 8, tokenId & 0xff]);
  const oid = encodeOid(KRB5_MECHANISM_OID);
  const inner = new Uint8Array(oid.length + identifier.length + body.length);
  inner.set(oid, 0);
  inner.set(identifier, oid.length);
  inner.set(body, oid.length + identifier.length);
  return encodeTLV('application', 0, true, inner);
}

export interface InitialContextToken {
  readonly mechanism: string;
  readonly tokenId: number;
  readonly body: Uint8Array;
}

export function parseInitialContextToken(bytes: Uint8Array): InitialContextToken | null {
  if (bytes.length < 2 || bytes[0] !== INITIAL_CONTEXT_TOKEN_TAG) return null;
  try {
    const framed = parseTLV(bytes, 0);
    const oid = parseTLV(framed.content, 0);
    if (oid.tagNumber !== OBJECT_IDENTIFIER_TAG) return null;
    const afterOid = oid.nextOffset;
    if (framed.content.length < afterOid + 2) return null;
    return {
      mechanism: decodeOid(oid.content),
      tokenId: (framed.content[afterOid] << 8) | framed.content[afterOid + 1],
      body: framed.content.subarray(afterOid + 2),
    };
  } catch {
    return null;
  }
}
