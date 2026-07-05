// RFC 9113 §4 — 9-octet frame header + type-specific payload. No PUSH_PROMISE (cf. PRD-HTTP.md §2.2).
export type Http2FrameType =
  | 'DATA' | 'HEADERS' | 'PRIORITY' | 'RST_STREAM' | 'SETTINGS'
  | 'PING' | 'GOAWAY' | 'WINDOW_UPDATE' | 'CONTINUATION';

const TYPE_TO_BYTE: Record<Http2FrameType, number> = {
  DATA: 0x0, HEADERS: 0x1, PRIORITY: 0x2, RST_STREAM: 0x3, SETTINGS: 0x4,
  PING: 0x6, GOAWAY: 0x7, WINDOW_UPDATE: 0x8, CONTINUATION: 0x9,
};
const BYTE_TO_TYPE: Record<number, Http2FrameType> = Object.fromEntries(
  Object.entries(TYPE_TO_BYTE).map(([k, v]) => [v, k as Http2FrameType]),
);

export const FLAG_END_STREAM = 0x1;
export const FLAG_ACK = 0x1;
export const FLAG_END_HEADERS = 0x4;
export const FLAG_PADDED = 0x8;
export const FLAG_PRIORITY = 0x20;

export interface Http2Frame {
  type: Http2FrameType;
  flags: number;
  streamId: number;
  payload: Uint8Array;
}

export function hasFlag(frame: Http2Frame, flag: number): boolean {
  return (frame.flags & flag) !== 0;
}

export function encodeFrame(frame: Http2Frame): Uint8Array {
  const length = frame.payload.length;
  const header = new Uint8Array(9);
  header[0] = (length >> 16) & 0xff;
  header[1] = (length >> 8) & 0xff;
  header[2] = length & 0xff;
  header[3] = TYPE_TO_BYTE[frame.type];
  header[4] = frame.flags & 0xff;
  header[5] = (frame.streamId >> 24) & 0x7f;
  header[6] = (frame.streamId >> 16) & 0xff;
  header[7] = (frame.streamId >> 8) & 0xff;
  header[8] = frame.streamId & 0xff;

  const out = new Uint8Array(9 + length);
  out.set(header, 0);
  out.set(frame.payload, 9);
  return out;
}

export interface DecodedHttp2Frame {
  frame: Http2Frame;
  bytesConsumed: number;
}

export function decodeFrame(bytes: Uint8Array): DecodedHttp2Frame | null {
  if (bytes.length < 9) return null;
  const length = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const typeByte = bytes[3];
  const type = BYTE_TO_TYPE[typeByte];
  if (type === undefined) return null;
  const flags = bytes[4];
  const streamId = ((bytes[5] & 0x7f) << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];

  if (bytes.length < 9 + length) return null;
  const payload = bytes.slice(9, 9 + length);
  return { frame: { type, flags, streamId, payload }, bytesConsumed: 9 + length };
}

/** Parses every complete frame at the front of a buffer, returning leftover unparsed bytes. */
export function decodeFrames(bytes: Uint8Array): { frames: Http2Frame[]; rest: Uint8Array } {
  const frames: Http2Frame[] = [];
  let offset = 0;
  for (;;) {
    const decoded = decodeFrame(bytes.slice(offset));
    if (!decoded) break;
    frames.push(decoded.frame);
    offset += decoded.bytesConsumed;
  }
  return { frames, rest: bytes.slice(offset) };
}

// SETTINGS frame payload (RFC 9113 §6.5.1): repeated (16-bit identifier, 32-bit value).
export interface Http2Settings {
  headerTableSize?: number;
  enablePush?: number;
  maxConcurrentStreams?: number;
  initialWindowSize?: number;
  maxFrameSize?: number;
  maxHeaderListSize?: number;
}

const SETTINGS_IDS: Record<keyof Http2Settings, number> = {
  headerTableSize: 0x1, enablePush: 0x2, maxConcurrentStreams: 0x3,
  initialWindowSize: 0x4, maxFrameSize: 0x5, maxHeaderListSize: 0x6,
};
const SETTINGS_ID_TO_KEY: Record<number, keyof Http2Settings> = Object.fromEntries(
  Object.entries(SETTINGS_IDS).map(([k, v]) => [v, k as keyof Http2Settings]),
);

export function encodeSettingsPayload(settings: Http2Settings): Uint8Array {
  const entries = Object.entries(settings).filter(([, v]) => v !== undefined) as [keyof Http2Settings, number][];
  const out = new Uint8Array(entries.length * 6);
  entries.forEach(([key, value], i) => {
    const id = SETTINGS_IDS[key];
    const off = i * 6;
    out[off] = (id >> 8) & 0xff;
    out[off + 1] = id & 0xff;
    out[off + 2] = (value >>> 24) & 0xff;
    out[off + 3] = (value >>> 16) & 0xff;
    out[off + 4] = (value >>> 8) & 0xff;
    out[off + 5] = value & 0xff;
  });
  return out;
}

export function decodeSettingsPayload(payload: Uint8Array): Http2Settings {
  const settings: Http2Settings = {};
  for (let off = 0; off + 6 <= payload.length; off += 6) {
    const id = (payload[off] << 8) | payload[off + 1];
    const value = ((payload[off + 2] << 24) | (payload[off + 3] << 16) | (payload[off + 4] << 8) | payload[off + 5]) >>> 0;
    const key = SETTINGS_ID_TO_KEY[id];
    if (key) settings[key] = value;
  }
  return settings;
}

export function encodeWindowUpdatePayload(increment: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (increment >>> 24) & 0x7f;
  out[1] = (increment >>> 16) & 0xff;
  out[2] = (increment >>> 8) & 0xff;
  out[3] = increment & 0xff;
  return out;
}

export function decodeWindowUpdatePayload(payload: Uint8Array): number {
  return ((payload[0] & 0x7f) << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
}

export function encodeRstStreamPayload(errorCode: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, errorCode >>> 0);
  return out;
}

export function decodeRstStreamPayload(payload: Uint8Array): number {
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
}

export function encodeGoawayPayload(lastStreamId: number, errorCode: number, debugData = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + debugData.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, lastStreamId & 0x7fffffff);
  view.setUint32(4, errorCode >>> 0);
  out.set(debugData, 8);
  return out;
}

export function decodeGoawayPayload(payload: Uint8Array): { lastStreamId: number; errorCode: number; debugData: Uint8Array } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  return {
    lastStreamId: view.getUint32(0) & 0x7fffffff,
    errorCode: view.getUint32(4),
    debugData: payload.slice(8),
  };
}
