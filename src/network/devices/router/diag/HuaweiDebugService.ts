import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';

export type HuaweiDebugCategory =
  | 'ospf-event'
  | 'ospf-packet'
  | 'ospf-spf'
  | 'ospf-hello'
  | 'ip-icmp'
  | 'ip-packet'
  | 'vrrp'
  | 'bgp'
  | 'rip';

export interface HuaweiDebugFlag {
  category: HuaweiDebugCategory;
  enabledAtMs: number;
  scope?: string;
}

export class HuaweiDebugService implements TerminalDebugSource {
  private readonly flags = new Map<HuaweiDebugCategory, HuaweiDebugFlag>();
  private readonly broadcast = new DebugBroadcast();

  enable(category: HuaweiDebugCategory, scope?: string): string {
    this.flags.set(category, { category, enabledAtMs: Date.now(), scope });
    return `${HuaweiDebugService.label(category)} debugging is on`;
  }

  disable(category: HuaweiDebugCategory): string {
    this.flags.delete(category);
    return `${HuaweiDebugService.label(category)} debugging is off`;
  }

  isEnabled(category: HuaweiDebugCategory): boolean { return this.flags.has(category); }

  hasAnyFlag(): boolean { return this.flags.size > 0; }

  list(): readonly HuaweiDebugFlag[] {
    return [...this.flags.values()].sort((a, b) => a.category.localeCompare(b.category));
  }

  disableAll(): string {
    const n = this.flags.size;
    this.flags.clear();
    return n === 0 ? 'All possible debugging has been turned off' : `${n} debug switch(s) have been turned off`;
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  private emit(category: HuaweiDebugCategory, line: string): void {
    if (!this.flags.has(category)) return;
    this.broadcast.fan(line);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (!this.broadcast.beginAttach(bus, deviceId)) return;
    const mine = (p: { deviceId?: string }) => p.deviceId === undefined || p.deviceId === deviceId;

    this.broadcast.track(bus.subscribe('ospf.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-event',
        `OSPF: Neighbor (${p.neighborId}) state change: ${p.oldState} -> ${p.newState} (${p.event}) on ${p.iface}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.interface.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-event', `OSPF: Interface ${p.iface} state change: ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.spf.run', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-spf', `OSPF: Running ${p.kind} SPF, ${p.routesCount} routes, runtime ${p.runtimeMs}ms`);
    }));
    this.broadcast.track(bus.subscribe('ospf.hello.send-requested', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ospf-hello', `OSPF: Send Hello packet on ${e.payload.iface}.`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-packet', `OSPF: Receive packet from ${p.srcIp} on ${p.iface}.`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.outgoing', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-packet', `OSPF: Send packet to ${p.destIp} on ${p.iface}.`);
    }));

    const decodeIp = (frame: unknown): { src: string; dst: string; proto: number; icmpType?: string } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; protocol?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string }; payload?: { type?: string; icmpType?: string } } };
      if (f?.etherType !== 0x0800 || f.payload?.type !== 'ipv4') return null;
      const ip = f.payload;
      return {
        src: ip.sourceIP?.toString?.() ?? '?',
        dst: ip.destinationIP?.toString?.() ?? '?',
        proto: ip.protocol ?? 0,
        icmpType: ip.payload?.type === 'icmp' ? ip.payload.icmpType : undefined,
      };
    };
    const onFrame = (frame: unknown, dir: 'received' | 'sent') => {
      const ip = decodeIp(frame);
      if (!ip) return;
      this.emit('ip-packet', `IP: ${dir} packet, src=${ip.src}, dst=${ip.dst}, proto=${ip.proto}`);
      if (ip.proto === 1) {
        const kind = ip.icmpType === 'echo-reply' ? 'Echo Reply'
          : ip.icmpType === 'echo-request' ? 'Echo Request'
          : (ip.icmpType ?? 'Message');
        this.emit('ip-icmp', `ICMP: ${kind} ${dir}, src=${ip.src}, dst=${ip.dst}`);
      }
    };
    this.broadcast.track(bus.subscribe('port.frame.received', (e) => {
      if (!mine(e.payload)) return;
      onFrame((e.payload as { frame: unknown }).frame, 'received');
    }));
    this.broadcast.track(bus.subscribe('port.frame.tx-requested', (e) => {
      if (!mine(e.payload)) return;
      onFrame((e.payload as { frame: unknown }).frame, 'sent');
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }

  static label(category: HuaweiDebugCategory): string {
    switch (category) {
      case 'ospf-event': return 'OSPF event';
      case 'ospf-packet': return 'OSPF packet';
      case 'ospf-spf': return 'OSPF SPF';
      case 'ospf-hello': return 'OSPF Hello';
      case 'ip-icmp': return 'ICMP';
      case 'ip-packet': return 'IP packet';
      case 'vrrp': return 'VRRP';
      case 'bgp': return 'BGP';
      case 'rip': return 'RIP';
    }
  }

  format(): string {
    if (this.flags.size === 0) return 'No debugging is on';
    return this.list()
      .map(f => `${HuaweiDebugService.label(f.category)} debugging is on`)
      .join('\n');
  }
}
