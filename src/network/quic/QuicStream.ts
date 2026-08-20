import type { QuicFrame } from './frames';

export type StreamDirection = 'bidirectional' | 'unidirectional';
export type StreamInitiator = 'client' | 'server';

export interface QuicStreamState {
  id: number;
  direction: StreamDirection;
  initiatedBy: StreamInitiator;
  sendOffset: number;
  sendMaxData: number;
  recvOffset: number;
  recvMaxData: number;
  finSent: boolean;
  finReceived: boolean;
}

// RFC 9000 §2.1 — the 2 least-significant bits of a stream ID encode who
// initiated it and whether it's bidirectional or unidirectional.
export function classifyStreamId(id: number): { initiatedBy: StreamInitiator; direction: StreamDirection } {
  const bits = id & 0x3;
  return {
    initiatedBy: (bits & 0x1) === 0 ? 'client' : 'server',
    direction: (bits & 0x2) === 0 ? 'bidirectional' : 'unidirectional',
  };
}

export function firstStreamId(initiatedBy: StreamInitiator, direction: StreamDirection): number {
  let bits = 0;
  if (initiatedBy === 'server') bits |= 0x1;
  if (direction === 'unidirectional') bits |= 0x2;
  return bits;
}

export function createStream(id: number, initialMaxData = 65535): QuicStreamState {
  const { initiatedBy, direction } = classifyStreamId(id);
  return {
    id, direction, initiatedBy,
    sendOffset: 0, sendMaxData: initialMaxData,
    recvOffset: 0, recvMaxData: initialMaxData,
    finSent: false, finReceived: false,
  };
}

/** Sequentially allocates stream IDs within one of the four (initiator, direction) categories (RFC 9000 §2.1). */
export class StreamIdAllocator {
  private counters = new Map<string, number>();

  next(initiatedBy: StreamInitiator, direction: StreamDirection): number {
    const key = `${initiatedBy}-${direction}`;
    const n = this.counters.get(key) ?? 0;
    this.counters.set(key, n + 1);
    return firstStreamId(initiatedBy, direction) + n * 4;
  }
}

export interface SendResult {
  frame?: QuicFrame;
  blockedFrame?: QuicFrame;
  bytesSent: number;
}

/**
 * Manages one connection's streams: allocation for locally-initiated
 * streams, on-demand creation for peer-initiated ones, and flow control by
 * stream and by connection (RFC 9000 §4).
 */
export class QuicStreamManager {
  private readonly streams = new Map<number, QuicStreamState>();
  private readonly allocator = new StreamIdAllocator();
  connectionSendOffset = 0;
  connectionSendMaxData: number;
  connectionRecvOffset = 0;
  connectionRecvMaxData: number;

  constructor(private readonly localRole: StreamInitiator, initialConnectionMaxData = 65535) {
    this.connectionSendMaxData = initialConnectionMaxData;
    this.connectionRecvMaxData = initialConnectionMaxData;
  }

  openStream(direction: StreamDirection, initialStreamMaxData = 65535): QuicStreamState {
    const id = this.allocator.next(this.localRole, direction);
    const stream = createStream(id, initialStreamMaxData);
    this.streams.set(id, stream);
    return stream;
  }

  getOrCreatePeerStream(id: number, initialStreamMaxData = 65535): QuicStreamState {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = createStream(id, initialStreamMaxData);
      this.streams.set(id, stream);
    }
    return stream;
  }

  get(id: number): QuicStreamState | undefined {
    return this.streams.get(id);
  }

  /**
   * Attempts to send `data` on `stream`. Caps the send at
   * min(stream window, connection window); if that's exhausted, returns a
   * STREAM_DATA_BLOCKED (stream limited) or DATA_BLOCKED (connection
   * limited) frame instead, per RFC 9000 §4.1.
   */
  trySend(stream: QuicStreamState, data: Uint8Array, fin: boolean): SendResult {
    const streamAvailable = stream.sendMaxData - stream.sendOffset;
    const connAvailable = this.connectionSendMaxData - this.connectionSendOffset;
    const available = Math.max(0, Math.min(streamAvailable, connAvailable));

    if (available <= 0) {
      if (streamAvailable <= 0) {
        return { blockedFrame: { type: 'STREAM_DATA_BLOCKED', streamId: stream.id, maximumStreamData: stream.sendMaxData }, bytesSent: 0 };
      }
      return { blockedFrame: { type: 'DATA_BLOCKED', maximumData: this.connectionSendMaxData }, bytesSent: 0 };
    }

    const chunk = data.length <= available ? data : data.slice(0, available);
    const isFin = fin && chunk.length === data.length;
    const frame: QuicFrame = { type: 'STREAM', streamId: stream.id, offset: stream.sendOffset, length: chunk.length, fin: isFin, data: chunk };

    stream.sendOffset += chunk.length;
    this.connectionSendOffset += chunk.length;
    if (isFin) stream.finSent = true;

    return { frame, bytesSent: chunk.length };
  }

  /** Applies an incoming STREAM frame to the (possibly newly created) target stream. */
  receiveStreamFrame(frame: Extract<QuicFrame, { type: 'STREAM' }>): QuicStreamState {
    const stream = this.getOrCreatePeerStream(frame.streamId);
    const end = frame.offset + frame.length;
    if (end > stream.recvOffset) stream.recvOffset = end;
    this.connectionRecvOffset += frame.length;
    if (frame.fin) stream.finReceived = true;
    return stream;
  }

  receiveMaxStreamData(frame: Extract<QuicFrame, { type: 'MAX_STREAM_DATA' }>): void {
    const stream = this.streams.get(frame.streamId);
    if (stream && frame.maximumStreamData > stream.sendMaxData) stream.sendMaxData = frame.maximumStreamData;
  }

  receiveMaxData(frame: Extract<QuicFrame, { type: 'MAX_DATA' }>): void {
    if (frame.maximumData > this.connectionSendMaxData) this.connectionSendMaxData = frame.maximumData;
  }

  /** Grants more receive credit to a stream, producing the MAX_STREAM_DATA frame to send. */
  grantStreamCredit(stream: QuicStreamState, additionalBytes: number): QuicFrame {
    stream.recvMaxData += additionalBytes;
    return { type: 'MAX_STREAM_DATA', streamId: stream.id, maximumStreamData: stream.recvMaxData };
  }

  /** Grants more receive credit to the connection, producing the MAX_DATA frame to send. */
  grantConnectionCredit(additionalBytes: number): QuicFrame {
    this.connectionRecvMaxData += additionalBytes;
    return { type: 'MAX_DATA', maximumData: this.connectionRecvMaxData };
  }
}
