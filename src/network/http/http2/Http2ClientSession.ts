import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import { synchronousDialFailure } from '@/network/tcp/dial';
import type { HttpMessage } from '../semantics/types';
import { Http2Connection } from './Http2Connection';
import { requestToHttp2, http2ToResponse } from './Http2Messages';

export type Http2ConnectFailure = 'refused' | 'timeout' | 'unreachable';

export interface Http2SendResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly response?: HttpMessage;
}

const MICROTASK_BUDGET = 64;
const NO_BODY = new Uint8Array(0);

export class Http2ClientSession {
  private socket: TcpSocket | null = null;
  private connection: Http2Connection | null = null;
  private failure: Http2ConnectFailure | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly port = 80,
  ) {}

  get connectFailure(): Http2ConnectFailure | null {
    return this.failure;
  }

  adopt(socket: TcpSocket): void {
    this.socket = socket;
    this.connection = new Http2Connection(socket, 'client');
  }

  private connect(): Http2Connection | null {
    if (this.connection !== null && this.socket?.state === 'established') return this.connection;
    const socket = this.tcpStack.connect(this.targetIp, this.port);
    if (socket === null || socket.state !== 'established') {
      this.failure = synchronousDialFailure(this.tcpStack, this.targetIp, socket);
      return null;
    }
    this.failure = null;
    this.socket = socket;
    this.connection = new Http2Connection(socket, 'client');
    return this.connection;
  }

  send(request: HttpMessage): Http2SendResult {
    const connection = this.connect();
    if (connection === null) return { ok: false, error: `connection to ${this.targetIp} port ${this.port} failed` };
    const answer = connection.request(requestToHttp2(request, 'http'), request.body ?? NO_BODY);
    return answer === null ? { ok: false, error: 'Empty reply from server' } : { ok: true, response: http2ToResponse(answer) };
  }

  async sendAsync(request: HttpMessage): Promise<Http2SendResult> {
    const connection = this.connect();
    if (connection === null) return { ok: false, error: `connection to ${this.targetIp} port ${this.port} failed` };
    const answer = await connection.requestAsync(requestToHttp2(request, 'http'), request.body ?? NO_BODY, MICROTASK_BUDGET);
    return answer === null ? { ok: false, error: 'Empty reply from server' } : { ok: true, response: http2ToResponse(answer) };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connection = null;
  }
}
