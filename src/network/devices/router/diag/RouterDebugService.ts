export type DebugCategory =
  | 'crypto.isakmp'
  | 'crypto.ipsec'
  | 'crypto.ikev2'
  | 'crypto.pki'
  | 'crypto.pki.transactions'
  | 'crypto.pki.messages'
  | 'ip.ospf.adj'
  | 'ip.ospf.events'
  | 'ip.ospf.spf'
  | 'ip.ospf.hello'
  | 'ip.ospf.packet'
  | 'ip.ospf.lsa-generation'
  | 'ip.rip'
  | 'ip.eigrp'
  | 'ip.bgp'
  | 'ip.routing'
  | 'ip.icmp'
  | 'ip.packet'
  | 'ip.tcp'
  | 'ip.udp'
  | 'ip.nat'
  | 'ip.arp'
  | 'ip.dhcp.server'
  | 'ip.ssh'
  | 'ip.nhrp'
  | 'standby'
  | 'vrrp'
  | 'glbp'
  | 'track'
  | 'ip.sla.trace'
  | 'aaa.authentication'
  | 'aaa.authorization'
  | 'aaa.accounting'
  | 'radius'
  | 'tacacs'
  | 'ntp.events'
  | 'ntp.packets'
  | 'lldp.packets'
  | 'cdp.packets';

import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';

export interface DebugFlag {
  category: DebugCategory;
  enabledAtMs: number;
  scope?: string;
}

export class RouterDebugService implements TerminalDebugSource {
  private readonly flags: Map<DebugCategory, DebugFlag> = new Map();
  private readonly broadcast = new DebugBroadcast();

  enable(category: DebugCategory, scope?: string): string {
    this.flags.set(category, { category, enabledAtMs: Date.now(), scope });
    return `${RouterDebugService.label(category)} debugging is on${scope ? ' for ' + scope : ''}`;
  }

  disable(category: DebugCategory): string {
    this.flags.delete(category);
    return `${RouterDebugService.label(category)} debugging is off`;
  }

  isEnabled(category: DebugCategory): boolean { return this.flags.has(category); }

  hasAnyFlag(): boolean { return this.flags.size > 0; }

  list(): readonly DebugFlag[] {
    return [...this.flags.values()].sort((a, b) => a.category.localeCompare(b.category));
  }

  disableAll(): string {
    const n = this.flags.size;
    this.flags.clear();
    return n === 0 ? 'All possible debugging has been turned off' : `${n} debug flag${n === 1 ? '' : 's'} have been turned off`;
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  private emit(category: DebugCategory, line: string): void {
    if (!this.flags.has(category)) return;
    this.broadcast.fan(line);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (!this.broadcast.beginAttach(bus, deviceId)) return;
    const mine = (p: { deviceId?: string }) => p.deviceId === undefined || p.deviceId === deviceId;
    this.broadcast.track(bus.subscribe('ospf.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.adj', `OSPF-5-ADJCHG: Process ${p.processId}, Nbr ${p.neighborId} on ${p.iface} from ${p.oldState} to ${p.newState}, ${p.event}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.interface.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.events', `OSPF: Interface ${p.iface} state change from ${p.oldState} to ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.spf.run', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.spf', `OSPF: Running ${p.kind} SPF (run ${p.runIndex}), ${p.routesCount} routes, runtime ${p.runtimeMs}ms`);
    }));
    this.broadcast.track(bus.subscribe('ospf.hello.send-requested', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ip.ospf.hello', `OSPF: Send hello packet on ${e.payload.iface}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.packet', `OSPF: rcv packet from ${p.srcIp} on ${p.iface}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.outgoing', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.packet', `OSPF: snd packet to ${p.destIp} on ${p.iface}`);
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
    const decodeArp = (frame: unknown): { op: 'request' | 'reply'; senderIp: string; senderMac: string; targetIp: string; targetMac: string } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; operation?: 'request' | 'reply'; senderIP?: { toString(): string }; senderMAC?: { toString(): string }; targetIP?: { toString(): string }; targetMAC?: { toString(): string } } };
      if (f?.etherType !== 0x0806 || f.payload?.type !== 'arp') return null;
      const a = f.payload;
      return {
        op: a.operation === 'reply' ? 'reply' : 'request',
        senderIp: a.senderIP?.toString?.() ?? '?',
        senderMac: a.senderMAC?.toString?.() ?? '?',
        targetIp: a.targetIP?.toString?.() ?? '?',
        targetMac: a.targetMAC?.toString?.() ?? '?',
      };
    };
    const onFrame = (frame: unknown, dir: 'rcvd' | 'sent', iface: string) => {
      const arp = decodeArp(frame);
      if (arp) {
        const op = arp.op === 'reply' ? 'rep' : 'req';
        this.emit('ip.arp', `IP ARP: ${dir} ${op} src ${arp.senderIp} ${arp.senderMac}, dst ${arp.targetIp} ${arp.targetMac} ${iface}`);
        return;
      }
      const ip = decodeIp(frame);
      if (!ip) return;
      this.emit('ip.packet', `IP: s=${ip.src}, d=${ip.dst}, len, ${dir} (proto ${ip.proto})`);
      if (ip.proto === 1) {
        const kind = ip.icmpType === 'echo-reply' ? 'echo reply' : ip.icmpType === 'echo-request' ? 'echo request' : (ip.icmpType ?? 'message');
        this.emit('ip.icmp', `ICMP: ${kind} ${dir}, src ${ip.src}, dst ${ip.dst}`);
      }
    };
    this.broadcast.track(bus.subscribe('port.frame.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { frame: unknown; portName?: string };
      onFrame(p.frame, 'rcvd', p.portName ?? '?');
    }));
    this.broadcast.track(bus.subscribe('port.frame.tx-requested', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { frame: unknown; portName?: string };
      onFrame(p.frame, 'sent', p.portName ?? '?');
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }

  static label(category: DebugCategory): string {
    switch (category) {
      case 'crypto.isakmp': return 'Crypto ISAKMP';
      case 'crypto.ipsec': return 'Crypto IPSec';
      case 'crypto.ikev2': return 'IKEv2';
      case 'crypto.pki': return 'Crypto PKI';
      case 'crypto.pki.transactions': return 'PKI Transactions';
      case 'crypto.pki.messages': return 'PKI Messages';
      case 'ip.ospf.adj': return 'OSPF adjacency';
      case 'ip.ospf.events': return 'OSPF events';
      case 'ip.ospf.spf': return 'OSPF SPF';
      case 'ip.ospf.hello': return 'OSPF Hello';
      case 'ip.ospf.packet': return 'OSPF packet';
      case 'ip.ospf.lsa-generation': return 'OSPF LSA generation';
      case 'ip.rip': return 'RIP';
      case 'ip.eigrp': return 'EIGRP';
      case 'ip.bgp': return 'BGP';
      case 'ip.routing': return 'IP routing';
      case 'ip.icmp': return 'IP ICMP';
      case 'ip.packet': return 'IP packet';
      case 'ip.tcp': return 'IP TCP';
      case 'ip.udp': return 'IP UDP';
      case 'ip.nat': return 'IP NAT';
      case 'ip.arp': return 'IP ARP';
      case 'ip.dhcp.server': return 'IP DHCP server';
      case 'ip.ssh': return 'SSH';
      case 'ip.nhrp': return 'NHRP';
      case 'standby': return 'HSRP';
      case 'vrrp': return 'VRRP';
      case 'glbp': return 'GLBP';
      case 'track': return 'TRACK';
      case 'ip.sla.trace': return 'IP SLA';
      case 'aaa.authentication': return 'AAA Authentication';
      case 'aaa.authorization': return 'AAA Authorization';
      case 'aaa.accounting': return 'AAA Accounting';
      case 'radius': return 'RADIUS';
      case 'tacacs': return 'TACACS+';
      case 'ntp.events': return 'NTP events';
      case 'ntp.packets': return 'NTP packets';
      case 'lldp.packets': return 'LLDP packets';
      case 'cdp.packets': return 'CDP packets';
    }
  }

  format(): string {
    if (this.flags.size === 0) return 'No debug flags are enabled';
    return this.list()
      .map(f => `${RouterDebugService.label(f.category)} debugging is on${f.scope ? ' for ' + f.scope : ''}`)
      .join('\n');
  }
}
