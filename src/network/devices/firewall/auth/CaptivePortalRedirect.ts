import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import { tryIpToUint32 } from '../../../core/ip';
import type { TcpStack, TcpListener, TcpSocket } from '../../../tcp/TcpStack';

export const CAPTURED_HTTP_PORT = 80;

export interface CaptivePortalDeps {
  readonly tcp: () => TcpStack;
  readonly portalPort: () => number;
  readonly portalScheme?: () => 'http' | 'https';
  readonly connectedRoutes: () => ReadonlyArray<{
    network: string; mask: string; iface: string;
  }>;
  readonly addressOf: (iface: string) => string | undefined;
  readonly authenticated: (iface: string, address: string) => boolean;
  readonly authRequiredByPolicy: () => boolean;
}

export class CaptivePortalRedirect {
  private listener: TcpListener | null = null;
  private readonly captured = new Set<string>();
  private readonly captiveInterfaces = new Set<string>();

  constructor(private readonly deps: CaptivePortalDeps) {}

  setInterfaceMode(iface: string, on: boolean): void {
    if (on) this.captiveInterfaces.add(iface); else this.captiveInterfaces.delete(iface);
    this.refresh();
  }

  refresh(): void {
    if (this.deps.authRequiredByPolicy() || this.captiveInterfaces.size > 0) {
      this.arm();
      return;
    }
    this.disarm();
  }

  claims(iface: string, packet: IPv4Packet): boolean {
    if (this.owns(packet)) return true;
    if (!this.captiveInterfaces.has(iface)) return false;
    if (!capturableHttp(packet)) return false;
    return !this.deps.authenticated(iface, packet.sourceIP.toString());
  }

  owns(packet: IPv4Packet): boolean {
    const key = flowKey(packet);
    return key !== null && this.captured.has(key);
  }

  arm(): void {
    if (this.listener) return;
    this.listener = this.deps.tcp().listen(CAPTURED_HTTP_PORT, {
      onAccept: (socket) => { this.serve(socket); },
      identity: { processName: 'httpsd' },
    });
  }

  disarm(): void {
    if (!this.listener) return;
    this.deps.tcp().closeListener(CAPTURED_HTTP_PORT);
    this.listener = null;
    this.captured.clear();
  }

  isArmed(): boolean { return this.listener !== null; }

  capture(iface: string, packet: IPv4Packet): boolean {
    if (!this.listener) return false;
    if (!capturableHttp(packet)) return false;

    const key = flowKey(packet);
    if (key !== null) this.captured.add(key);
    return this.deps.tcp().handleIp(iface, packet.sourceIP, packet);
  }

  private portalOrigin(clientAddress: string): string | undefined {
    const target = tryIpToUint32(clientAddress);
    if (target === null) return undefined;

    for (const route of this.deps.connectedRoutes()) {
      const mask = tryIpToUint32(route.mask);
      const network = tryIpToUint32(route.network);
      if (mask === null || network === null) continue;
      if (((target & mask) >>> 0) !== ((network & mask) >>> 0)) continue;

      const address = this.deps.addressOf(route.iface);
      const scheme = this.deps.portalScheme?.() ?? 'http';
      if (address !== undefined) return `${scheme}://${address}:${this.deps.portalPort()}`;
    }
    return undefined;
  }

  private serve(socket: TcpSocket): void {
    socket.onData(() => {
      const origin = this.portalOrigin(socket.remoteIp);
      socket.send(origin === undefined ? refusedBody() : redirectBody(origin));
      socket.close();
    });
    socket.onClose(() => {
      this.captured.delete(
        `${socket.remoteIp}:${socket.remotePort}>${socket.localIp}:${socket.localPort}`);
    });
  }
}

function flowKey(packet: IPv4Packet): string | null {
  const segment = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number;
  } | undefined;
  if (segment?.type !== 'tcp') return null;

  return `${packet.sourceIP.toString()}:${segment.sourcePort}`
    + `>${packet.destinationIP.toString()}:${segment.destinationPort}`;
}

export function capturableHttp(packet: IPv4Packet): boolean {
  if (packet.protocol !== IP_PROTO_TCP) return false;

  const segment = packet.payload as {
    type?: string; destinationPort?: number;
  } | undefined;
  return segment?.type === 'tcp' && segment.destinationPort === CAPTURED_HTTP_PORT;
}

function redirectBody(origin: string): string {
  const location = `${origin}/fgtauth`;
  return [
    'HTTP/1.1 303 See Other',
    `Location: ${location}`,
    'Content-Type: text/html',
    'Content-Length: 0',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

function refusedBody(): string {
  const body = '<html><body>Authentication required.</body></html>';
  return [
    'HTTP/1.1 403 Forbidden',
    'Content-Type: text/html',
    `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
}
