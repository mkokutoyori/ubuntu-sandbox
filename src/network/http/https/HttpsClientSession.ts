/**
 * PRD-HTTP.md §2.1.K — HTTPS is HTTP/1.1 (RFC 9112) carried over a real
 * TLS 1.3 handshake (`TlsClientSession`, `PRD-TLS.md`) instead of the
 * plaintext `TcpSocket` that `Http1ClientSession` writes to directly.
 * Drives the handshake record-by-record over the wire (`TlsRecordWire.ts`),
 * then reuses `Http1Wire.ts`'s `encodeRequest`/`parseResponse` for the
 * application data, encrypted via `ApplicationDataCipher.ts`. Mirrors
 * `Http1ClientSession.ts`'s synchronous connect/send/parse shape.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { HttpMessage } from '../semantics/types';
import { encodeRequest, parseResponse, type Http1EncodeOptions } from '../http1/Http1Wire';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encodeRecords, decodeRecords } from './TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from './ApplicationDataCipher';
import { HstsStore } from './HstsStore';
import type { IEventBus } from '@/events/EventBus';
import { randomRequestId } from '../events';

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface HttpsSendResult {
  ok: boolean;
  error?: string;
  response?: HttpMessage;
  alpnProtocol?: string | null;
}

export type HttpsClientConfig = Omit<TlsClientConfig, 'alpn'> & { readonly alpn?: readonly string[] };

/**
 * RFC 9112 §9.3 — persistent by default, exactly like `Http1ClientSession`;
 * a single TCP connection (and single TLS session atop it) is reused
 * across `send()` calls until either side sends `Connection: close`.
 */
export class HttpsClientSession {
  private socket: TcpSocket | null = null;
  private tls: TlsClientSession | null = null;
  private clientSeq = 0;
  private serverSeq = 0;
  readonly hstsStore: HstsStore;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly port = 443,
    private readonly tlsConfig: HttpsClientConfig,
    hstsStore?: HstsStore,
    private readonly eventBus?: IEventBus,
  ) {
    this.hstsStore = hstsStore ?? new HstsStore();
  }

  private handshakeOverSocket(socket: TcpSocket, tls: TlsClientSession): void {
    const unsubscribe = socket.onData((data) => {
      if (tls.result !== null) return;
      const incoming = decodeRecords(binaryStringToBytes(String(data)));
      const nextFlight = tls.handle(incoming);
      if (nextFlight && nextFlight.length > 0) socket.write(bytesToBinaryString(encodeRecords(nextFlight)));
    });
    const firstFlight = tls.start();
    socket.write(bytesToBinaryString(encodeRecords(firstFlight)));
    unsubscribe();
  }

  private connectIfNeeded(): boolean {
    if (this.socket && this.socket.state === 'established' && this.tls?.result === 'success') return true;

    const socket = this.tcpStack.connect(this.targetIp, this.port);
    if (!socket || socket.state !== 'established') return false;

    const tls = new TlsClientSession({ ...this.tlsConfig, alpn: this.tlsConfig.alpn ?? ['http/1.1'] });
    this.handshakeOverSocket(socket, tls);

    if (tls.result !== 'success') {
      socket.close();
      this.socket = null;
      this.tls = null;
      return false;
    }

    this.socket = socket;
    this.tls = tls;
    this.clientSeq = 0;
    this.serverSeq = 0;
    return true;
  }

  send(request: HttpMessage, opts?: Http1EncodeOptions): HttpsSendResult {
    const requestId = randomRequestId();
    const method = request.method ?? 'GET';
    const target = request.target ?? '';
    this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method, target } });

    const fail = (error: string): HttpsSendResult => {
      this.eventBus?.publish({ topic: 'http.request.failed', payload: { requestId, method, target, error } });
      return { ok: false, error };
    };

    if (!this.connectIfNeeded() || !this.socket || !this.tls) {
      return fail(`TLS handshake with ${this.targetIp} port ${this.port} failed`);
    }
    const socket = this.socket;
    const tls = this.tls;

    const requestBytes = encoder.encode(encodeRequest(request, opts));
    const { records, nextSeq: clientNextSeq } = encryptApplicationData(tls.clientApplicationTrafficSecret!, this.clientSeq, requestBytes);

    let responseRecords: TlsRecord[] | null = null;
    const unsubscribe = socket.onData((data) => {
      responseRecords = decodeRecords(binaryStringToBytes(String(data)));
    });
    socket.write(bytesToBinaryString(encodeRecords(records)));
    unsubscribe();
    this.clientSeq = clientNextSeq;

    if (!responseRecords) return fail('Empty reply from server');

    const { plaintext, nextSeq: serverNextSeq } = decryptApplicationData(tls.serverApplicationTrafficSecret!, this.serverSeq, responseRecords);
    this.serverSeq = serverNextSeq;

    const parsed = parseResponse(decoder.decode(plaintext), { suppressBody: request.method === 'HEAD' });
    if (parsed.ok === false) return fail(parsed.reason);

    const hsts = parsed.message.headers.get('Strict-Transport-Security');
    if (hsts) this.hstsStore.record(this.targetIp, hsts, Date.now());

    if (parsed.message.headers.get('Connection')?.toLowerCase() === 'close') {
      socket.close();
      this.socket = null;
      this.tls = null;
    }
    this.eventBus?.publish({ topic: 'http.request.completed', payload: { requestId, method, target, statusCode: parsed.message.statusCode ?? 0 } });
    return { ok: true, response: parsed.message, alpnProtocol: tls.negotiatedAlpnProtocol };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.tls = null;
  }
}
