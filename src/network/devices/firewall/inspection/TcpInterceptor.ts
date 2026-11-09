import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import type { TcpStack, TcpListener, TcpSocket } from '../../../tcp/TcpStack';

export interface TcpInterceptorHooks {
  readonly tcp: () => TcpStack;
  readonly claimPort?: (port: number) => void;
  readonly releasePort?: (port: number) => void;
}

interface TcpSegmentView {
  readonly type?: string;
  readonly sourcePort?: number;
  readonly destinationPort?: number;
}

function segmentOf(packet: IPv4Packet): TcpSegmentView | null {
  if (packet.protocol !== IP_PROTO_TCP) return null;
  const segment = packet.payload as TcpSegmentView | undefined;
  return segment?.type === 'tcp' ? segment : null;
}

function flowKey(packet: IPv4Packet): string | null {
  const segment = segmentOf(packet);
  if (segment === null) return null;
  return `${packet.sourceIP.toString()}:${segment.sourcePort}`
    + `>${packet.destinationIP.toString()}:${segment.destinationPort}`;
}

function destinationPort(packet: IPv4Packet): number | null {
  return segmentOf(packet)?.destinationPort ?? null;
}

export abstract class TcpInterceptor<Config extends { readonly ports: readonly number[] }> {
  private readonly listeners = new Map<number, TcpListener>();
  private readonly captured = new Set<string>();
  private readonly pending = new Map<string, Config>();

  protected constructor(
    private readonly hooks: TcpInterceptorHooks,
    private readonly processName: string,
  ) {}

  protected abstract accept(socket: TcpSocket, config: Config): void;

  owns(packet: IPv4Packet): boolean {
    const key = flowKey(packet);
    return key !== null && this.captured.has(key);
  }

  resume(iface: string, packet: IPv4Packet): boolean {
    if (!this.owns(packet)) return false;
    return this.hooks.tcp().handleIp(iface, packet.sourceIP, packet);
  }

  capture(iface: string, packet: IPv4Packet, config: Config): boolean {
    const port = destinationPort(packet);
    if (port === null || !config.ports.includes(port)) return false;

    this.arm(port);
    const key = flowKey(packet);
    if (key === null) return false;
    this.captured.add(key);
    this.pending.set(
      `${packet.destinationIP.toString()}:${port}|${packet.sourceIP.toString()}`, config);
    return this.hooks.tcp().handleIp(iface, packet.sourceIP, packet);
  }

  isArmed(port: number): boolean { return this.listeners.has(port); }

  disarm(): void {
    for (const port of [...this.listeners.keys()]) {
      this.hooks.tcp().closeListener(port);
      this.listeners.delete(port);
      this.hooks.releasePort?.(port);
    }
    this.captured.clear();
    this.pending.clear();
  }

  private arm(port: number): void {
    if (this.listeners.has(port)) return;
    this.hooks.claimPort?.(port);
    const listener = this.hooks.tcp().listen(port, {
      onAccept: (socket) => { this.admit(socket); },
      identity: { processName: this.processName },
    });
    if (listener) this.listeners.set(port, listener);
  }

  private admit(socket: TcpSocket): void {
    const config = this.pending.get(`${socket.localIp}:${socket.localPort}|${socket.remoteIp}`);
    if (!config) { socket.close(); return; }

    socket.onClose(() => {
      this.captured.delete(
        `${socket.remoteIp}:${socket.remotePort}>${socket.localIp}:${socket.localPort}`);
    });
    this.accept(socket, config);
  }
}
