/**
 * PRD-QUIC.md §5 P6 — streams (RFC 9000 §2/§4): stream ID encoding
 * (initiator + direction in the 2 low bits), sequential allocation per
 * category, flow control by stream and by connection (blocked when the
 * window is exhausted, unblocked after MAX_STREAM_DATA/MAX_DATA), and
 * multiplexing of several independent streams.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStreamId, firstStreamId, createStream,
  StreamIdAllocator, QuicStreamManager,
} from '@/network/quic/QuicStream';
import type { QuicFrame } from '@/network/quic/frames';

describe('classifyStreamId / firstStreamId (RFC 9000 §2.1)', () => {
  it('classifies all four combinations correctly', () => {
    expect(classifyStreamId(0)).toEqual({ initiatedBy: 'client', direction: 'bidirectional' });
    expect(classifyStreamId(1)).toEqual({ initiatedBy: 'server', direction: 'bidirectional' });
    expect(classifyStreamId(2)).toEqual({ initiatedBy: 'client', direction: 'unidirectional' });
    expect(classifyStreamId(3)).toEqual({ initiatedBy: 'server', direction: 'unidirectional' });
  });

  it('classifies IDs beyond the first cycle by their low 2 bits', () => {
    expect(classifyStreamId(4)).toEqual({ initiatedBy: 'client', direction: 'bidirectional' });
    expect(classifyStreamId(9)).toEqual({ initiatedBy: 'server', direction: 'bidirectional' });
  });

  it('firstStreamId is the inverse of classifyStreamId for the base IDs', () => {
    expect(firstStreamId('client', 'bidirectional')).toBe(0);
    expect(firstStreamId('server', 'bidirectional')).toBe(1);
    expect(firstStreamId('client', 'unidirectional')).toBe(2);
    expect(firstStreamId('server', 'unidirectional')).toBe(3);
  });
});

describe('StreamIdAllocator', () => {
  it('allocates sequential IDs within one category, stepping by 4', () => {
    const alloc = new StreamIdAllocator();
    expect(alloc.next('client', 'bidirectional')).toBe(0);
    expect(alloc.next('client', 'bidirectional')).toBe(4);
    expect(alloc.next('client', 'bidirectional')).toBe(8);
  });

  it('keeps separate counters per category', () => {
    const alloc = new StreamIdAllocator();
    expect(alloc.next('client', 'bidirectional')).toBe(0);
    expect(alloc.next('server', 'bidirectional')).toBe(1);
    expect(alloc.next('client', 'unidirectional')).toBe(2);
    expect(alloc.next('client', 'bidirectional')).toBe(4);
  });
});

describe('createStream', () => {
  it('derives direction/initiatedBy from the ID and starts at zero offsets', () => {
    const stream = createStream(0, 1000);
    expect(stream.initiatedBy).toBe('client');
    expect(stream.direction).toBe('bidirectional');
    expect(stream.sendOffset).toBe(0);
    expect(stream.sendMaxData).toBe(1000);
    expect(stream.finSent).toBe(false);
    expect(stream.finReceived).toBe(false);
  });
});

describe('QuicStreamManager — flow control by stream (RFC 9000 §4.1)', () => {
  it('sends data within the window and advances offsets', () => {
    const manager = new QuicStreamManager('client', 100000);
    const stream = manager.openStream('bidirectional', 1000);
    const result = manager.trySend(stream, new TextEncoder().encode('hello'), false);
    expect(result.frame).toMatchObject({ type: 'STREAM', streamId: stream.id, offset: 0, length: 5, fin: false });
    expect(stream.sendOffset).toBe(5);
  });

  it('emits STREAM_DATA_BLOCKED when the stream window is exhausted', () => {
    const manager = new QuicStreamManager('client', 100000);
    const stream = manager.openStream('bidirectional', 5);
    manager.trySend(stream, new Uint8Array(5), false);
    const blocked = manager.trySend(stream, new Uint8Array(1), false);
    expect(blocked.frame).toBeUndefined();
    expect(blocked.blockedFrame).toEqual({ type: 'STREAM_DATA_BLOCKED', streamId: stream.id, maximumStreamData: 5 });
  });

  it('unblocks after receiving MAX_STREAM_DATA', () => {
    const manager = new QuicStreamManager('client', 100000);
    const stream = manager.openStream('bidirectional', 5);
    manager.trySend(stream, new Uint8Array(5), false);
    manager.receiveMaxStreamData({ type: 'MAX_STREAM_DATA', streamId: stream.id, maximumStreamData: 10 });
    const result = manager.trySend(stream, new Uint8Array(5), false);
    expect(result.frame).toBeDefined();
    expect(result.bytesSent).toBe(5);
  });

  it('emits DATA_BLOCKED when the connection window (not the stream window) is exhausted', () => {
    const manager = new QuicStreamManager('client', 5);
    const stream = manager.openStream('bidirectional', 100000);
    manager.trySend(stream, new Uint8Array(5), false);
    const blocked = manager.trySend(stream, new Uint8Array(1), false);
    expect(blocked.blockedFrame).toEqual({ type: 'DATA_BLOCKED', maximumData: 5 });
  });

  it('unblocks after receiving MAX_DATA', () => {
    const manager = new QuicStreamManager('client', 5);
    const stream = manager.openStream('bidirectional', 100000);
    manager.trySend(stream, new Uint8Array(5), false);
    manager.receiveMaxData({ type: 'MAX_DATA', maximumData: 10 });
    const result = manager.trySend(stream, new Uint8Array(5), false);
    expect(result.bytesSent).toBe(5);
  });

  it('a send larger than the window is truncated, with the remainder implicitly pending', () => {
    const manager = new QuicStreamManager('client', 100000);
    const stream = manager.openStream('bidirectional', 5);
    const result = manager.trySend(stream, new Uint8Array(10), true);
    expect(result.bytesSent).toBe(5);
    expect((result.frame as Extract<QuicFrame, { type: 'STREAM' }>).fin).toBe(false);
  });

  it('sets fin only when the entire remaining data was sent', () => {
    const manager = new QuicStreamManager('client', 100000);
    const stream = manager.openStream('bidirectional', 1000);
    const result = manager.trySend(stream, new Uint8Array(3), true);
    expect((result.frame as Extract<QuicFrame, { type: 'STREAM' }>).fin).toBe(true);
    expect(stream.finSent).toBe(true);
  });

  it('grantStreamCredit / grantConnectionCredit produce the correct frames', () => {
    const manager = new QuicStreamManager('client');
    const stream = manager.openStream('bidirectional');
    expect(manager.grantStreamCredit(stream, 500)).toEqual({ type: 'MAX_STREAM_DATA', streamId: stream.id, maximumStreamData: stream.recvMaxData });
    expect(manager.grantConnectionCredit(500)).toEqual({ type: 'MAX_DATA', maximumData: manager.connectionRecvMaxData });
  });
});

describe('QuicStreamManager — receiving STREAM frames', () => {
  it('creates a peer-initiated stream on first receipt and tracks recvOffset/finReceived', () => {
    const manager = new QuicStreamManager('client');
    const frame: QuicFrame = { type: 'STREAM', streamId: 1, offset: 0, length: 5, fin: true, data: new TextEncoder().encode('hello') };
    const stream = manager.receiveStreamFrame(frame as Extract<QuicFrame, { type: 'STREAM' }>);
    expect(stream.initiatedBy).toBe('server');
    expect(stream.recvOffset).toBe(5);
    expect(stream.finReceived).toBe(true);
  });
});

describe('QuicStreamManager — multiplexing independent streams', () => {
  it('tracks flow control state independently per stream on one connection', () => {
    const manager = new QuicStreamManager('client', 100000);
    const s1 = manager.openStream('bidirectional', 10);
    const s2 = manager.openStream('bidirectional', 10);
    expect(s2.id).toBe(4);

    manager.trySend(s1, new Uint8Array(10), false);
    const s1Blocked = manager.trySend(s1, new Uint8Array(1), false);
    const s2Result = manager.trySend(s2, new Uint8Array(5), false);

    expect(s1Blocked.blockedFrame?.type).toBe('STREAM_DATA_BLOCKED');
    expect(s2Result.frame).toBeDefined();
    expect(s2.sendOffset).toBe(5);
  });
});
