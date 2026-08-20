import { encodeVarint, decodeVarint } from './varint';
import { hexToBytes, bytesToHex } from './types';

export interface AckRange {
  gap: number;
  ackRangeLength: number;
}

export type QuicFrame =
  | { type: 'PADDING' }
  | { type: 'PING' }
  | { type: 'ACK'; largestAcknowledged: number; ackDelay: number; ackRanges: AckRange[] }
  | { type: 'CRYPTO'; offset: number; length: number; data: Uint8Array }
  | { type: 'STREAM'; streamId: number; offset: number; length: number; fin: boolean; data: Uint8Array }
  | { type: 'MAX_DATA'; maximumData: number }
  | { type: 'MAX_STREAM_DATA'; streamId: number; maximumStreamData: number }
  | { type: 'STREAM_DATA_BLOCKED'; streamId: number; maximumStreamData: number }
  | { type: 'DATA_BLOCKED'; maximumData: number }
  | { type: 'NEW_CONNECTION_ID'; sequenceNumber: number; retirePriorTo: number; connectionId: string; statelessResetToken: Uint8Array }
  | { type: 'RETIRE_CONNECTION_ID'; sequenceNumber: number }
  | { type: 'CONNECTION_CLOSE'; errorCode: number; frameType?: number; reasonPhrase: string; layer: 'transport' | 'application' }
  | { type: 'HANDSHAKE_DONE' };

function concatArrays(chunks: number[][]): Uint8Array {
  return new Uint8Array(chunks.flat());
}

// RFC 9000 §19 — each frame type's wire encoding.
export function encodeFrame(frame: QuicFrame): Uint8Array {
  switch (frame.type) {
    case 'PADDING':
      return new Uint8Array([0x00]);

    case 'PING':
      return new Uint8Array([0x01]);

    case 'ACK': {
      // RFC 9000 §19.3 — "ACK Range Count" is the number of *additional*
      // ranges after the first one; ackRanges[0] is that first range (its
      // `gap` is meaningless and never written).
      const additionalRangeCount = Math.max(0, frame.ackRanges.length - 1);
      const parts: number[][] = [
        [0x02],
        Array.from(encodeVarint(frame.largestAcknowledged)),
        Array.from(encodeVarint(frame.ackDelay)),
        Array.from(encodeVarint(additionalRangeCount)),
      ];
      const firstRangeLength = frame.ackRanges[0]?.ackRangeLength ?? 0;
      parts.push(Array.from(encodeVarint(firstRangeLength)));
      for (let i = 1; i < frame.ackRanges.length; i++) {
        parts.push(Array.from(encodeVarint(frame.ackRanges[i].gap)));
        parts.push(Array.from(encodeVarint(frame.ackRanges[i].ackRangeLength)));
      }
      return concatArrays(parts);
    }

    // RFC 9000 §19.6 — carries a contiguous range of the TLS handshake
    // byte stream (CRYPTO frames have no stream ID: each packet-number
    // space has its own independent CRYPTO stream).
    case 'CRYPTO': {
      const parts: number[][] = [
        [0x06],
        Array.from(encodeVarint(frame.offset)),
        Array.from(encodeVarint(frame.length)),
        Array.from(frame.data),
      ];
      return concatArrays(parts);
    }

    case 'STREAM': {
      const typeByte = 0x08 | 0x04 | 0x02 | (frame.fin ? 0x01 : 0);
      const parts: number[][] = [
        [typeByte],
        Array.from(encodeVarint(frame.streamId)),
        Array.from(encodeVarint(frame.offset)),
        Array.from(encodeVarint(frame.length)),
        Array.from(frame.data),
      ];
      return concatArrays(parts);
    }

    case 'MAX_DATA':
      return concatArrays([[0x10], Array.from(encodeVarint(frame.maximumData))]);

    case 'MAX_STREAM_DATA':
      return concatArrays([[0x11], Array.from(encodeVarint(frame.streamId)), Array.from(encodeVarint(frame.maximumStreamData))]);

    case 'DATA_BLOCKED':
      return concatArrays([[0x14], Array.from(encodeVarint(frame.maximumData))]);

    case 'STREAM_DATA_BLOCKED':
      return concatArrays([[0x15], Array.from(encodeVarint(frame.streamId)), Array.from(encodeVarint(frame.maximumStreamData))]);

    case 'NEW_CONNECTION_ID': {
      const cidBytes = hexToBytes(frame.connectionId);
      const parts: number[][] = [
        [0x18],
        Array.from(encodeVarint(frame.sequenceNumber)),
        Array.from(encodeVarint(frame.retirePriorTo)),
        [cidBytes.length],
        Array.from(cidBytes),
        Array.from(frame.statelessResetToken),
      ];
      return concatArrays(parts);
    }

    case 'RETIRE_CONNECTION_ID':
      return concatArrays([[0x19], Array.from(encodeVarint(frame.sequenceNumber))]);

    case 'CONNECTION_CLOSE': {
      const typeByte = frame.layer === 'transport' ? 0x1c : 0x1d;
      const reasonBytes = new TextEncoder().encode(frame.reasonPhrase);
      const parts: number[][] = [[typeByte], Array.from(encodeVarint(frame.errorCode))];
      if (frame.layer === 'transport') parts.push(Array.from(encodeVarint(frame.frameType ?? 0)));
      parts.push(Array.from(encodeVarint(reasonBytes.length)), Array.from(reasonBytes));
      return concatArrays(parts);
    }

    case 'HANDSHAKE_DONE':
      return new Uint8Array([0x1e]);

    default: {
      const exhaustive: never = frame;
      throw new Error(`Unknown frame: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface DecodedFrame {
  frame: QuicFrame;
  bytesConsumed: number;
}

export function decodeFrame(bytes: Uint8Array, offset = 0): DecodedFrame | null {
  if (offset >= bytes.length) return null;
  const typeByte = bytes[offset];
  let off = offset + 1;

  if (typeByte === 0x00) return { frame: { type: 'PADDING' }, bytesConsumed: 1 };
  if (typeByte === 0x01) return { frame: { type: 'PING' }, bytesConsumed: 1 };
  if (typeByte === 0x1e) return { frame: { type: 'HANDSHAKE_DONE' }, bytesConsumed: 1 };

  if (typeByte === 0x02 || typeByte === 0x03) {
    const largest = decodeVarint(bytes, off);
    if (!largest) return null;
    off += largest.bytesConsumed;
    const delay = decodeVarint(bytes, off);
    if (!delay) return null;
    off += delay.bytesConsumed;
    const rangeCount = decodeVarint(bytes, off);
    if (!rangeCount) return null;
    off += rangeCount.bytesConsumed;
    const firstRange = decodeVarint(bytes, off);
    if (!firstRange) return null;
    off += firstRange.bytesConsumed;

    const ackRanges: AckRange[] = [{ gap: 0, ackRangeLength: firstRange.value }];
    for (let i = 0; i < rangeCount.value; i++) {
      const gap = decodeVarint(bytes, off);
      if (!gap) return null;
      off += gap.bytesConsumed;
      const rangeLength = decodeVarint(bytes, off);
      if (!rangeLength) return null;
      off += rangeLength.bytesConsumed;
      ackRanges.push({ gap: gap.value, ackRangeLength: rangeLength.value });
    }
    if (typeByte === 0x03) {
      for (let i = 0; i < 3; i++) {
        const ecn = decodeVarint(bytes, off);
        if (!ecn) return null;
        off += ecn.bytesConsumed;
      }
    }
    return {
      frame: { type: 'ACK', largestAcknowledged: largest.value, ackDelay: delay.value, ackRanges },
      bytesConsumed: off - offset,
    };
  }

  if (typeByte === 0x06) {
    const offsetField = decodeVarint(bytes, off);
    if (!offsetField) return null;
    off += offsetField.bytesConsumed;
    const lengthField = decodeVarint(bytes, off);
    if (!lengthField) return null;
    off += lengthField.bytesConsumed;
    if (bytes.length < off + lengthField.value) return null;
    const data = bytes.slice(off, off + lengthField.value);
    off += lengthField.value;
    return {
      frame: { type: 'CRYPTO', offset: offsetField.value, length: lengthField.value, data },
      bytesConsumed: off - offset,
    };
  }

  if (typeByte >= 0x08 && typeByte <= 0x0f) {
    const hasOffset = (typeByte & 0x04) !== 0;
    const hasLength = (typeByte & 0x02) !== 0;
    const fin = (typeByte & 0x01) !== 0;

    const streamId = decodeVarint(bytes, off);
    if (!streamId) return null;
    off += streamId.bytesConsumed;

    let dataOffset = 0;
    if (hasOffset) {
      const offsetField = decodeVarint(bytes, off);
      if (!offsetField) return null;
      off += offsetField.bytesConsumed;
      dataOffset = offsetField.value;
    }

    let length: number;
    if (hasLength) {
      const lengthField = decodeVarint(bytes, off);
      if (!lengthField) return null;
      off += lengthField.bytesConsumed;
      length = lengthField.value;
    } else {
      length = bytes.length - off;
    }
    if (bytes.length < off + length) return null;
    const data = bytes.slice(off, off + length);
    off += length;

    return { frame: { type: 'STREAM', streamId: streamId.value, offset: dataOffset, length, fin, data }, bytesConsumed: off - offset };
  }

  if (typeByte === 0x10) {
    const max = decodeVarint(bytes, off);
    if (!max) return null;
    return { frame: { type: 'MAX_DATA', maximumData: max.value }, bytesConsumed: off + max.bytesConsumed - offset };
  }

  if (typeByte === 0x11) {
    const streamId = decodeVarint(bytes, off);
    if (!streamId) return null;
    off += streamId.bytesConsumed;
    const max = decodeVarint(bytes, off);
    if (!max) return null;
    off += max.bytesConsumed;
    return { frame: { type: 'MAX_STREAM_DATA', streamId: streamId.value, maximumStreamData: max.value }, bytesConsumed: off - offset };
  }

  if (typeByte === 0x14) {
    const max = decodeVarint(bytes, off);
    if (!max) return null;
    return { frame: { type: 'DATA_BLOCKED', maximumData: max.value }, bytesConsumed: off + max.bytesConsumed - offset };
  }

  if (typeByte === 0x15) {
    const streamId = decodeVarint(bytes, off);
    if (!streamId) return null;
    off += streamId.bytesConsumed;
    const max = decodeVarint(bytes, off);
    if (!max) return null;
    off += max.bytesConsumed;
    return { frame: { type: 'STREAM_DATA_BLOCKED', streamId: streamId.value, maximumStreamData: max.value }, bytesConsumed: off - offset };
  }

  if (typeByte === 0x18) {
    const seq = decodeVarint(bytes, off);
    if (!seq) return null;
    off += seq.bytesConsumed;
    const retirePriorTo = decodeVarint(bytes, off);
    if (!retirePriorTo) return null;
    off += retirePriorTo.bytesConsumed;
    if (bytes.length < off + 1) return null;
    const cidLen = bytes[off];
    off += 1;
    if (bytes.length < off + cidLen + 16) return null;
    const connectionId = bytesToHex(bytes.slice(off, off + cidLen));
    off += cidLen;
    const statelessResetToken = bytes.slice(off, off + 16);
    off += 16;
    return {
      frame: { type: 'NEW_CONNECTION_ID', sequenceNumber: seq.value, retirePriorTo: retirePriorTo.value, connectionId, statelessResetToken },
      bytesConsumed: off - offset,
    };
  }

  if (typeByte === 0x19) {
    const seq = decodeVarint(bytes, off);
    if (!seq) return null;
    return { frame: { type: 'RETIRE_CONNECTION_ID', sequenceNumber: seq.value }, bytesConsumed: off + seq.bytesConsumed - offset };
  }

  if (typeByte === 0x1c || typeByte === 0x1d) {
    const errorCode = decodeVarint(bytes, off);
    if (!errorCode) return null;
    off += errorCode.bytesConsumed;
    let frameType: number | undefined;
    if (typeByte === 0x1c) {
      const ft = decodeVarint(bytes, off);
      if (!ft) return null;
      off += ft.bytesConsumed;
      frameType = ft.value;
    }
    const reasonLen = decodeVarint(bytes, off);
    if (!reasonLen) return null;
    off += reasonLen.bytesConsumed;
    if (bytes.length < off + reasonLen.value) return null;
    const reasonPhrase = new TextDecoder().decode(bytes.slice(off, off + reasonLen.value));
    off += reasonLen.value;
    return {
      frame: { type: 'CONNECTION_CLOSE', errorCode: errorCode.value, frameType, reasonPhrase, layer: typeByte === 0x1c ? 'transport' : 'application' },
      bytesConsumed: off - offset,
    };
  }

  return null;
}

/** Parses every complete frame at the front of a buffer, returning leftover unparsed bytes. */
export function decodeFrames(bytes: Uint8Array): { frames: QuicFrame[]; rest: Uint8Array } {
  const frames: QuicFrame[] = [];
  let offset = 0;
  for (;;) {
    const decoded = decodeFrame(bytes, offset);
    if (!decoded) break;
    frames.push(decoded.frame);
    offset += decoded.bytesConsumed;
  }
  return { frames, rest: bytes.slice(offset) };
}
