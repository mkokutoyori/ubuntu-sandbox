import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import type { IEventBus } from '@/events/EventBus';
import type { Http1RequestHandler } from '../http1/Http1ServerSession';
import type { ConnectionQuota } from '@/network/tcp/ConnectionQuota';
import { Http2Connection, type Http2ConnectionOptions } from './Http2Connection';
import { http2ToRequest, responseToHttp2 } from './Http2Messages';

export function http2RequestHandler(handler: Http1RequestHandler, peer: () => { ip: string; port: number }) {
  return (headers: [string, string][], body: Uint8Array) => {
    const produced = handler(http2ToRequest(headers, body), peer());
    return produced instanceof Promise ? produced.then(responseToHttp2) : responseToHttp2(produced);
  };
}

export class Http2ServerSession {
  private listener: TcpListener | null = null;
  private listenAddress = '0.0.0.0';

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly port: number,
    private readonly handler: Http1RequestHandler,
    private readonly options: Http2ConnectionOptions = {},
    private readonly quota?: ConnectionQuota,
    private readonly eventBus?: IEventBus,
  ) {}

  start(identity?: ListenerIdentity, backlog?: number, address = '0.0.0.0'): void {
    if (this.listener) return;
    this.listenAddress = address;
    this.listener = this.tcpStack.listen(this.port, {
      onAccept: (socket) => this.admit(socket),
      identity,
      backlog,
    }, address);
  }

  stop(): void {
    if (!this.listener) return;
    this.tcpStack.closeListener(this.port, this.listenAddress);
    this.listener = null;
  }

  private admit(socket: TcpSocket): void {
    if (this.quota === undefined) this.serve(socket);
    else this.quota.admit(socket, () => this.serve(socket));
  }

  private serve(socket: TcpSocket): void {
    new Http2Connection(
      socket, 'server',
      http2RequestHandler(this.handler, () => ({ ip: socket.remoteIp, port: socket.remotePort })),
      this.eventBus, this.options,
    );
  }
}
