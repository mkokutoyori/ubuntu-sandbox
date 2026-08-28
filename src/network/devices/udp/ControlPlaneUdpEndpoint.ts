import type { IPAddress } from '@/network/core/types';
import type { TftpEndpoint, TftpUdpDelivery } from '@/network/tftp/types';
import { UdpPortTable, type PortClaim } from '@/network/layers/transport/UdpPortTable';

export interface ControlPlaneUdpTransport {
  sendUdpBytes(
    destinationIP: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean;
}

export class ControlPlaneUdpEndpoint implements TftpEndpoint {
  private readonly ports: UdpPortTable<TftpUdpDelivery>;

  constructor(
    private readonly transport: ControlPlaneUdpTransport,
    claimedByControlPlane: PortClaim = () => null,
  ) {
    this.ports = new UdpPortTable<TftpUdpDelivery>(claimedByControlPlane);
  }

  allocateEphemeralPort(): number {
    return this.ports.allocateEphemeralPort();
  }

  udpBind(
    port: number, handler: (delivery: TftpUdpDelivery) => void, owner?: string,
  ): boolean {
    return this.ports.bind(port, handler, owner);
  }

  udpClose(port: number): void {
    this.ports.close(port);
  }

  ownerOf(port: number): string | null {
    return this.ports.ownerOf(port);
  }

  sendUdpDatagramTo(
    destinationIP: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean {
    return this.transport.sendUdpBytes(destinationIP, destinationPort, sourcePort, payload);
  }

  deliver(sourceIP: IPAddress, destinationPort: number, sourcePort: number, payload: unknown): boolean {
    return this.ports.deliver(destinationPort, { udp: { sourcePort, payload }, sourceIP });
  }

  boundPorts(): number[] {
    return this.ports.boundPorts();
  }

  owners(): ReadonlyMap<number, string> {
    return this.ports.owners();
  }
}
