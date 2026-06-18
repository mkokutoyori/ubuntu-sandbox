import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';

export type SwitchDebugCategory = 'arp' | 'mac' | 'link' | 'stp.events' | 'stp.bpdu';

const LABELS: Record<SwitchDebugCategory, string> = {
  arp: 'ARP packet',
  mac: 'MAC address table',
  link: 'Link state',
  'stp.events': 'Spanning Tree event',
  'stp.bpdu': 'Spanning Tree BPDU',
};

function mapScope(arg: string): SwitchDebugCategory[] | null {
  const w = arg.trim().toLowerCase().replace(/\s+/g, ' ');
  if (w === 'ip.arp' || w === 'arp') return ['arp'];
  if (w === 'mac' || w === 'mac address-table' || w === 'mac-address-table') return ['mac'];
  if (w === 'link' || w === 'link-state' || w === 'link state') return ['link'];
  if (w.startsWith('spanning-tree') || w.startsWith('spanning tree')) {
    const rest = w.replace(/^spanning[- ]tree\s*/, '');
    if (rest.startsWith('bpdu')) return ['stp.bpdu'];
    if (rest.startsWith('event')) return ['stp.events'];
    return ['stp.events', 'stp.bpdu'];
  }
  if (w === 'bpdu') return ['stp.bpdu'];
  if (w === 'event' || w === 'events') return ['stp.events'];
  return null;
}

export class SwitchDebugService implements TerminalDebugSource {
  private readonly flags = new Set<SwitchDebugCategory>();
  private all = false;
  private readonly broadcast = new DebugBroadcast();

  recognizes(arg: string): boolean {
    return mapScope(arg) !== null;
  }

  enable(arg: string): string {
    const cats = mapScope(arg);
    if (!cats) return `${arg.trim()} debugging is on`;
    for (const c of cats) this.flags.add(c);
    return `${LABELS[cats[0]]} debugging is on`;
  }

  disable(arg: string): string {
    const cats = mapScope(arg);
    if (!cats) return `${arg.trim()} debugging is off`;
    for (const c of cats) this.flags.delete(c);
    return `${LABELS[cats[0]]} debugging is off`;
  }

  enableAll(): string {
    this.all = true;
    return 'All possible debugging is on';
  }

  disableAll(): string {
    this.flags.clear();
    this.all = false;
    return 'All possible debugging has been turned off';
  }

  hasAnyFlag(): boolean { return this.all || this.flags.size > 0; }

  isStpEnabled(): boolean { return this.all || this.flags.has('stp.events') || this.flags.has('stp.bpdu'); }

  list(): string[] {
    return [...this.flags].map((c) => `${LABELS[c]} debugging is on`).sort();
  }

  format(): string {
    if (this.all) return 'All debugging is on';
    if (this.flags.size === 0) return 'No debugging is enabled';
    return this.list().join('\n');
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  private active(category: SwitchDebugCategory): boolean {
    return this.all || this.flags.has(category);
  }

  private emit(category: SwitchDebugCategory, line: string): void {
    if (!this.active(category)) return;
    this.broadcast.fan(line);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (!this.broadcast.beginAttach(bus, deviceId)) return;
    const mine = (p: { deviceId: string }) => p.deviceId === deviceId;

    this.broadcast.track(bus.subscribe('stp.role.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: ${p.port} role change ${p.oldRole} -> ${p.newRole}`);
    }));
    this.broadcast.track(bus.subscribe('stp.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: ${p.port} state change ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('stp.root.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: New root ${p.newRootMac} (priority ${p.newRootPriority}), root port ${p.rootPort ?? 'none'}`);
    }));
    this.broadcast.track(bus.subscribe('stp.topology.change', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: Topology change (${p.origin})${p.port ? ` on ${p.port}` : ''}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.bpdu', `STP: Tx BPDU on ${p.port} root ${p.rootMac} cost ${p.pathCost}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.bpdu', `STP: Rx BPDU on ${p.port} from ${p.senderMac} root ${p.rootMac}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu-guard.violation', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: BPDU guard violation on ${p.port} (sender ${p.senderMac})`);
    }));

    this.broadcast.track(bus.subscribe('switch.mac.learned', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('mac', `MAC: Learned ${p.mac} vlan ${p.vlan} on ${p.port} (dynamic)`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.moved', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('mac', `MAC: Moved ${p.mac} vlan ${p.vlan} from ${p.fromPort} to ${p.port}`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.aged', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('mac', `MAC: Aged out ${p.mac} vlan ${p.vlan} on ${p.port}`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.cleared', (e) => {
      if (!mine(e.payload)) return;
      this.emit('mac', `MAC: Cleared dynamic entries from address table`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.flushed', (e) => {
      if (!mine(e.payload)) return;
      this.emit('mac', `MAC: Flushed address table`);
    }));

    this.broadcast.track(bus.subscribe('port.link.up', (e) => {
      if (!mine(e.payload)) return;
      this.emit('link', `LINK: Interface ${e.payload.portName}, changed state to up`);
    }));
    this.broadcast.track(bus.subscribe('port.link.down', (e) => {
      if (!mine(e.payload)) return;
      this.emit('link', `LINK: Interface ${e.payload.portName}, changed state to down`);
    }));

    this.broadcast.track(bus.subscribe('port.frame.received', (e) => {
      if (!mine(e.payload)) return;
      const frame = e.payload.frame as { etherType?: number; srcMAC?: { toString(): string }; payload?: { operation?: string; senderIP?: { toString(): string }; targetIP?: { toString(): string } } };
      if (frame?.etherType !== 0x0806) return;
      const arp = frame.payload;
      const op = arp?.operation === 'reply' ? 'rep' : 'req';
      this.emit('arp', `ARP: rcvd ${op} src ${arp?.senderIP?.toString?.() ?? '?'} dst ${arp?.targetIP?.toString?.() ?? '?'} on ${e.payload.portName}`);
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }
}
