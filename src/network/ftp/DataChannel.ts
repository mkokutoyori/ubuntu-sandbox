/**
 * FTP (RFC 959 §2.3, §4.1.2) — data channel negotiation. A second,
 * independent `TcpSocket` from the control connection: active mode
 * (`PORT`/`EPRT`) has the client listen and the server connect out to
 * it; passive mode (`PASV`/`EPSV`) has the server listen and the client
 * connect in. The address given by `PORT`/`EPRT` is deliberately not
 * required to match the control connection's peer (FXP, `PRD-FTP-SFTP.md`
 * §2.1.6) — nothing here enforces that.
 */
import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';

export type DataChannelMode = 'active' | 'passive';

export interface DataChannelEndpoint {
  readonly mode: DataChannelMode;
  readonly address: string;
  readonly port: number;
}

/** RFC 959 §4.1.2 — `h1,h2,h3,h4,p1,p2`: dotted IPv4 octets, then the port split into two bytes. */
export function encodePortArgument(ip: string, port: number): string {
  return `${ip.split('.').join(',')},${(port >> 8) & 0xff},${port & 0xff}`;
}

export function decodePortArgument(arg: string): { address: string; port: number } | null {
  const parts = arg.split(',').map((p) => parseInt(p.trim(), 10));
  if (parts.length !== 6 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  const [a, b, c, d, p1, p2] = parts;
  return { address: `${a}.${b}.${c}.${d}`, port: (p1 << 8) | p2 };
}

/** RFC 959 §4.6 recommends the passive port come from a bounded range; real servers (vsftpd's `pasv_min_port`/`pasv_max_port`) do the same. */
const PASSIVE_PORT_MIN = 30000;
const PASSIVE_PORT_MAX = 30999;
let nextPassivePort = PASSIVE_PORT_MIN;

export function allocatePassivePort(): number {
  const port = nextPassivePort;
  nextPassivePort = nextPassivePort >= PASSIVE_PORT_MAX ? PASSIVE_PORT_MIN : nextPassivePort + 1;
  return port;
}

export interface ActiveDataChannel {
  readonly mode: 'active';
  readonly address: string;
  readonly port: number;
}

/** Server-side passive listener; `socket` is populated once the client connects in (§ handleAccept). */
export class PassiveDataChannel {
  readonly mode = 'passive' as const;
  socket: TcpSocket | null = null;
  private readonly listener: TcpListener;

  constructor(readonly port: number, tcpStack: TcpStack) {
    this.listener = tcpStack.listen(port, { onAccept: (socket) => { this.socket = socket; } });
  }

  close(tcpStack: TcpStack): void {
    this.socket?.close();
    this.socket = null;
    tcpStack.closeListener(this.listener.localPort, this.listener.localIp);
  }
}

export type FtpDataChannel = ActiveDataChannel | PassiveDataChannel;

/** Opens (passive: already-accepted, active: server dials out) the actual data `TcpSocket` for one transfer. */
export function openDataConnection(channel: FtpDataChannel, tcpStack: TcpStack): TcpSocket | null {
  if (channel.mode === 'passive') return channel.socket;
  const socket = tcpStack.connect(channel.address, channel.port);
  return socket && socket.state === 'established' ? socket : null;
}
