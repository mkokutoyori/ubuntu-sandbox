/**
 * PRD-HTTP.md §2.1.K — server side of the HTTPS adapter: accepts TCP
 * connections on 443 (default), drives `TlsServerSession` (`PRD-TLS.md`)
 * record-by-record over the wire, then — once the handshake completes —
 * decrypts/parses HTTP/1.1 requests and encrypts/writes back responses,
 * mirroring `Http1ServerSession.ts`'s per-connection request loop.
 */
import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { createResponse, type HttpMessage } from '../semantics/types';
import type { Http1RequestHandler } from '../http1/Http1ServerSession';
import { parseRequest, encodeResponse } from '../http1/Http1Wire';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { encodeRecords, decodeRecords } from './TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from './ApplicationDataCipher';
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
    private readonly eventBus?: IEventBus,
  ) {}

  /**
   * `identity` is the same one `Http1ServerSession.start` takes: the
   * listener sink (`ListenerSocketSink`) is what names the process in
   * `ss -ltnp`/`netstat`, and without it a TLS port would appear with no
   * owner while the cleartext port next to it has one — the two views of
   * the same machine disagreeing about the same server.
   */
  start(identity?: ListenerIdentity): void {
    this.listener = this.tcpStack.listen(this.port, {
      onAccept: (socket) => this.handleConnection(socket),
      identity,
    });
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
    /*
     * File des réponses de CETTE connexion. Un gestionnaire asynchrone ne
     * doit pas pouvoir doubler le précédent : `serverSeq` est le compteur
     * de séquence des enregistrements TLS, et deux réponses chiffrées
     * dans le désordre seraient rejetées par le pair — la protection est
     * authentifiée, donc l'ordre en fait partie.
     *
     * `pending` reste NUL tant que rien n'attend, et une réponse
     * synchrone part alors immédiatement : la faire passer par une
     * micro-tâche « pour l'uniformité » briserait tous les clients
     * synchrones de ce moteur, qui lisent la réponse pendant leur propre
     * `socket.write()` — mesuré, six cas de `https.test.ts` et
     * `iis-https-binding.test.ts` sont tombés sur cette seule nuance.
     */
    let pending: Promise<void> | null = null;
    const enqueue = (travail: () => void | Promise<void>): void => {
      const suite = pending === null ? travail() : pending.then(travail);
      if (!(suite instanceof Promise)) return;
      // Seule la QUEUE de la file a le droit de la vider : sans ce
      // contrôle, une réponse qui se termine effacerait la référence
      // d'une réponse arrivée entre-temps, et la suivante partirait sans
      // attendre son tour.
      const maillon: Promise<void> = suite.then(() => {
        if (pending === maillon) pending = null;
      });
      pending = maillon;
    };

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

      const requestId = randomRequestId();
      const parsed = parseRequest(decoder.decode(requestBytes));

      const emit = (response: HttpMessage, shouldClose: boolean): void => {
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
      };

      if (parsed.ok === false) {
        this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method: 'GET', target: '' } });
        this.eventBus?.publish({ topic: 'http.request.failed', payload: { requestId, method: 'GET', target: '', error: parsed.reason } });
        const response = createResponse(400, 'Bad Request');
        response.headers.set('Connection', 'close');
        // Une réponse d'erreur passe par la MÊME file que les autres,
        // sans quoi elle doublerait une réponse encore en attente et
        // les deux chiffrements se disputeraient le compteur de séquence.
        enqueue(() => emit(response, true));
        return;
      }

      const method = parsed.message.method ?? 'GET';
      const target = parsed.message.target ?? '';
      this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method, target } });
      const produced = this.handler(parsed.message, { ip: socket.remoteIp, port: socket.remotePort });
      /*
       * Un gestionnaire asynchrone ne doit pas pouvoir doubler le
       * précédent : `serverSeq` est le compteur de séquence des
       * enregistrements TLS, et deux réponses chiffrées dans le
       * désordre seraient rejetées par le pair — la protection est
       * authentifiée, donc l'ordre en fait partie. La file par connexion
       * est ce qui garantit qu'une réponse lente ne décale pas la suite.
       */
      const settle = (response: HttpMessage): void => {
        this.eventBus?.publish({ topic: 'http.request.completed', payload: { requestId, method, target, statusCode: response.statusCode ?? 0 } });
        const shouldClose =
          parsed.message.headers.get('Connection')?.toLowerCase() === 'close' ||
          response.headers.get('Connection')?.toLowerCase() === 'close';
        emit(response, shouldClose);
      };
      if (produced instanceof Promise) enqueue(() => produced.then(settle));
      else enqueue(() => { settle(produced); });
    });
  }
}
