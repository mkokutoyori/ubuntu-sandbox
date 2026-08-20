export type WebSocketOpcode = 'continuation' | 'text' | 'binary' | 'close' | 'ping' | 'pong';

const OPCODE_TO_BYTE: Record<WebSocketOpcode, number> = {
  continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa,
};
const BYTE_TO_OPCODE: Record<number, WebSocketOpcode> = Object.fromEntries(
  Object.entries(OPCODE_TO_BYTE).map(([k, v]) => [v, k as WebSocketOpcode]),
);

export interface WebSocketFrame {
  fin: boolean;
  opcode: WebSocketOpcode;
  masked: boolean;
  maskingKey?: [number, number, number, number];
  payload: Uint8Array;
}

export function maskPayload(payload: Uint8Array, key: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];
  return out;
}

// RFC 6455 §5.2 — binary frame encoding.
export function encodeFrame(frame: WebSocketFrame): Uint8Array {
  const len = frame.payload.length;
  const parts: number[] = [];
  parts.push((frame.fin ? 0x80 : 0) | OPCODE_TO_BYTE[frame.opcode]);

  const maskBit = frame.masked ? 0x80 : 0;
  if (len < 126) {
    parts.push(maskBit | len);
  } else if (len <= 0xffff) {
    parts.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  } else {
    parts.push(maskBit | 127);
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(len));
    for (let i = 0; i < 8; i++) parts.push(view.getUint8(i));
  }

  if (frame.masked) {
    if (!frame.maskingKey) throw new Error('masked frame requires a maskingKey');
    parts.push(...frame.maskingKey);
  }

  const header = new Uint8Array(parts);
  const payload = frame.masked && frame.maskingKey ? maskPayload(frame.payload, frame.maskingKey) : frame.payload;
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

export interface DecodedFrame {
  frame: WebSocketFrame;
  bytesConsumed: number;
}

export function decodeFrame(bytes: Uint8Array): DecodedFrame | null {
  if (bytes.length < 2) return null;
  const byte0 = bytes[0];
  const fin = !!(byte0 & 0x80);
  const opcode = BYTE_TO_OPCODE[byte0 & 0x0f];
  if (opcode === undefined) return null;

  const byte1 = bytes[1];
  const masked = !!(byte1 & 0x80);
  const lenIndicator = byte1 & 0x7f;
  let offset = 2;
  let payloadLen: number;

  if (lenIndicator === 126) {
    if (bytes.length < offset + 2) return null;
    payloadLen = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
  } else if (lenIndicator === 127) {
    if (bytes.length < offset + 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    payloadLen = Number(view.getBigUint64(0));
    offset += 8;
  } else {
    payloadLen = lenIndicator;
  }

  let maskingKey: [number, number, number, number] | undefined;
  if (masked) {
    if (bytes.length < offset + 4) return null;
    maskingKey = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
    offset += 4;
  }

  if (bytes.length < offset + payloadLen) return null;
  let payload = bytes.slice(offset, offset + payloadLen);
  if (masked && maskingKey) payload = maskPayload(payload, maskingKey);
  offset += payloadLen;

  return { frame: { fin, opcode, masked, maskingKey, payload }, bytesConsumed: offset };
}
