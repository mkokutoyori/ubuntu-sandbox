import type { TcpListener, TcpSocket, TcpStack } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsServerChannel } from '@/network/tls/TlsServerChannel';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import { TlsClientChannel } from '@/network/tls/TlsClientChannel';
import { runTlsHandshakeOverSocket } from '@/network/http/https/TlsRecordWire';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { IPAddress } from '@/network/core/types';
import { decodeRadiusPacket, encodeRadiusPacket, isRadiusDecodeError } from './codec';
import type { RadiusPacket } from './types';

export const RADSEC_PORT = 2083;
export const RADSEC_SECRET = 'radsec';

export interface RadSecEngine {
  handleStreamRequest(
    srcIp: IPAddress, srcPort: number, localIp: IPAddress, localPort: number,
    request: RadiusPacket, reply: (response: RadiusPacket) => void, secret?: string,
  ): void;
}

export interface RadSecServerSettings {
  readonly tlsConfig: () => TlsServerConfig;
  readonly onConnection: (clientIp: string, accepted: boolean) => void;
}

function radiusFrameLength(buffer: Uint8Array): number | null {
  if (buffer.length < 4) return null;
  return (buffer[2] << 8) | buffer[3];
}

export class RadSecServer {
  private listener: TcpListener | null = null;

  constructor(
    private readonly tcp: TcpStack, private readonly port: number, private readonly engine: RadSecEngine,
    private readonly settings: RadSecServerSettings,
  ) {}

  start(identity?: ListenerIdentity): void {
    this.listener = this.tcp.listen(this.port, { onAccept: (socket) => this.accept(socket), identity });
  }

  stop(): void {
    if (this.listener === null) return;
    this.tcp.closeListener(this.port);
    this.listener = null;
  }

  isRunning(): boolean { return this.listener !== null; }

  private accept(socket: TcpSocket): void {
    const tls = new TlsServerSession(this.settings.tlsConfig());
    let buffer = new Uint8Array(0);
    const channel: TlsServerChannel = new TlsServerChannel(socket, tls, {
      onHandshakeComplete: () => this.settings.onConnection(socket.remoteIp, true),
      onHandshakeRejected: () => { this.settings.onConnection(socket.remoteIp, false); channel.close(); },
      onData: (plaintext) => {
        const joined = new Uint8Array(buffer.length + plaintext.length);
        joined.set(buffer);
        joined.set(plaintext, buffer.length);
        buffer = joined;
        for (;;) {
          const length = radiusFrameLength(buffer);
          if (length === null || length < 20 || length > 4096) {
            if (length !== null) channel.close();
            return;
          }
          if (buffer.length < length) return;
          const packet = decodeRadiusPacket(buffer.subarray(0, length));
          buffer = buffer.slice(length);
          if (isRadiusDecodeError(packet)) { channel.close(); return; }
          this.engine.handleStreamRequest(
            new IPAddress(socket.remoteIp), socket.remotePort, new IPAddress(socket.localIp), socket.localPort, packet,
            (response) => channel.write(encodeRadiusPacket(response)), RADSEC_SECRET,
          );
        }
      },
    });
  }
}

export interface RadSecClientOutcome {
  readonly ok: boolean;
  readonly reply?: RadiusPacket;
  readonly reason?: string;
}

export function radSecExchange(tcp: TcpStack, address: string, port: number, request: RadiusPacket, tlsConfig: TlsClientConfig): RadSecClientOutcome {
  const socket = tcp.connect(address, port);
  if (!socket || socket.state !== 'established') return { ok: false, reason: 'connection failed' };
  const tls = new TlsClientSession(tlsConfig);
  const trailing: TlsRecord[] = [];
  runTlsHandshakeOverSocket(socket, tls, (records) => { trailing.push(...records); });
  if (tls.result !== 'success') {
    socket.close();
    return { ok: false, reason: 'TLS handshake failed' };
  }
  const channel = new TlsClientChannel(socket, tls);
  let answer: Uint8Array;
  try {
    if (trailing.length > 0) channel.receiveRecords(trailing);
    answer = channel.exchange(encodeRadiusPacket(request));
  } catch (error) {
    socket.close();
    return { ok: false, reason: error instanceof Error ? error.message : 'TLS failure' };
  }
  socket.close();
  if (answer.length === 0) return { ok: false, reason: 'no reply' };
  const decoded = decodeRadiusPacket(answer);
  return isRadiusDecodeError(decoded) ? { ok: false, reason: decoded.error } : { ok: true, reply: decoded };
}
