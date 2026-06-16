import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';

export type StpDebugCategory = 'events' | 'bpdu';

export class SwitchDebugService implements TerminalDebugSource {
  private readonly flags = new Set<StpDebugCategory>();
  private readonly broadcast = new DebugBroadcast();

  enable(what: string): string {
    for (const category of this.parse(what)) this.flags.add(category);
    return `Spanning Tree ${what || 'all'} debugging is on`;
  }

  disable(what: string): string {
    if (!what || what.toLowerCase() === 'all') this.flags.clear();
    else for (const category of this.parse(what)) this.flags.delete(category);
    return `Spanning Tree ${what || 'all'} debugging is off`;
  }

  disableAll(): string {
    const n = this.flags.size;
    this.flags.clear();
    return n === 0 ? 'No debugging is enabled' : 'All possible debugging has been turned off';
  }

  hasAnyFlag(): boolean { return this.flags.size > 0; }

  list(): string[] {
    return [...this.flags].map((c) => `Spanning Tree ${c} debugging is on`).sort();
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  private parse(what: string): StpDebugCategory[] {
    const w = (what || 'all').toLowerCase();
    if (w.startsWith('bpdu')) return ['bpdu'];
    if (w.startsWith('event')) return ['events'];
    return ['events', 'bpdu'];
  }

  private emit(category: StpDebugCategory, line: string): void {
    if (!this.flags.has(category)) return;
    this.broadcast.fan(line);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (this.broadcast.attachedDeviceId === deviceId) return;
    this.detachFromBus();
    this.broadcast.attachedDeviceId = deviceId;
    const mine = (p: { deviceId: string }) => p.deviceId === deviceId;
    this.broadcast.track(bus.subscribe('stp.role.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('events', `STP: ${p.port} role change ${p.oldRole} -> ${p.newRole}`);
    }));
    this.broadcast.track(bus.subscribe('stp.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('events', `STP: ${p.port} state change ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('stp.root.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('events', `STP: New root ${p.newRootMac} (priority ${p.newRootPriority}), root port ${p.rootPort ?? 'none'}`);
    }));
    this.broadcast.track(bus.subscribe('stp.topology.change', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('events', `STP: Topology change (${p.origin})${p.port ? ` on ${p.port}` : ''}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('bpdu', `STP: Tx BPDU on ${p.port} root ${p.rootMac} cost ${p.pathCost}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('bpdu', `STP: Rx BPDU on ${p.port} from ${p.senderMac} root ${p.rootMac}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu-guard.violation', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('events', `STP: BPDU guard violation on ${p.port} (sender ${p.senderMac})`);
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }
}
