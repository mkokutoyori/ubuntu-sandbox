// RFC 9114 §7.2 — HTTP/3 frames mapped onto QUIC stream bytes: a generic
// `Type(varint) Length(varint) Payload` layout (§7.1), reusing the QUIC
// varint codec (RFC 9000 §16, same wire format HTTP/3 frames use). No
// server push (CANCEL_PUSH/PUSH_PROMISE/MAX_PUSH_ID) — out of scope, cf.
// PRD-HTTP.md §2.2.
import { encodeVarint, decodeVarint } from '@/network/quic/varint';

export type Http3FrameType = 'DATA' | 'HEADERS' | 'SETTINGS' | 'GOAWAY';

const TYPE_TO_CODE: Record<Http3FrameType, number> = {
  DATA: 0x00, HEADERS: 0x01, SETTINGS: 0x04, GOAWAY: 0x07,
};
const CODE_TO_TYPE: Record<number, Http3FrameType> = Object.fromEntries(
  Object.entries(TYPE_TO_CODE).map(([k, v]) => [v, k as Http3FrameType]),
);

// RFC 9114 §6.2.1 — the first bytes of a unidirectional stream identify its
// kind. Only the control stream is used here (no QPACK encoder/decoder
// streams — dynamic table is out of scope, cf. PRD-HTTP.md §2.2).
export const CONTROL_STREAM_TYPE = 0x00;

export interface Http3Frame {
  type: Http3FrameType;
  payload: Uint8Array;
}

// RFC 9114 §7.2.8 — an unrecognized frame type MUST be ignored, not
// rejected (forward compatibility with push-related/future frame types).
export interface Http3UnknownFrame {
  type: 'UNKNOWN';
  rawType: number;
  payload: Uint8Array;
}

export type DecodedHttp3Frame = Http3Frame | Http3UnknownFrame;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export function encodeFrame(frame: Http3Frame): Uint8Array {
  return concatBytes([encodeVarint(TYPE_TO_CODE[frame.type]), encodeVarint(frame.payload.length), frame.payload]);
}

/** Decodes as many complete frames as `bytes` contains; leftover partial bytes are returned as `rest`. */
export function decodeFrames(bytes: Uint8Array): { frames: DecodedHttp3Frame[]; rest: Uint8Array } {
  const frames: DecodedHttp3Frame[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const typeResult = decodeVarint(bytes, offset);
    if (!typeResult) break;
    const lenResult = decodeVarint(bytes, offset + typeResult.bytesConsumed);
    if (!lenResult) break;

    const payloadStart = offset + typeResult.bytesConsumed + lenResult.bytesConsumed;
    const payloadEnd = payloadStart + lenResult.value;
    if (payloadEnd > bytes.length) break;

    const payload = bytes.slice(payloadStart, payloadEnd);
    const type = CODE_TO_TYPE[typeResult.value];
    frames.push(type ? { type, payload } : { type: 'UNKNOWN', rawType: typeResult.value, payload });
    offset = payloadEnd;
  }

  return { frames, rest: bytes.slice(offset) };
}

// RFC 9114 §7.2.4.1 — only the settings this engine actually understands;
// unknown identifiers are round-tripped as opaque entries (MUST be ignored,
// not rejected) so a peer's SETTINGS frame is never rejected wholesale.
export interface Http3Settings {
  qpackMaxTableCapacity?: number;
  maxFieldSectionSize?: number;
  qpackBlockedStreams?: number;
}

const SETTINGS_QPACK_MAX_TABLE_CAPACITY = 0x01;
const SETTINGS_MAX_FIELD_SECTION_SIZE = 0x06;
const SETTINGS_QPACK_BLOCKED_STREAMS = 0x07;

export function encodeSettingsPayload(settings: Http3Settings): Uint8Array {
  const pairs: [number, number][] = [];
  if (settings.qpackMaxTableCapacity !== undefined) pairs.push([SETTINGS_QPACK_MAX_TABLE_CAPACITY, settings.qpackMaxTableCapacity]);
  if (settings.maxFieldSectionSize !== undefined) pairs.push([SETTINGS_MAX_FIELD_SECTION_SIZE, settings.maxFieldSectionSize]);
  if (settings.qpackBlockedStreams !== undefined) pairs.push([SETTINGS_QPACK_BLOCKED_STREAMS, settings.qpackBlockedStreams]);
  return concatBytes(pairs.flatMap(([id, value]) => [encodeVarint(id), encodeVarint(value)]));
}

export function decodeSettingsPayload(bytes: Uint8Array): Http3Settings {
  const settings: Http3Settings = {};
  let offset = 0;
  while (offset < bytes.length) {
    const idResult = decodeVarint(bytes, offset);
    if (!idResult) break;
    offset += idResult.bytesConsumed;
    const valueResult = decodeVarint(bytes, offset);
    if (!valueResult) break;
    offset += valueResult.bytesConsumed;

    if (idResult.value === SETTINGS_QPACK_MAX_TABLE_CAPACITY) settings.qpackMaxTableCapacity = valueResult.value;
    else if (idResult.value === SETTINGS_MAX_FIELD_SECTION_SIZE) settings.maxFieldSectionSize = valueResult.value;
    else if (idResult.value === SETTINGS_QPACK_BLOCKED_STREAMS) settings.qpackBlockedStreams = valueResult.value;
  }
  return settings;
}

export function encodeGoawayPayload(idOrStreamId: number): Uint8Array {
  return encodeVarint(idOrStreamId);
}

export function decodeGoawayPayload(bytes: Uint8Array): number | null {
  const result = decodeVarint(bytes, 0);
  return result ? result.value : null;
}
