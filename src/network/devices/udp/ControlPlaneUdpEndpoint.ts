import type { IPAddress } from '@/network/core/types';
import type { TftpEndpoint, TftpUdpDelivery } from '@/network/tftp/types';

export interface ControlPlaneUdpTransport {
  sendUdpBytes(
    destinationIP: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean;
}

const EPHEMERAL_MIN = 49152;
const EPHEMERAL_MAX = 65535;

export class ControlPlaneUdpEndpoint implements TftpEndpoint {
  private readonly binds = new Map<number, (delivery: TftpUdpDelivery) => void>();

  constructor(private readonly transport: ControlPlaneUdpTransport) {}

  allocateEphemeralPort(): number {
    const range = EPHEMERAL_MAX - EPHEMERAL_MIN + 1;
    for (let attempt = 0; attempt < 256; attempt++) {
      const port = EPHEMERAL_MIN + Math.floor(Math.random() * range);
      if (!this.binds.has(port)) return port;
    }
    for (let port = EPHEMERAL_MIN; port <= EPHEMERAL_MAX; port++) {
      if (!this.binds.has(port)) return port;
    }
    throw new Error('EADDRINUSE: No ephemeral ports available');
  }

  udpBind(port: number, handler: (delivery: TftpUdpDelivery) => void): boolean {
    if (this.binds.has(port)) return false;
    this.binds.set(port, handler);
    return true;
  }

  udpClose(port: number): void {
    this.binds.delete(port);
  }

  sendUdpDatagramTo(
    destinationIP: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean {
    return this.transport.sendUdpBytes(destinationIP, destinationPort, sourcePort, payload);
  }

  deliver(sourceIP: IPAddress, destinationPort: number, sourcePort: number, payload: unknown): boolean {
    const handler = this.binds.get(destinationPort);
    if (!handler) return false;
    handler({ udp: { sourcePort, payload }, sourceIP });
    return true;
  }

  boundPorts(): number[] {
    return [...this.binds.keys()].sort((a, b) => a - b);
  }
}
