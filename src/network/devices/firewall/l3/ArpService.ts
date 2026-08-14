import type { INeighborEntry, INeighborResolver } from '../../../core/interfaces';
import { IPAddress, MACAddress, type ARPPacket } from '../../../core/types';
import type { InterfaceTable } from './InterfaceTable';

export interface ArpEntry extends INeighborEntry {
  readonly isStatic: boolean;
}

export interface ArpServiceDeps {
  interfaces: InterfaceTable;
  macOf: (iface: string) => MACAddress;
  now?: () => number;
  agingSec?: number;
  resolveTimeoutMs?: number;
  onRequestNeeded?: (request: ARPPacket, iface: string) => void;
}

const DEFAULT_AGING_SEC = 14400;
const ZERO_MAC = '00:00:00:00:00:00';

interface PendingResolution {
  resolve: (mac: MACAddress) => void;
  reject: (error: Error) => void;
}

export class ArpService implements INeighborResolver<string> {
  private readonly cache = new Map<string, ArpEntry>();
  private readonly pending = new Map<string, PendingResolution[]>();
  private readonly deps: ArpServiceDeps;
  private readonly now: () => number;
  private readonly agingMs: number;

  constructor(deps: ArpServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.agingMs = (deps.agingSec ?? DEFAULT_AGING_SEC) * 1000;
  }

  learn(address: string, mac: MACAddress, iface: string): void {
    const existing = this.cache.get(address);
    if (existing?.isStatic) return;

    this.cache.set(address, { mac, iface, timestamp: this.now(), isStatic: false });
    this.settle(address, mac);
  }

  setStatic(address: string, mac: MACAddress, iface: string): void {
    this.cache.set(address, { mac, iface, timestamp: this.now(), isStatic: true });
    this.settle(address, mac);
  }

  lookup(address: string): ArpEntry | undefined {
    return this.cache.get(address);
  }

  getCache(): Map<string, INeighborEntry> {
    return new Map(this.cache);
  }

  clear(): void {
    this.cache.clear();
  }

  clearInterface(iface: string): number {
    let removed = 0;
    for (const [address, entry] of [...this.cache]) {
      if (entry.iface === iface) { this.cache.delete(address); removed++; }
    }
    return removed;
  }

  sweep(): number {
    const deadline = this.now() - this.agingMs;
    let removed = 0;
    for (const [address, entry] of [...this.cache]) {
      if (!entry.isStatic && entry.timestamp <= deadline) {
        this.cache.delete(address);
        removed++;
      }
    }
    return removed;
  }

  handleRequest(packet: ARPPacket, iface: string): ARPPacket | undefined {
    this.learn(packet.senderIP.toString(), packet.senderMAC, iface);

    const target = packet.targetIP.toString();
    const owning = this.deps.interfaces.owningInterface(target);
    if (owning !== iface) return undefined;

    return {
      type: 'arp',
      operation: 'reply',
      senderMAC: this.deps.macOf(iface),
      senderIP: new IPAddress(target),
      targetMAC: packet.senderMAC,
      targetIP: packet.senderIP,
    };
  }

  handleReply(packet: ARPPacket, iface: string): void {
    this.learn(packet.senderIP.toString(), packet.senderMAC, iface);
  }

  buildRequest(targetAddress: string, iface: string): ARPPacket | undefined {
    const source = this.deps.interfaces.get(iface)?.ip;
    if (source === undefined) return undefined;

    return {
      type: 'arp',
      operation: 'request',
      senderMAC: this.deps.macOf(iface),
      senderIP: new IPAddress(source),
      targetMAC: new MACAddress(ZERO_MAC),
      targetIP: new IPAddress(targetAddress),
    };
  }

  buildGratuitous(iface: string): ARPPacket | undefined {
    const source = this.deps.interfaces.get(iface)?.ip;
    if (source === undefined) return undefined;

    return {
      type: 'arp',
      operation: 'request',
      senderMAC: this.deps.macOf(iface),
      senderIP: new IPAddress(source),
      targetMAC: new MACAddress(ZERO_MAC),
      targetIP: new IPAddress(source),
    };
  }

  resolve(address: string, iface: string): Promise<MACAddress> {
    const cached = this.cache.get(address);
    if (cached) return Promise.resolve(cached.mac);

    const request = this.buildRequest(address, iface);
    if (!request) return Promise.reject(new Error(`no source address on ${iface}`));

    return new Promise<MACAddress>((resolve, reject) => {
      const waiters = this.pending.get(address) ?? [];
      waiters.push({ resolve, reject });
      this.pending.set(address, waiters);

      this.deps.onRequestNeeded?.(request, iface);
      queueMicrotask(() => this.failIfStillPending(address));
    });
  }

  private failIfStillPending(address: string): void {
    if (this.cache.has(address)) return;

    const waiters = this.pending.get(address);
    if (!waiters) return;

    this.pending.delete(address);
    for (const waiter of waiters) {
      waiter.reject(new Error(`ARP resolution failed for ${address}`));
    }
  }

  private settle(address: string, mac: MACAddress): void {
    const waiters = this.pending.get(address);
    if (!waiters) return;

    this.pending.delete(address);
    for (const waiter of waiters) waiter.resolve(mac);
  }
}
