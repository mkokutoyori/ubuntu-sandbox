import type { ARPEntry, MACAddress } from '../core/types';

export const ARP_TIMEOUT_DEFAULT_SEC = 14_400;

export interface ArpCachePolicy {
  now(): number;
  timeoutSecFor(iface: string): number;
}

export class ArpCache extends Map<string, ARPEntry> {
  constructor(private readonly policy: ArpCachePolicy) {
    super();
  }

  override get(ip: string): ARPEntry | undefined {
    const entry = super.get(ip);
    if (!entry || !this.expired(entry)) return entry;
    this.delete(ip);
    return undefined;
  }

  override has(ip: string): boolean {
    return this.get(ip) !== undefined;
  }

  learn(ip: string, mac: MACAddress, iface: string): boolean {
    if (super.get(ip)?.type === 'static') return false;
    this.set(ip, { mac, iface, timestamp: this.policy.now(), type: 'dynamic' });
    return true;
  }

  addStatic(ip: string, mac: MACAddress, iface: string): void {
    this.set(ip, { mac, iface, timestamp: this.policy.now(), type: 'static' });
  }

  forgetDynamic(ip: string): void {
    const entry = super.get(ip);
    if (entry && entry.type !== 'static') this.delete(ip);
  }

  clearDynamic(): void {
    for (const [ip, entry] of this) {
      if (entry.type !== 'static') this.delete(ip);
    }
  }

  ageMs(entry: ARPEntry): number {
    return this.policy.now() - entry.timestamp;
  }

  remainingMs(entry: ARPEntry): number {
    return this.policy.timeoutSecFor(entry.iface) * 1000 - this.ageMs(entry);
  }

  expire(): void {
    for (const [ip, entry] of this) {
      if (this.expired(entry)) this.delete(ip);
    }
  }

  private expired(entry: ARPEntry): boolean {
    return entry.type !== 'static' && this.remainingMs(entry) <= 0;
  }
}
