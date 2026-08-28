import { EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX } from '../../core/WellKnownPorts';
import { allocateEphemeralPort } from './EphemeralPorts';

export interface UdpBinding<Delivery> {
  readonly port: number;
  readonly owner: string;
  readonly handler: (delivery: Delivery) => void;
}

export type PortClaim = (port: number) => string | null;

export class UdpPortTable<Delivery> {
  private readonly bindings = new Map<number, UdpBinding<Delivery>>();
  private readonly claimedElsewhere: PortClaim;

  constructor(claimedElsewhere: PortClaim = () => null) {
    this.claimedElsewhere = claimedElsewhere;
  }

  ownerOf(port: number): string | null {
    return this.bindings.get(port)?.owner ?? this.claimedElsewhere(port);
  }

  isTaken(port: number): boolean {
    return this.ownerOf(port) !== null;
  }

  bind(port: number, handler: (delivery: Delivery) => void, owner = 'application'): boolean {
    if (this.isTaken(port)) return false;
    this.bindings.set(port, { port, owner, handler });
    return true;
  }

  close(port: number): void {
    this.bindings.delete(port);
  }

  deliver(port: number, delivery: Delivery): boolean {
    const binding = this.bindings.get(port);
    if (!binding) return false;
    binding.handler(delivery);
    return true;
  }

  allocateEphemeralPort(): number {
    return allocateEphemeralPort(
      EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX, (port) => this.isTaken(port));
  }

  boundPorts(): number[] {
    return [...this.bindings.keys()].sort((a, b) => a - b);
  }

  owners(): ReadonlyMap<number, string> {
    return new Map([...this.bindings.values()].map(b => [b.port, b.owner]));
  }
}
