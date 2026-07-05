import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import {
  type Http2Frame, encodeFrame, decodeFrames,
  FLAG_END_STREAM, FLAG_END_HEADERS, FLAG_ACK,
  encodeSettingsPayload, decodeSettingsPayload,
  encodeWindowUpdatePayload, decodeWindowUpdatePayload,
} from './Http2Frame';
import { HpackContext, encodeHeaderBlock, decodeHeaderBlock } from './Hpack';

// RFC 9113 §3.4 — h2c "prior knowledge": the client sends this fixed
// 24-octet preface immediately, no HTTP/1.1 Upgrade dance.
const CONNECTION_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
const DEFAULT_INITIAL_WINDOW = 65535;

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export type Http2Role = 'client' | 'server';

export interface Http2RequestResult {
  headers: [string, string][];
  body: Uint8Array;
}

export interface Http2RequestHandler {
  (headers: [string, string][], body: Uint8Array): Http2RequestResult;
}

interface StreamState {
  id: number;
  headerFragments: Uint8Array[];
  headers: [string, string][] | null;
  bodyChunks: Uint8Array[];
  endStream: boolean;
  sendWindow: number;
  recvWindow: number;
  pendingSend: Uint8Array | null;
  pendingEndStream: boolean;
}

/**
 * Multiplexes HTTP/2 (h2c, "prior knowledge") streams over one TcpSocket
 * (RFC 9113). No ALPN/TLS integration here — that's PRD-HTTP.md/P7, blocked
 * on PRD-TLS.md. Priority is not modeled (single stream-to-stream dependency
 * tree is out of scope, cf. §2.2); SETTINGS-advertised initial window
 * changes are not retroactively applied to already-open streams (a
 * deliberate simplification — WINDOW_UPDATE itself is fully real).
 */
export class Http2Connection {
  private readonly encoderCtx = new HpackContext();
  private readonly decoderCtx = new HpackContext();
  private readonly streams = new Map<number, StreamState>();
  private nextStreamId: number;
  private connectionSendWindow = DEFAULT_INITIAL_WINDOW;
  private connectionRecvWindow = DEFAULT_INITIAL_WINDOW;
  private incomingBuffer = new Uint8Array(0);
  private prefaceConsumed: boolean;
  private readonly responseWaiters = new Map<number, (result: Http2RequestResult) => void>();

  constructor(private readonly socket: TcpSocket, private readonly role: Http2Role, private readonly onRequest?: Http2RequestHandler) {
    this.nextStreamId = role === 'client' ? 1 : 2;
    this.prefaceConsumed = role === 'client';
    socket.onData((data) => this.handleIncoming(binaryStringToBytes(String(data))));
    if (role === 'client') {
      const settingsFrame = encodeFrame({ type: 'SETTINGS', flags: 0, streamId: 0, payload: encodeSettingsPayload({ initialWindowSize: DEFAULT_INITIAL_WINDOW }) });
      this.socket.write(CONNECTION_PREFACE + bytesToBinaryString(settingsFrame));
    }
  }

  static connect(tcpStack: TcpStack, targetIp: string, port: number): Http2Connection | null {
    const socket = tcpStack.connect(targetIp, port);
    if (!socket || socket.state !== 'established') return null;
    return new Http2Connection(socket, 'client');
  }

  static listen(tcpStack: TcpStack, port: number, onRequest: Http2RequestHandler): void {
    tcpStack.listen(port, { onAccept: (socket) => new Http2Connection(socket, 'server', onRequest) });
  }

  /** Client-only: opens a new stream, sends the request, and returns the response captured synchronously (this simulator's TCP delivery is inline end to end). */
  request(headers: [string, string][], body: Uint8Array = new Uint8Array(0)): Http2RequestResult | null {
    if (this.role !== 'client') throw new Error('request() is only valid for a client-role connection');
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = this.createStream(streamId);

    let result: Http2RequestResult | null = null;
    this.responseWaiters.set(streamId, (r) => { result = r; });
    this.sendHeadersAndData(stream, headers, body);
    return result;
  }

  private createStream(id: number): StreamState {
    const stream: StreamState = {
      id, headerFragments: [], headers: null, bodyChunks: [], endStream: false,
      sendWindow: DEFAULT_INITIAL_WINDOW, recvWindow: DEFAULT_INITIAL_WINDOW,
      pendingSend: null, pendingEndStream: false,
    };
    this.streams.set(id, stream);
    return stream;
  }

  private sendHeadersAndData(stream: StreamState, headers: [string, string][], body: Uint8Array): void {
    const headerBytes = encodeHeaderBlock(this.encoderCtx, headers);
    const hasBody = body.length > 0;
    const headersFrame = encodeFrame({
      type: 'HEADERS', streamId: stream.id, payload: headerBytes,
      flags: FLAG_END_HEADERS | (hasBody ? 0 : FLAG_END_STREAM),
    });
    this.socket.write(bytesToBinaryString(headersFrame));
    if (hasBody) this.sendDataRespectingWindow(stream, body, true);
  }

  /**
   * RFC 9113 §6.9 — a DATA send is capped by min(stream window, connection
   * window); the remainder is queued until WINDOW_UPDATE arrives.
   *
   * All bookkeeping (window decrement, pendingSend) happens BEFORE
   * `socket.write()`: this simulator's TCP delivery is synchronous end to
   * end, so `write()` can re-enter this same method (peer replies with
   * WINDOW_UPDATE, which flushes this stream again) before returning —
   * touching `stream`/`connectionSendWindow` after the write would clobber
   * whatever that reentrant call already committed.
   */
  private sendDataRespectingWindow(stream: StreamState, body: Uint8Array, endStream: boolean): void {
    const available = Math.max(0, Math.min(stream.sendWindow, this.connectionSendWindow));
    if (available <= 0) {
      stream.pendingSend = body;
      stream.pendingEndStream = endStream;
      return;
    }
    const now = body.length <= available ? body : body.slice(0, available);
    const remaining = body.length <= available ? null : body.slice(available);

    stream.sendWindow -= now.length;
    this.connectionSendWindow -= now.length;
    if (remaining !== null) {
      stream.pendingSend = remaining;
      stream.pendingEndStream = endStream;
    } else {
      stream.pendingSend = null;
      stream.pendingEndStream = false;
    }

    const frame = encodeFrame({ type: 'DATA', flags: remaining === null && endStream ? FLAG_END_STREAM : 0, streamId: stream.id, payload: now });
    this.socket.write(bytesToBinaryString(frame));
  }

  private flushPending(streamId: number): void {
    if (streamId === 0) {
      for (const stream of this.streams.values()) this.tryFlushStream(stream);
    } else {
      const stream = this.streams.get(streamId);
      if (stream) this.tryFlushStream(stream);
    }
  }

  private tryFlushStream(stream: StreamState): void {
    const pending = stream.pendingSend;
    if (!pending) return;
    stream.pendingSend = null;
    const endStream = stream.pendingEndStream;
    stream.pendingEndStream = false;
    this.sendDataRespectingWindow(stream, pending, endStream);
  }

  private handleIncoming(newBytes: Uint8Array): void {
    this.incomingBuffer = concatBytes([this.incomingBuffer, newBytes]);

    if (this.role === 'server' && !this.prefaceConsumed) {
      if (this.incomingBuffer.length < CONNECTION_PREFACE.length) return;
      const prefaceText = new TextDecoder().decode(this.incomingBuffer.slice(0, CONNECTION_PREFACE.length));
      if (prefaceText !== CONNECTION_PREFACE) {
        this.socket.close();
        return;
      }
      this.incomingBuffer = this.incomingBuffer.slice(CONNECTION_PREFACE.length);
      this.prefaceConsumed = true;
      const settingsFrame = encodeFrame({ type: 'SETTINGS', flags: 0, streamId: 0, payload: encodeSettingsPayload({ initialWindowSize: DEFAULT_INITIAL_WINDOW }) });
      this.socket.write(bytesToBinaryString(settingsFrame));
    }

    const { frames, rest } = decodeFrames(this.incomingBuffer);
    this.incomingBuffer = rest;
    for (const frame of frames) this.handleFrame(frame);
  }

  private handleFrame(frame: Http2Frame): void {
    switch (frame.type) {
      case 'SETTINGS':
        if (!(frame.flags & FLAG_ACK)) {
          decodeSettingsPayload(frame.payload);
          this.socket.write(bytesToBinaryString(encodeFrame({ type: 'SETTINGS', flags: FLAG_ACK, streamId: 0, payload: new Uint8Array(0) })));
        }
        return;

      case 'WINDOW_UPDATE': {
        const increment = decodeWindowUpdatePayload(frame.payload);
        if (frame.streamId === 0) this.connectionSendWindow += increment;
        else {
          const stream = this.streams.get(frame.streamId);
          if (stream) stream.sendWindow += increment;
        }
        this.flushPending(frame.streamId);
        return;
      }

      case 'HEADERS': {
        const stream = this.streams.get(frame.streamId) ?? this.createStream(frame.streamId);
        stream.headerFragments.push(frame.payload);
        if (frame.flags & FLAG_END_HEADERS) {
          stream.headers = decodeHeaderBlock(this.decoderCtx, concatBytes(stream.headerFragments));
          stream.headerFragments = [];
        }
        if (frame.flags & FLAG_END_STREAM) {
          stream.endStream = true;
          this.maybeCompleteStream(stream);
        }
        return;
      }

      case 'DATA': {
        const stream = this.streams.get(frame.streamId);
        if (!stream) return;
        stream.bodyChunks.push(frame.payload);
        stream.recvWindow -= frame.payload.length;
        this.connectionRecvWindow -= frame.payload.length;
        this.replenishWindowIfLow(stream);
        if (frame.flags & FLAG_END_STREAM) {
          stream.endStream = true;
          this.maybeCompleteStream(stream);
        }
        return;
      }

      case 'RST_STREAM':
        this.streams.delete(frame.streamId);
        return;

      case 'PING':
        if (!(frame.flags & FLAG_ACK)) {
          this.socket.write(bytesToBinaryString(encodeFrame({ type: 'PING', flags: FLAG_ACK, streamId: 0, payload: frame.payload })));
        }
        return;

      case 'GOAWAY':
      case 'PRIORITY':
      case 'CONTINUATION':
      default:
        return;
    }
  }

  private replenishWindowIfLow(stream: StreamState): void {
    const half = DEFAULT_INITIAL_WINDOW / 2;
    if (stream.recvWindow < half) {
      const inc = DEFAULT_INITIAL_WINDOW - stream.recvWindow;
      stream.recvWindow += inc;
      this.socket.write(bytesToBinaryString(encodeFrame({ type: 'WINDOW_UPDATE', flags: 0, streamId: stream.id, payload: encodeWindowUpdatePayload(inc) })));
    }
    if (this.connectionRecvWindow < half) {
      const inc = DEFAULT_INITIAL_WINDOW - this.connectionRecvWindow;
      this.connectionRecvWindow += inc;
      this.socket.write(bytesToBinaryString(encodeFrame({ type: 'WINDOW_UPDATE', flags: 0, streamId: 0, payload: encodeWindowUpdatePayload(inc) })));
    }
  }

  private maybeCompleteStream(stream: StreamState): void {
    if (!stream.endStream || stream.headers === null) return;
    const body = concatBytes(stream.bodyChunks);

    if (this.role === 'server') {
      if (this.onRequest) {
        const result = this.onRequest(stream.headers, body);
        this.sendHeadersAndData(stream, result.headers, result.body);
      }
      this.streams.delete(stream.id);
    } else {
      const waiter = this.responseWaiters.get(stream.id);
      this.streams.delete(stream.id);
      if (waiter) {
        this.responseWaiters.delete(stream.id);
        waiter({ headers: stream.headers, body });
      }
    }
  }
}
