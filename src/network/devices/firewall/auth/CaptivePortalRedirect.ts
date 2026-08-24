import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import { tryIpToUint32 } from '../../../core/ip';
import { createResponse, type HttpMessage } from '../../../http/semantics/types';
import type { TcpStack } from '../../../tcp/TcpStack';

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
  readonly onArmedChanged?: () => void;
}

export class CaptivePortalRedirect {
  private armed = false;
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
    if (this.armed) return;
    this.armed = true;
    this.deps.onArmedChanged?.();
  }

  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.captured.clear();
    this.deps.onArmedChanged?.();
  }

  isArmed(): boolean { return this.armed; }

  capture(iface: string, packet: IPv4Packet): boolean {
    if (!this.armed) return false;
    if (!capturableHttp(packet)) return false;

    const key = flowKey(packet);
    if (key !== null) this.captured.add(key);
    return this.deps.tcp().handleIp(iface, packet.sourceIP, packet);
  }

  responseFor(client: { ip: string; port: number }): HttpMessage | null {
    const prefix = `${client.ip}:${client.port}>`;
    const key = [...this.captured].find(entry => entry.startsWith(prefix));
    if (key === undefined) return null;
    this.captured.delete(key);

    const origin = this.portalOrigin(client.ip);
    return origin === undefined ? refusedPage() : redirectPage(origin);
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

function redirectPage(origin: string): HttpMessage {
  const response = createResponse(303, 'See Other');
  response.headers.set('Location', `${origin}/fgtauth`);
  response.headers.set('Content-Type', 'text/html');
  response.headers.set('Content-Length', '0');
  response.headers.set('Connection', 'close');
  return response;
}

function refusedPage(): HttpMessage {
  const body = '<html><body>Authentication required.</body></html>';
  const response = createResponse(403, 'Forbidden');
  response.headers.set('Content-Type', 'text/html');
  response.headers.set('Content-Length', String(body.length));
  response.headers.set('Connection', 'close');
  response.body = new Uint8Array([...body].map(c => c.charCodeAt(0)));
  return response;
}
