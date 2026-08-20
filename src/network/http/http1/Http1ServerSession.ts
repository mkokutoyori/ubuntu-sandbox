import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { createResponse, type HttpMessage } from '../semantics/types';
import { encodeResponse, parseRequest } from './Http1Wire';
import type { IEventBus } from '@/events/EventBus';
import { randomRequestId } from '../events';

/**
 * Le second paramètre est l'adresse du CLIENT, que le gestionnaire ne
 * pouvait pas connaître : la socket la porte, la requête non. Sans
 * elle, un journal d'accès ne peut pas nommer qui a demandé quoi, et
 * `$remote_addr` ne peut valoir qu'un espace réservé. Il est optionnel
 * pour que les gestionnaires qui l'ignorent restent inchangés.
 */
export interface Http1Peer {
  readonly ip: string;
  readonly port: number;
}

/**
 * Le gestionnaire peut rendre une promesse : l'authentification d'un
 * serveur peut être un vrai échange sur le fil (AAA/TACACS+ pour le
 * serveur web d'IOS), et un contrat synchrone obligerait ce serveur-là à
 * réimplémenter HTTP pour lui seul — un second moteur, donc deux
 * réponses possibles à la même requête. Les gestionnaires synchrones
 * (nginx, Apache, IIS) restent inchangés.
 */
export type Http1RequestHandler = (
  request: HttpMessage, peer?: Http1Peer,
) => HttpMessage | Promise<HttpMessage>;

/**
 * RFC 9112 §9.3 — accepts connections and keeps each one open across
 * multiple request/response exchanges (persistent by default in 1.1),
 * closing only on an explicit `Connection: close` from either side or a
 * malformed request.
 */
export class Http1ServerSession {
  private listener: TcpListener | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly port: number,
    private readonly handler: Http1RequestHandler,
    private readonly eventBus?: IEventBus,
  ) {}

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

  private handleConnection(socket: TcpSocket): void {
    const unsubscribe = socket.onData((data) => {
      const requestId = randomRequestId();
      const parsed = parseRequest(String(data));

      if (parsed.ok === false) {
        this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method: 'GET', target: '' } });
        this.eventBus?.publish({ topic: 'http.request.failed', payload: { requestId, method: 'GET', target: '', error: parsed.reason } });
        const response = createResponse(400, 'Bad Request');
        response.headers.set('Connection', 'close');
        this.writeResponse(socket, unsubscribe, response, true);
        return;
      }

      const method = parsed.message.method ?? 'GET';
      const target = parsed.message.target ?? '';
      this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method, target } });
      const produced = this.handler(parsed.message, { ip: socket.remoteIp, port: socket.remotePort });
      const settle = (response: HttpMessage): void => {
        this.eventBus?.publish({ topic: 'http.request.completed', payload: { requestId, method, target, statusCode: response.statusCode ?? 0 } });
        const shouldClose =
          parsed.message.headers.get('Connection')?.toLowerCase() === 'close' ||
          response.headers.get('Connection')?.toLowerCase() === 'close';
        this.writeResponse(socket, unsubscribe, response, shouldClose);
      };
      if (produced instanceof Promise) void produced.then(settle);
      else settle(produced);
    });
  }

  private writeResponse(
    socket: TcpSocket, unsubscribe: () => void,
    response: HttpMessage, shouldClose: boolean,
  ): void {
    const chunked = response.headers.get('Transfer-Encoding')?.toLowerCase() === 'chunked';
    socket.write(encodeResponse(response, { chunked }));
    if (shouldClose) {
      unsubscribe();
      socket.close();
    }
  }
}
