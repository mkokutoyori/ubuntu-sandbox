// RFC 9114 — HTTP/3: HTTP semantics mapped onto QUIC streams. One
// client-initiated bidirectional stream per request/response (§4.1); one
// unidirectional control stream per endpoint carrying a single SETTINGS
// frame (§6.2.1/§7.2.4). `QuicConnection` (delivered by `docs/PRD-QUIC.md`)
// is consumed as-is here, never modified (cf. PRD-HTTP.md §3.4/§0.1) — see
// `http3-quic-integration.test.ts` (P9) for the API contract this relies on.
import type { QuicConnection, QuicMessage } from '@/network/quic/QuicConnection';
import { classifyStreamId } from '@/network/quic/QuicStream';
import {
  type DecodedHttp3Frame, encodeFrame, decodeFrames,
  encodeSettingsPayload, decodeSettingsPayload, encodeGoawayPayload,
  CONTROL_STREAM_TYPE, type Http3Settings,
} from './Http3Frame';
import { encodeFieldSection, decodeFieldSection } from './Qpack';
import { encodeVarint, decodeVarint } from '@/network/quic/varint';

export type Http3Role = 'client' | 'server';

export interface Http3RequestResult {
  headers: [string, string][];
  body: Uint8Array;
}

export interface Http3RequestHandler {
  (headers: [string, string][], body: Uint8Array): Http3RequestResult;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

interface RequestStreamState {
  headers: [string, string][] | null;
  bodyChunks: Uint8Array[];
  buffer: Uint8Array;
}

interface UnidirectionalStreamState {
  typeConsumed: boolean;
  isControl: boolean;
  buffer: Uint8Array;
}

/**
 * Maps request/response semantics onto one already-established
 * `QuicConnection` (real TLS handshake done by the caller, P8). No
 * server-push, no QPACK dynamic table (encoder/decoder streams), no
 * enforcement of negotiated SETTINGS values — all explicit non-goals
 * (PRD-HTTP.md §2.2). Delivery through this simulator's `QuicConnection`
 * is synchronous end to end (`sendData` runs the peer's `onMessage`
 * handlers inline), so `request()` can return the response the same way
 * `Http2Connection.request()` does.
 */
export class Http3Connection {
  private readonly requestStreams = new Map<number, RequestStreamState>();
  private readonly unidirectionalStreams = new Map<number, UnidirectionalStreamState>();
  private readonly responseWaiters = new Map<number, (result: Http3RequestResult) => void>();
  private peerSettings: Http3Settings = {};
  private readonly ownControlStreamId: number;

  constructor(
    private readonly quic: QuicConnection,
    private readonly role: Http3Role,
    private readonly onRequest?: Http3RequestHandler,
  ) {
    this.quic.onMessage((msg) => this.handleMessage(msg));
    this.ownControlStreamId = this.quic.openStream('unidirectional');
    const settingsFrame = encodeFrame({ type: 'SETTINGS', payload: encodeSettingsPayload({}) });
    this.quic.sendData(this.ownControlStreamId, concatBytes([encodeVarint(CONTROL_STREAM_TYPE), settingsFrame]), false);
  }

  /** Client-only: opens a new request stream, sends the request, and returns the response (see class doc for why this is synchronous). */
  request(headers: [string, string][], body: Uint8Array = new Uint8Array(0)): Http3RequestResult | null {
    if (this.role !== 'client') throw new Error('request() is only valid for a client-role connection');
    const streamId = this.quic.openStream('bidirectional');
    this.requestStreams.set(streamId, { headers: null, bodyChunks: [], buffer: new Uint8Array(0) });

    let result: Http3RequestResult | null = null;
    this.responseWaiters.set(streamId, (r) => { result = r; });
    this.sendHeadersAndData(streamId, headers, body, true);
    return result;
  }

  /** RFC 9114 §5.2 — graceful shutdown: announce the last accepted stream on the control stream, then close the QUIC connection. */
  close(lastAcceptedStreamId = 0, errorCode = 0, reason = ''): void {
    const goawayFrame = encodeFrame({ type: 'GOAWAY', payload: encodeGoawayPayload(lastAcceptedStreamId) });
    this.quic.sendData(this.ownControlStreamId, goawayFrame, false);
    this.quic.close(errorCode, reason);
  }

  private sendHeadersAndData(streamId: number, headers: [string, string][], body: Uint8Array, fin: boolean): void {
    const headersFrame = encodeFrame({ type: 'HEADERS', payload: encodeFieldSection(headers) });
    const hasBody = body.length > 0;
    this.quic.sendData(streamId, headersFrame, hasBody ? false : fin);
    if (hasBody) {
      const dataFrame = encodeFrame({ type: 'DATA', payload: body });
      this.quic.sendData(streamId, dataFrame, fin);
    }
  }

  private handleMessage(msg: QuicMessage): void {
    const { direction } = classifyStreamId(msg.streamId);
    if (direction === 'unidirectional') this.handleUnidirectional(msg);
    else this.handleRequestStream(msg);
  }

  private handleUnidirectional(msg: QuicMessage): void {
    let state = this.unidirectionalStreams.get(msg.streamId);
    if (!state) {
      state = { typeConsumed: false, isControl: false, buffer: new Uint8Array(0) };
      this.unidirectionalStreams.set(msg.streamId, state);
    }
    state.buffer = concatBytes([state.buffer, msg.data]);

    if (!state.typeConsumed) {
      const typeResult = decodeVarint(state.buffer, 0);
      if (!typeResult) return;
      state.typeConsumed = true;
      state.isControl = typeResult.value === CONTROL_STREAM_TYPE;
      state.buffer = state.buffer.slice(typeResult.bytesConsumed);
    }

    if (!state.isControl) return; // QPACK encoder/decoder streams etc. — not modeled, cf. class doc.

    const { frames, rest } = decodeFrames(state.buffer);
    state.buffer = rest;
    for (const frame of frames) {
      if (frame.type === 'SETTINGS') this.peerSettings = decodeSettingsPayload(frame.payload);
    }
  }

  private handleRequestStream(msg: QuicMessage): void {
    let stream = this.requestStreams.get(msg.streamId);
    if (!stream) {
      stream = { headers: null, bodyChunks: [], buffer: new Uint8Array(0) };
      this.requestStreams.set(msg.streamId, stream);
    }
    stream.buffer = concatBytes([stream.buffer, msg.data]);

    const { frames, rest } = decodeFrames(stream.buffer);
    stream.buffer = rest;
    for (const frame of frames) this.applyFrame(stream, frame);

    if (msg.fin) this.completeRequestStream(msg.streamId, stream);
  }

  private applyFrame(stream: RequestStreamState, frame: DecodedHttp3Frame): void {
    if (frame.type === 'HEADERS') stream.headers = decodeFieldSection(frame.payload);
    else if (frame.type === 'DATA') stream.bodyChunks.push(frame.payload);
  }

  private completeRequestStream(streamId: number, stream: RequestStreamState): void {
    if (stream.headers === null) return;
    const body = concatBytes(stream.bodyChunks);

    if (this.role === 'server') {
      if (this.onRequest) {
        const result = this.onRequest(stream.headers, body);
        this.sendHeadersAndData(streamId, result.headers, result.body, true);
      }
      this.requestStreams.delete(streamId);
      return;
    }

    const waiter = this.responseWaiters.get(streamId);
    this.requestStreams.delete(streamId);
    if (waiter) {
      this.responseWaiters.delete(streamId);
      waiter({ headers: stream.headers, body });
    }
  }
}
