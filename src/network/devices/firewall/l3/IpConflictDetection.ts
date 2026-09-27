import { IPAddress, MACAddress, type ARPPacket } from '../../../core/types';
import type { FirewallLogDraft } from '../logging/FirewallLogStore';
import { ipConflictLogDraft } from '../logging/IpConflictEvent';
import type { DuplicateAddressReport } from './ArpService';

const UNSPECIFIED_ADDRESS = new IPAddress('0.0.0.0');
const NO_HARDWARE_ADDRESS = new MACAddress([0, 0, 0, 0, 0, 0]);

export interface IpConflictHost {
  ownAddresses(): ReadonlyArray<{ readonly iface: string; readonly address: string }>;
  owningInterface(address: string): string | undefined;
  hardwareAddressOf(iface: string): MACAddress | null;
  indexOf(iface: string): number;
  vdomOf(iface: string): string;
  emitArp(packet: ARPPacket, iface: string): void;
  now(): number;
  log(vdom: string, draft: FirewallLogDraft): void;
  trap(iface: string): void;
}

export interface IpConflictCacheEntry {
  readonly index: number;
  readonly address: string;
  readonly mac: MACAddress;
  readonly iface: string;
}

export class IpConflictDetection {
  private enabled = false;

  constructor(private readonly host: IpConflictHost) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  cache(): IpConflictCacheEntry[] {
    return this.host.ownAddresses().map(({ iface, address }) => ({
      index: this.host.indexOf(iface),
      address,
      mac: this.host.hardwareAddressOf(iface) ?? NO_HARDWARE_ADDRESS,
      iface,
    }));
  }

  probe(only?: string): IpConflictCacheEntry[] {
    const probed = this.cache().filter((entry) => only === undefined || entry.iface === only);
    for (const entry of probed) {
      if (this.host.hardwareAddressOf(entry.iface) === null) continue;
      this.host.emitArp({
        type: 'arp', operation: 'request',
        senderMAC: entry.mac, senderIP: UNSPECIFIED_ADDRESS,
        targetMAC: NO_HARDWARE_ADDRESS, targetIP: new IPAddress(entry.address),
      }, entry.iface);
    }
    return probed;
  }

  probeWhenEnabled(only?: string): void {
    if (this.enabled) this.probe(only);
  }

  report(duplicate: DuplicateAddressReport): void {
    if (!this.enabled || !(duplicate.gratuitous || duplicate.operation === 'reply')) return;
    const owner = this.host.owningInterface(duplicate.address);
    if (owner === undefined) return;
    this.host.log(this.host.vdomOf(owner), ipConflictLogDraft(this.host.now(), {
      address: duplicate.address,
      claimedBy: duplicate.claimedBy,
      detectedOn: duplicate.iface,
      owner,
      ownerMac: this.host.hardwareAddressOf(owner) ?? NO_HARDWARE_ADDRESS,
    }));
    this.host.trap(duplicate.iface);
  }
}
