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

/** RFC 2428 §2 — IPv4 (1) or IPv6 (2) net-prt tag inside `EPRT`/`EPSV`. */
export type NetProtocol = 1 | 2;

/** RFC 2428 §2 — `EPRT`'s `<d><net-prt><d><net-addr><d><tcp-port><d>`; `<d>` is any printable ASCII delimiter, conventionally `|`. Generalizes `PORT` to IPv6 without hardcoding the 4-octet form. */
export function encodeEprtArgument(protocol: NetProtocol, address: string, port: number, delimiter = '|'): string {
  return `${delimiter}${protocol}${delimiter}${address}${delimiter}${port}${delimiter}`;
}

export function decodeEprtArgument(arg: string): { protocol: NetProtocol; address: string; port: number } | null {
  if (arg.length < 2) return null;
  const delimiter = arg[0];
  const parts = arg.split(delimiter);
  if (parts.length < 5) return null;
  const protocol = parseInt(parts[1], 10);
  if (protocol !== 1 && protocol !== 2) return null;
  const address = parts[2];
  const port = parseInt(parts[3], 10);
  if (!address || Number.isNaN(port) || port <= 0 || port > 65535) return null;
  return { protocol, address, port };
}

/** RFC 2428 §3 — the `229` reply's `(<d><d><d><tcp-port><d>)`: net-prt/net-addr are omitted, since the client is expected to reuse the control connection's peer address. */
export function encodeEpsvReplyArgument(port: number, delimiter = '|'): string {
  return `(${delimiter}${delimiter}${delimiter}${port}${delimiter})`;
}

export function decodeEpsvReplyArgument(text: string): number | null {
  const match = /\(([^)]*)\)/.exec(text);
  if (!match) return null;
  const inner = match[1];
  if (inner.length < 1) return null;
  const delimiter = inner[0];
  const parts = inner.split(delimiter);
  const port = parseInt(parts[3] ?? '', 10);
  return Number.isNaN(port) ? null : port;
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

  /** `onAccept`, if given, fires right after `socket` is populated — e.g. `FtpServerSession` starting a `PROT P` TLS handshake before any transfer bytes flow (RFC 4217 §4). */
  constructor(readonly port: number, tcpStack: TcpStack, onAccept?: (socket: TcpSocket) => void) {
    this.listener = tcpStack.listen(port, { onAccept: (socket) => {
      this.socket = socket;
      onAccept?.(socket);
    } });
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
