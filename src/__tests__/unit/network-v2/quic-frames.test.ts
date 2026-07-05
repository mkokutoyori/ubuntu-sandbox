/**
 * PRD-QUIC.md §5 P2 — frames (RFC 9000 §19): round-trip encode/decode of
 * every frame type in scope, including ACK with several non-contiguous
 * ranges. Pure format layer, no network, no protection (P3).
 */
import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, decodeFrames, type QuicFrame } from '@/network/quic/frames';

function roundTrip(frame: QuicFrame) {
  const bytes = encodeFrame(frame);
  const decoded = decodeFrame(bytes)!;
  expect(decoded.frame).toEqual(frame);
  expect(decoded.bytesConsumed).toBe(bytes.length);
  return bytes;
}

describe('PADDING / PING / HANDSHAKE_DONE — single-byte frames', () => {
  it('round-trips PADDING', () => { roundTrip({ type: 'PADDING' }); });
  it('round-trips PING', () => { roundTrip({ type: 'PING' }); });
  it('round-trips HANDSHAKE_DONE', () => { roundTrip({ type: 'HANDSHAKE_DONE' }); });
});

describe('ACK frame (RFC 9000 §19.3)', () => {
  it('round-trips a single-range ACK', () => {
    roundTrip({ type: 'ACK', largestAcknowledged: 100, ackDelay: 5, ackRanges: [{ gap: 0, ackRangeLength: 10 }] });
  });

  it('round-trips an ACK with several non-contiguous ranges', () => {
    const frame: QuicFrame = {
      type: 'ACK',
      largestAcknowledged: 1000,
      ackDelay: 42,
      ackRanges: [
        { gap: 0, ackRangeLength: 5 },
        { gap: 2, ackRangeLength: 3 },
        { gap: 1, ackRangeLength: 7 },
      ],
    };
    roundTrip(frame);
  });

  it('encodes the additional-range count, not the full ackRanges length', () => {
    const frame: QuicFrame = {
      type: 'ACK', largestAcknowledged: 10, ackDelay: 0,
      ackRanges: [{ gap: 0, ackRangeLength: 1 }, { gap: 0, ackRangeLength: 1 }],
    };
    const bytes = encodeFrame(frame);
    // type(1) + largest(1) + delay(1) + rangeCount(1, must encode 1 not 2) + firstRangeLen(1) + gap(1) + rangeLen(1)
    expect(bytes.length).toBe(7);
  });
});

describe('STREAM frame (RFC 9000 §19.8)', () => {
  it('round-trips with offset, explicit length, and FIN', () => {
    roundTrip({ type: 'STREAM', streamId: 4, offset: 128, length: 5, fin: true, data: new TextEncoder().encode('hello') });
  });

  it('round-trips a zero-offset, non-FIN stream frame', () => {
    roundTrip({ type: 'STREAM', streamId: 0, offset: 0, length: 3, fin: false, data: new Uint8Array([1, 2, 3]) });
  });

  it('decodes correctly when the OFF bit is unset (implicit offset 0)', () => {
    // type byte 0x0a = STREAM | LEN, no OFF, no FIN
    const bytes = new Uint8Array([0x0a, 4, 3, 65, 66, 67]);
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame).toEqual({ type: 'STREAM', streamId: 4, offset: 0, length: 3, fin: false, data: new Uint8Array([65, 66, 67]) });
  });

  it('decodes correctly when the LEN bit is unset (length = rest of buffer)', () => {
    // type byte 0x08 = STREAM only, no OFF, no LEN, no FIN
    const bytes = new Uint8Array([0x08, 4, 65, 66, 67]);
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame).toEqual({ type: 'STREAM', streamId: 4, offset: 0, length: 3, fin: false, data: new Uint8Array([65, 66, 67]) });
  });
});

describe('Flow control frames', () => {
  it('round-trips MAX_DATA', () => { roundTrip({ type: 'MAX_DATA', maximumData: 1_000_000 }); });
  it('round-trips MAX_STREAM_DATA', () => { roundTrip({ type: 'MAX_STREAM_DATA', streamId: 4, maximumStreamData: 65535 }); });
  it('round-trips DATA_BLOCKED', () => { roundTrip({ type: 'DATA_BLOCKED', maximumData: 500 }); });
  it('round-trips STREAM_DATA_BLOCKED', () => { roundTrip({ type: 'STREAM_DATA_BLOCKED', streamId: 8, maximumStreamData: 200 }); });
});

describe('Connection ID frames (RFC 9000 §19.15/§19.16)', () => {
  it('round-trips NEW_CONNECTION_ID', () => {
    roundTrip({
      type: 'NEW_CONNECTION_ID', sequenceNumber: 1, retirePriorTo: 0,
      connectionId: 'aabbccdd', statelessResetToken: new Uint8Array(16).fill(7),
    });
  });

  it('round-trips RETIRE_CONNECTION_ID', () => {
    roundTrip({ type: 'RETIRE_CONNECTION_ID', sequenceNumber: 3 });
  });
});

describe('CONNECTION_CLOSE frame (RFC 9000 §19.19)', () => {
  it('round-trips a transport-layer close with a frame type', () => {
    roundTrip({ type: 'CONNECTION_CLOSE', errorCode: 10, frameType: 0x08, reasonPhrase: 'flow control error', layer: 'transport' });
  });

  it('round-trips an application-layer close with no frame type', () => {
    roundTrip({ type: 'CONNECTION_CLOSE', errorCode: 0, reasonPhrase: 'bye', layer: 'application' });
  });
});

describe('decodeFrames — sequential parsing with leftover bytes', () => {
  it('parses several frames concatenated and returns any incomplete tail', () => {
    const f1 = encodeFrame({ type: 'PING' });
    const f2 = encodeFrame({ type: 'MAX_DATA', maximumData: 42 });
    const partial = encodeFrame({ type: 'STREAM', streamId: 1, offset: 0, length: 10, fin: false, data: new Uint8Array(10) }).slice(0, 3);
    const combined = new Uint8Array([...f1, ...f2, ...partial]);
    const { frames, rest } = decodeFrames(combined);
    expect(frames).toEqual([{ type: 'PING' }, { type: 'MAX_DATA', maximumData: 42 }]);
    expect(rest).toEqual(partial);
  });
});

describe('decodeFrame — malformed input', () => {
  it('returns null for an unknown frame type byte', () => {
    expect(decodeFrame(new Uint8Array([0xff]))).toBeNull();
  });

  it('returns null for a truncated frame', () => {
    const bytes = encodeFrame({ type: 'MAX_DATA', maximumData: 100000 });
    expect(decodeFrame(bytes.slice(0, bytes.length - 1))).toBeNull();
  });
});
