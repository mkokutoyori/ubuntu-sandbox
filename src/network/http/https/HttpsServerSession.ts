/**
 * PRD-HTTP.md §2.1.K — server side of the HTTPS adapter: accepts TCP
 * connections on 443 (default), drives `TlsServerSession` (`PRD-TLS.md`)
 * record-by-record over the wire, then — once the handshake completes —
 * decrypts/parses HTTP/1.1 requests and encrypts/writes back responses,
 * mirroring `Http1ServerSession.ts`'s per-connection request loop.
 */
import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import { createResponse, type HttpMessage } from '../semantics/types';
import type { Http1RequestHandler } from '../http1/Http1ServerSession';
import { parseRequest, encodeResponse } from '../http1/Http1Wire';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { encodeRecords, decodeRecords } from './TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from './ApplicationDataCipher';

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

export type HttpsServerConfig = Omit<TlsServerConfig, 'alpnProtocols'> & {
  readonly alpnProtocols?: readonly string[];
  /** RFC 6797 — if set, every response carries `Strict-Transport-Security: max-age=<n>`. */
  readonly hstsMaxAgeSeconds?: number;
  readonly hstsIncludeSubDomains?: boolean;
};

export class HttpsServerSession {
  private listener: TcpListener | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly port: number,
    private readonly tlsConfig: HttpsServerConfig,
    private readonly handler: Http1RequestHandler,
  ) {}

  start(): void {
    this.listener = this.tcpStack.listen(this.port, { onAccept: (socket) => this.handleConnection(socket) });
  }

  stop(): void {
    if (!this.listener) return;
    this.tcpStack.closeListener(this.port);
    this.listener = null;
  }

  private applyHsts(response: HttpMessage): void {
    if (this.tlsConfig.hstsMaxAgeSeconds === undefined) return;
    const suffix = this.tlsConfig.hstsIncludeSubDomains ? '; includeSubDomains' : '';
    response.headers.set('Strict-Transport-Security', `max-age=${this.tlsConfig.hstsMaxAgeSeconds}${suffix}`);
  }

  private handleConnection(socket: TcpSocket): void {
    const tls = new TlsServerSession({ ...this.tlsConfig, alpnProtocols: this.tlsConfig.alpnProtocols ?? ['http/1.1'] });
    let clientSeq = 0;
    let serverSeq = 0;

    const unsubscribe = socket.onData((data) => {
      const incomingBytes = binaryStringToBytes(String(data));

      if (tls.result !== 'accept') {
        const incoming = decodeRecords(incomingBytes);
        const reply = tls.handle(incoming);
        if (reply && reply.length > 0) socket.write(bytesToBinaryString(encodeRecords(reply)));
        return;
      }

      const { plaintext: requestBytes, nextSeq: clientNextSeq } = decryptApplicationData(
        tls.clientApplicationTrafficSecret!, clientSeq, decodeRecords(incomingBytes),
      );
      clientSeq = clientNextSeq;

      const parsed = parseRequest(decoder.decode(requestBytes));
      let response: HttpMessage;
      let shouldClose: boolean;
      if (!parsed.ok) {
        response = createResponse(400, 'Bad Request');
        response.headers.set('Connection', 'close');
        shouldClose = true;
      } else {
        response = this.handler(parsed.message);
        shouldClose =
          parsed.message.headers.get('Connection')?.toLowerCase() === 'close' ||
          response.headers.get('Connection')?.toLowerCase() === 'close';
      }
      this.applyHsts(response);

      const chunked = response.headers.get('Transfer-Encoding')?.toLowerCase() === 'chunked';
      const responseBytes = encoder.encode(encodeResponse(response, { chunked }));
      const { records, nextSeq: serverNextSeq } = encryptApplicationData(tls.serverApplicationTrafficSecret!, serverSeq, responseBytes);
      serverSeq = serverNextSeq;
      socket.write(bytesToBinaryString(encodeRecords(records)));

      if (shouldClose) {
        unsubscribe();
        socket.close();
      }
    });
  }
}
