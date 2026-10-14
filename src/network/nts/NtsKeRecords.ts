export const NKE_PORT = 4460;
export const NKE_ALPN = 'ntske/1';
export const NKE_EXPORTER_LABEL = 'EXPORTER-network-time-security';
export const NKE_NEXT_PROTOCOL_NTPV4 = 0;
export const AEAD_AES_SIV_CMAC_256 = 15;
export const NKE_MAX_MESSAGE_LENGTH = 16384;
export const NKE_MAX_RECORD_BODY_LENGTH = 256;
export const NKE_MAX_COOKIES = 8;
export const NKE_MAX_COOKIE_LENGTH = 256;

export const NKE_RECORD = {
  END_OF_MESSAGE: 0, NEXT_PROTOCOL: 1, ERROR: 2, WARNING: 3, AEAD_ALGORITHM: 4, COOKIE: 5,
  NTPV4_SERVER_NEGOTIATION: 6, NTPV4_PORT_NEGOTIATION: 7,
} as const;

export const NKE_ERROR = { UNRECOGNIZED_CRITICAL_RECORD: 0, BAD_REQUEST: 1, INTERNAL_SERVER_ERROR: 2 } as const;

export interface KeRecord {
  readonly critical: boolean;
  readonly type: number;
  readonly body: Uint8Array;
}

export function exporterContext(aead: number, direction: 'c2s' | 's2c'): Uint8Array {
  return Uint8Array.of(0, 0, (aead >> 8) & 0xff, aead & 0xff, direction === 'c2s' ? 0 : 1);
}

export function aeadKeyLength(aead: number): number {
  return aead === AEAD_AES_SIV_CMAC_256 ? 32 : 0;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

export function encodeRecords(records: readonly KeRecord[]): Uint8Array {
  let total = 0;
  for (const record of records) total += 4 + record.body.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const record of records) {
    out.set(u16((record.critical ? 0x8000 : 0) | record.type), at);
    out.set(u16(record.body.length), at + 2);
    out.set(record.body, at + 4);
    at += 4 + record.body.length;
  }
  return out;
}

export function decodeRecords(bytes: Uint8Array): KeRecord[] | null {
  const records: KeRecord[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return null;
    const word = (bytes[at] << 8) | bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (at + 4 + length > bytes.length) return null;
    records.push({ critical: (word & 0x8000) !== 0, type: word & 0x7fff, body: bytes.slice(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return records;
}

export function endOfMessage(records: readonly KeRecord[]): boolean {
  return records.length > 0 && records[records.length - 1].type === NKE_RECORD.END_OF_MESSAGE;
}

export function buildClientRequest(algorithms: readonly number[] = [AEAD_AES_SIV_CMAC_256]): Uint8Array {
  return encodeRecords([
    { critical: true, type: NKE_RECORD.NEXT_PROTOCOL, body: u16(NKE_NEXT_PROTOCOL_NTPV4) },
    { critical: true, type: NKE_RECORD.AEAD_ALGORITHM, body: Uint8Array.from(algorithms.flatMap((a) => [...u16(a)])) },
    { critical: true, type: NKE_RECORD.END_OF_MESSAGE, body: new Uint8Array(0) },
  ]);
}

export interface KeResponse {
  readonly aead: number;
  readonly cookies: Uint8Array[];
  readonly server: string | null;
  readonly port: number | null;
}

export type KeResponseResult = { ok: true; response: KeResponse } | { ok: false; reason: string };

export function parseServerResponse(records: readonly KeRecord[]): KeResponseResult {
  let nextProtocol = -1;
  let aead = -1;
  let server: string | null = null;
  let port: number | null = null;
  const cookies: Uint8Array[] = [];
  for (const record of records) {
    if (record.body.length > NKE_MAX_RECORD_BODY_LENGTH) {
      if (record.critical) return { ok: false, reason: 'critical record too long' };
      continue;
    }
    switch (record.type) {
      case NKE_RECORD.END_OF_MESSAGE:
        break;
      case NKE_RECORD.NEXT_PROTOCOL:
        if (!record.critical || record.body.length !== 2 || ((record.body[0] << 8) | record.body[1]) !== NKE_NEXT_PROTOCOL_NTPV4) {
          return { ok: false, reason: 'unexpected next protocol' };
        }
        nextProtocol = NKE_NEXT_PROTOCOL_NTPV4;
        break;
      case NKE_RECORD.AEAD_ALGORITHM: {
        const value = record.body.length === 2 ? (record.body[0] << 8) | record.body[1] : -1;
        if (aeadKeyLength(value) <= 0) return { ok: false, reason: 'unexpected AEAD algorithm' };
        aead = value;
        break;
      }
      case NKE_RECORD.ERROR:
        return { ok: false, reason: record.body.length === 2 ? `server error ${(record.body[0] << 8) | record.body[1]}` : 'server error' };
      case NKE_RECORD.WARNING:
        return { ok: false, reason: 'server warning' };
      case NKE_RECORD.COOKIE:
        if (record.body.length >= 1 && record.body.length <= NKE_MAX_COOKIE_LENGTH && record.body.length % 4 === 0
          && cookies.length < NKE_MAX_COOKIES) cookies.push(record.body);
        break;
      case NKE_RECORD.NTPV4_SERVER_NEGOTIATION: {
        const name = String.fromCharCode(...record.body);
        if (record.body.length < 1 || !/^[\x21-\x7e]+$/.test(name)) return { ok: false, reason: 'invalid server name' };
        server = name;
        break;
      }
      case NKE_RECORD.NTPV4_PORT_NEGOTIATION:
        if (record.body.length !== 2) return { ok: false, reason: 'invalid port' };
        port = (record.body[0] << 8) | record.body[1];
        break;
      default:
        if (record.critical) return { ok: false, reason: 'unknown critical record' };
    }
  }
  if (cookies.length === 0 || nextProtocol !== NKE_NEXT_PROTOCOL_NTPV4 || aead < 0) return { ok: false, reason: 'incomplete response' };
  return { ok: true, response: { aead, cookies, server, port } };
}

export interface KeServerPolicy {
  readonly ntpPort: number;
  readonly ntpServer: string | null;
  readonly makeCookie: (aead: number, c2s: Uint8Array, s2c: Uint8Array) => Uint8Array;
  readonly deriveKeys: (aead: number) => { c2s: Uint8Array; s2c: Uint8Array } | null;
}

export function buildServerResponse(requestRecords: readonly KeRecord[], policy: KeServerPolicy): Uint8Array {
  let nextProtocolRecords = 0;
  let aeadRecords = 0;
  let nextProtocolValues = 0;
  let aeadValues = 0;
  let nextProtocol = -1;
  let aead = -1;
  let error = -1;
  for (const record of requestRecords) {
    if (error >= 0) break;
    if (record.type === NKE_RECORD.END_OF_MESSAGE) continue;
    switch (record.type) {
      case NKE_RECORD.NEXT_PROTOCOL:
        if (!record.critical || record.body.length < 2 || record.body.length % 2 !== 0) { error = NKE_ERROR.BAD_REQUEST; break; }
        nextProtocolRecords++;
        for (let i = 0; i + 1 < Math.min(record.body.length, NKE_MAX_RECORD_BODY_LENGTH); i += 2) {
          nextProtocolValues++;
          if (((record.body[i] << 8) | record.body[i + 1]) === NKE_NEXT_PROTOCOL_NTPV4) nextProtocol = NKE_NEXT_PROTOCOL_NTPV4;
        }
        break;
      case NKE_RECORD.AEAD_ALGORITHM:
        if (record.body.length < 2 || record.body.length % 2 !== 0) { error = NKE_ERROR.BAD_REQUEST; break; }
        aeadRecords++;
        for (let i = 0; i + 1 < Math.min(record.body.length, NKE_MAX_RECORD_BODY_LENGTH); i += 2) {
          aeadValues++;
          const value = (record.body[i] << 8) | record.body[i + 1];
          if (aead < 0 && aeadKeyLength(value) > 0) aead = value;
        }
        break;
      case NKE_RECORD.ERROR:
      case NKE_RECORD.WARNING:
      case NKE_RECORD.COOKIE:
        error = NKE_ERROR.BAD_REQUEST;
        break;
      default:
        if (record.critical) error = NKE_ERROR.UNRECOGNIZED_CRITICAL_RECORD;
    }
  }
  if (error < 0 && (nextProtocolRecords !== 1 || nextProtocolValues < 1
    || (nextProtocol === NKE_NEXT_PROTOCOL_NTPV4 && (aeadRecords !== 1 || aeadValues < 1)))) error = NKE_ERROR.BAD_REQUEST;

  const out: KeRecord[] = [];
  const end: KeRecord = { critical: true, type: NKE_RECORD.END_OF_MESSAGE, body: new Uint8Array(0) };
  if (error >= 0) {
    out.push({ critical: true, type: NKE_RECORD.ERROR, body: u16(error) }, end);
  } else if (nextProtocol < 0) {
    out.push({ critical: true, type: NKE_RECORD.NEXT_PROTOCOL, body: new Uint8Array(0) }, end);
  } else if (aead < 0) {
    out.push({ critical: true, type: NKE_RECORD.NEXT_PROTOCOL, body: u16(nextProtocol) },
      { critical: true, type: NKE_RECORD.AEAD_ALGORITHM, body: new Uint8Array(0) }, end);
  } else {
    const keys = policy.deriveKeys(aead);
    if (keys === null) {
      out.push({ critical: true, type: NKE_RECORD.ERROR, body: u16(NKE_ERROR.INTERNAL_SERVER_ERROR) }, end);
    } else {
      out.push({ critical: true, type: NKE_RECORD.NEXT_PROTOCOL, body: u16(nextProtocol) },
        { critical: true, type: NKE_RECORD.AEAD_ALGORITHM, body: u16(aead) });
      if (policy.ntpPort !== 123) out.push({ critical: true, type: NKE_RECORD.NTPV4_PORT_NEGOTIATION, body: u16(policy.ntpPort) });
      if (policy.ntpServer !== null) {
        out.push({ critical: true, type: NKE_RECORD.NTPV4_SERVER_NEGOTIATION, body: Uint8Array.from([...policy.ntpServer].map((c) => c.charCodeAt(0))) });
      }
      for (let i = 0; i < NKE_MAX_COOKIES; i++) {
        out.push({ critical: false, type: NKE_RECORD.COOKIE, body: policy.makeCookie(aead, keys.c2s, keys.s2c) });
      }
      out.push(end);
    }
  }
  return encodeRecords(out);
}
