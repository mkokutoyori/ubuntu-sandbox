import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { createResponse, type HttpMessage } from '../semantics/types';
import { encodeResponse, parseRequest } from './Http1Wire';
import type { IEventBus } from '@/events/EventBus';
import { randomRequestId } from '../events';

export type Http1RequestHandler = (request: HttpMessage) => HttpMessage;

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
      let response: HttpMessage;
      let shouldClose: boolean;

      if (parsed.ok === false) {
        this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method: 'GET', target: '' } });
        this.eventBus?.publish({ topic: 'http.request.failed', payload: { requestId, method: 'GET', target: '', error: parsed.reason } });
        response = createResponse(400, 'Bad Request');
        response.headers.set('Connection', 'close');
        shouldClose = true;
      } else {
        const method = parsed.message.method ?? 'GET';
        const target = parsed.message.target ?? '';
        this.eventBus?.publish({ topic: 'http.request.started', payload: { requestId, method, target } });
        response = this.handler(parsed.message);
        this.eventBus?.publish({ topic: 'http.request.completed', payload: { requestId, method, target, statusCode: response.statusCode ?? 0 } });
        shouldClose =
          parsed.message.headers.get('Connection')?.toLowerCase() === 'close' ||
          response.headers.get('Connection')?.toLowerCase() === 'close';
      }

      const chunked = response.headers.get('Transfer-Encoding')?.toLowerCase() === 'chunked';
      socket.write(encodeResponse(response, { chunked }));
      if (shouldClose) {
        unsubscribe();
        socket.close();
      }
    });
  }
}
