import type { INeighborEntry, INeighborResolver } from '../../../core/interfaces';
import { IPAddress, MACAddress, type ARPEntry, type ARPPacket } from '../../../core/types';
import type { InterfaceTable } from './InterfaceTable';

export type DuplicateAddressReport = {
  readonly address: string;
  readonly claimedBy: MACAddress;
  readonly iface: string;
};

export interface ArpServiceDeps {
  interfaces: InterfaceTable;
  macOf: (iface: string) => MACAddress;
  now?: () => number;
  agingSec?: number;
  resolveTimeoutMs?: number;
  onRequestNeeded?: (request: ARPPacket, iface: string) => void;
  onDuplicateAddress?: (report: DuplicateAddressReport) => void;
  proxyOwns?: (address: string, iface: string) => boolean;
  onCacheChanged?: () => void;
}

const DEFAULT_AGING_SEC = 14400;
const ZERO_MAC = '00:00:00:00:00:00';

interface PendingResolution {
  resolve: (mac: MACAddress) => void;
  reject: (error: Error) => void;
}

export class ArpService implements INeighborResolver<string> {
  private readonly cache = new Map<string, ARPEntry>();
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
    if (existing?.type === 'static') return;

    this.cache.set(address, { mac, iface, timestamp: this.now(), type: 'dynamic' });
    this.deps.onCacheChanged?.();
    this.settle(address, mac);
  }

  setStatic(address: string, mac: MACAddress, iface: string): void {
    this.cache.set(address, { mac, iface, timestamp: this.now(), type: 'static' });
    this.deps.onCacheChanged?.();
    this.settle(address, mac);
  }

  markFailed(address: string, iface: string): void {
    const existing = this.cache.get(address);
    if (existing?.type === 'static') return;

    this.cache.set(address, {
      mac: new MACAddress(ZERO_MAC), iface, timestamp: this.now(), type: 'failed',
    });
  }

  lookup(address: string): ARPEntry | undefined {
    return this.cache.get(address);
  }

  resolved(address: string): MACAddress | undefined {
    const entry = this.cache.get(address);
    return entry && entry.type !== 'failed' ? entry.mac : undefined;
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
      if (entry.type !== 'static' && entry.timestamp <= deadline) {
        this.cache.delete(address);
        removed++;
      }
    }
    return removed;
  }

  handleRequest(packet: ARPPacket, iface: string): ARPPacket | undefined {
    if (this.reportsDuplicate(packet, iface)) return undefined;
    this.learn(packet.senderIP.toString(), packet.senderMAC, iface);

    const target = packet.targetIP.toString();
    if (!this.answersFor(target, iface)) return undefined;

    return {
      type: 'arp',
      operation: 'reply',
      senderMAC: this.deps.macOf(iface),
      senderIP: new IPAddress(target),
      targetMAC: packet.senderMAC,
      targetIP: packet.senderIP,
    };
  }

  answersFor(address: string, iface: string): boolean {
    if (this.deps.interfaces.owningInterface(address) === iface) return true;
    return this.deps.proxyOwns?.(address, iface) === true;
  }

  handleReply(packet: ARPPacket, iface: string): void {
    if (this.reportsDuplicate(packet, iface)) return;
    this.learn(packet.senderIP.toString(), packet.senderMAC, iface);
  }

  private reportsDuplicate(packet: ARPPacket, iface: string): boolean {
    const sender = packet.senderIP.toString();
    if (this.deps.interfaces.owningInterface(sender) === undefined) return false;
    if (packet.senderMAC.equals(this.deps.macOf(iface))) return false;

    this.deps.onDuplicateAddress?.({ address: sender, claimedBy: packet.senderMAC, iface });
    return true;
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
    if (cached && cached.type !== 'failed') return Promise.resolve(cached.mac);

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
    const entry = this.cache.get(address);
    if (entry && entry.type !== 'failed') return;

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
