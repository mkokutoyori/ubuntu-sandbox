/**
 * PRD-CLI-Fidelite-VRP.md §14 / lot V6.
 *
 * Ce service est le SEUL magasin de l'etat `debugging` d'un equipement
 * VRP. Il ne l'etait pas : un second magasin (`_huaweiDebugFlags`, un
 * `Set` de phrases deja rendues) recevait la moitie des commandes, sans
 * emetteur ni proprietaire, si bien que `undo debugging all` en vidait
 * un seul et laissait l'autre allume.
 *
 * Les sous-moteurs qui tiennent legitimement leur propre drapeau (DHCP,
 * IPSec) restent chez eux et s'annoncent ici par `registerSwitchboard` :
 * `display debugging` les rend d'une seule voix et `undo debugging all`
 * les atteint.
 */

import { simulationNowMs } from '@/network/core/SystemClock';

import type { IEventBus } from '@/events/EventBus';
import type { BgpUpdateTracedPayload } from '@/network/bgp/events';
import { attachOrderedCapture, type FrameSource } from '@/network/hardware/PortTap';
import { DebugBroadcast, type DebugLineListener, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';
import { huaweiDisplayInterfaceName } from '@/network/devices/shells/cli-utils';
import {
  type HuaweiDebugCategory,
  type HuaweiDebugPlatform,
  categoriesDeLaPlateforme,
  labelDeCategorie,
} from './huaweiDebugCatalog';

export type { HuaweiDebugCategory } from './huaweiDebugCatalog';

export interface HuaweiDebugFlag {
  category: HuaweiDebugCategory;
  enabledAtMs: number;
  scope?: string;
}

/**
 * Un sous-moteur qui tient son propre drapeau de debug. `lignes()` dit
 * ce qui est allume chez lui, `eteindre()` repond a `undo debugging all`.
 */
export interface HuaweiDebugSwitchboard {
  lignes(): readonly string[];
  eteindre(): void;
}

export class HuaweiDebugService implements TerminalDebugSource {
  private readonly flags = new Map<HuaweiDebugCategory, HuaweiDebugFlag>();
  private readonly broadcast = new DebugBroadcast();
  private readonly switchboards: HuaweiDebugSwitchboard[] = [];
  private platform: HuaweiDebugPlatform = 'router';

  setPlatform(p: HuaweiDebugPlatform): void { this.platform = p; }

  getPlatform(): HuaweiDebugPlatform { return this.platform; }

  registerSwitchboard(sb: HuaweiDebugSwitchboard): void {
    if (!this.switchboards.includes(sb)) this.switchboards.push(sb);
  }

  enable(category: HuaweiDebugCategory, scope?: string): string {
    this.flags.set(category, { category, enabledAtMs: simulationNowMs(), scope });
    return `Info: ${labelDeCategorie(category)} debugging is on.`;
  }

  disable(category: HuaweiDebugCategory): string {
    this.flags.delete(category);
    return `Info: ${labelDeCategorie(category)} debugging is off.`;
  }

  isEnabled(category: HuaweiDebugCategory): boolean { return this.flags.has(category); }

  hasAnyFlag(): boolean {
    return this.flags.size > 0 || this.switchboards.some((s) => s.lignes().length > 0);
  }

  list(): readonly HuaweiDebugFlag[] {
    return [...this.flags.values()].sort((a, b) => a.category.localeCompare(b.category));
  }

  /**
   * `undo debugging all` — TOUT, y compris les sous-moteurs. La phrase
   * rendue etait celle d'IOS (`All possible debugging has been turned
   * off`) sur un equipement Huawei, alors que le switch rendait deja
   * celle de VRP au meme instant.
   */
  disableAll(): string {
    const n = this.flags.size + this.switchboards.reduce((t, s) => t + s.lignes().length, 0);
    this.flags.clear();
    for (const s of this.switchboards) s.eteindre();
    return n === 0
      ? 'Info: All possible debugging functions are off.'
      : `Info: ${n} debugging switch(es) have been turned off.`;
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  subscriberCount(): number { return this.broadcast.subscriberCount(); }

  private emit(category: HuaweiDebugCategory, line: string): void {
    if (!this.flags.has(category)) return;
    this.broadcast.fan(line);
  }

  attachToBus(bus: IEventBus, deviceId: string, frames: FrameSource): void {
    if (!this.broadcast.beginAttach(bus, deviceId)) return;
    const mine = (p: { deviceId?: string }) => p.deviceId === undefined || p.deviceId === deviceId;
    const nom = (i: string | undefined) => huaweiDisplayInterfaceName(i ?? '?');

    this.broadcast.track(bus.subscribe('ospf.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-event',
        `OSPF: Neighbor (${p.neighborId}) state change: ${p.oldState} -> ${p.newState} (${p.event}) on ${nom(p.iface)}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.interface.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-event', `OSPF: Interface ${nom(p.iface)} state change: ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.spf.run', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-spf', `OSPF: Running ${p.kind} SPF, ${p.routesCount} routes, runtime ${p.runtimeMs}ms`);
    }));
    this.broadcast.track(bus.subscribe('ospf.hello.send-requested', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ospf-hello', `OSPF: Send Hello packet on ${nom(e.payload.iface)}.`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-packet', `OSPF: Receive packet from ${p.srcIp} on ${nom(p.iface)}.`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.outgoing', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ospf-packet', `OSPF: Send packet to ${p.destIp} on ${nom(p.iface)}.`);
    }));

    this.broadcast.track(bus.subscribe('rip.update.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('rip', `RIP: Send update to ${p.destIp} on ${nom(p.iface)}, ${p.routeCount} routes`
        + `${p.triggered ? ' (triggered)' : ''}`);
    }));
    this.broadcast.track(bus.subscribe('rip.update.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('rip', `RIP: Receive update from ${p.fromIp} on ${nom(p.iface)}, ${p.routeCount} routes`);
    }));
    this.broadcast.track(bus.subscribe('rip.route.added', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('rip', `RIP: Add route ${p.network} via ${p.nextHop}, metric ${p.metric}`);
    }));
    this.broadcast.track(bus.subscribe('rip.route.timed-out', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('rip', `RIP: Route ${p.network} timed out, metric set to 16`);
    }));

    this.broadcast.track(bus.subscribe('bgp.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('bgp', `BGP: Peer ${p.neighborIp} state changed from ${p.oldState} to ${p.newState}`);
    }));

    const bgpUpdate = (direction: 'Send' | 'Receive') => (e: { payload: BgpUpdateTracedPayload }): void => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      for (const prefix of p.announced) {
        this.emit('bgp-update', `BGP: ${direction} UPDATE ${prefix} ${direction === 'Send' ? 'to' : 'from'} peer ${p.neighborIp}, `
          + `next hop ${p.nextHop ?? '?'}, AS path ${p.asPath.join(' ') || 'empty'}`);
      }
      for (const prefix of p.withdrawn) {
        this.emit('bgp-update', `BGP: ${direction} withdrawal ${prefix} ${direction === 'Send' ? 'to' : 'from'} peer ${p.neighborIp}`);
      }
    };
    this.broadcast.track(bus.subscribe('bgp.update.sent', bgpUpdate('Send')));
    this.broadcast.track(bus.subscribe('bgp.update.received', bgpUpdate('Receive')));

    const natProtocol = (code: number): string => (code === 6 ? 'TCP' : code === 17 ? 'UDP' : code === 1 ? 'ICMP' : String(code));
    this.broadcast.track(bus.subscribe('nat.session.created', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('nat', `NAT: Session created (${p.kind}) ${natProtocol(p.protocol)} `
        + `${p.localIp}:${p.localPort} -> ${p.globalIp}:${p.globalPort}`);
    }));
    this.broadcast.track(bus.subscribe('nat.session.removed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('nat', `NAT: Session removed (${p.reason}) ${natProtocol(p.protocol)} `
        + `${p.localIp}:${p.localPort} -> ${p.globalIp}:${p.globalPort}`);
    }));
    this.broadcast.track(bus.subscribe('nat.port.exhausted', (e) => {
      if (!mine(e.payload)) return;
      this.emit('nat', `NAT: Port pool exhausted for ${e.payload.globalIp}`);
    }));

    this.broadcast.track(bus.subscribe('radius.auth.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('radius', `RADIUS: Received Access-${p.accepted ? 'Accept' : 'Reject'} for user ${p.username} from ${p.serverIp}`);
      this.emit('aaa', `AAA: Authentication ${p.accepted ? 'success' : 'failure'}, user ${p.username}, server ${p.serverIp}`);
    }));
    this.broadcast.track(bus.subscribe('radius.server.dead', (e) => {
      if (!mine(e.payload)) return;
      this.emit('radius', `RADIUS: Server ${e.payload.serverIp} is marked down`);
    }));
    this.broadcast.track(bus.subscribe('radius.server.alive', (e) => {
      if (!mine(e.payload)) return;
      this.emit('radius', `RADIUS: Server ${e.payload.serverIp} is marked up`);
    }));
    this.broadcast.track(bus.subscribe('radius.accounting.record', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('aaa', `AAA: Accounting ${p.status}, user ${p.username}, session ${p.sessionId}`);
    }));
    this.broadcast.track(bus.subscribe('tacacs.authen.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('hwtacacs', `HWTACACS: Authentication of user ${p.username} by ${p.serverIp}: ${p.status}`);
      this.emit('aaa', `AAA: Authentication ${p.status === 'pass' ? 'success' : 'failure'}, user ${p.username}, server ${p.serverIp}`);
    }));
    this.broadcast.track(bus.subscribe('tacacs.author.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('hwtacacs', `HWTACACS: Authorization of user ${p.username} by ${p.serverIp}: ${p.status}`);
      this.emit('aaa', `AAA: Authorization ${p.status.startsWith('pass') ? 'success' : 'failure'}, user ${p.username}`
        + `${p.command === null ? '' : `, command ${p.command}`}`);
    }));
    this.broadcast.track(bus.subscribe('tacacs.acct.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('hwtacacs', `HWTACACS: Accounting of user ${p.username} by ${p.serverIp}: ${p.status}`);
      this.emit('aaa', `AAA: Accounting ${p.status}, user ${p.username}`);
    }));

    this.broadcast.track(bus.subscribe('lldp.frame.sent', (e) => {
      if (!mine(e.payload)) return;
      this.emit('lldp', `LLDP: Send LLDPDU on ${nom(e.payload.port)} (${e.payload.reason})`);
    }));
    this.broadcast.track(bus.subscribe('lldp.frame.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('lldp', `LLDP: Receive LLDPDU on ${nom(p.port)} from ${p.remoteSystem} (${p.remotePort})`);
    }));
    this.broadcast.track(bus.subscribe('lldp.neighbor.discovered', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('lldp', `LLDP: New neighbor ${p.remoteSystem} (${p.remotePort}) on ${nom(p.localPort)}, TTL ${p.ttlSec}s`);
    }));
    this.broadcast.track(bus.subscribe('lldp.neighbor.expired', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('lldp', `LLDP: Neighbor ${p.remoteSystem} on ${nom(p.localPort)} deleted (${p.cause})`);
    }));

    this.broadcast.track(bus.subscribe('vrrp.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('vrrp', `VRRP: ${nom(p.iface)} virtual router ${p.vrid} state ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('vrrp.master.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { iface?: string; vrid?: number; masterIp?: string | null };
      this.emit('vrrp', `VRRP: ${nom(p.iface)} virtual router ${p.vrid ?? 0} master is ${p.masterIp ?? 'unknown'}`);
    }));

    this.broadcast.track(bus.subscribe('stp.role.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp', `STP: ${nom(p.port)} role change ${p.oldRole} -> ${p.newRole}`);
    }));
    this.broadcast.track(bus.subscribe('stp.port-state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp', `STP: ${nom(p.port)} state change ${p.oldState ?? 'none'} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('stp.root.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp', `STP: New root bridge ${p.newRootMac}, priority ${p.newRootPriority}`);
    }));
    this.broadcast.track(bus.subscribe('stp.topology.change', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp', `STP: Topology change (${p.origin})${p.port ? ` on ${nom(p.port)}` : ''}`);
    }));

    this.broadcast.track(bus.subscribe('bfd.session.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('bfd', `BFD: Session with ${p.neighborIp} on ${nom(p.iface)} changed ${p.oldState} -> ${p.newState} (${p.reason})`);
    }));
    this.broadcast.track(bus.subscribe('bfd.packet.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('bfd', `BFD: Send control packet to ${p.neighborIp} on ${nom(p.iface)}, state ${p.state}, `
        + `MyDiscr ${p.myDiscriminator}, YourDiscr ${p.yourDiscriminator}`);
    }));
    this.broadcast.track(bus.subscribe('bfd.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('bfd', `BFD: Receive control packet from ${p.neighborIp} on ${nom(p.iface)}, state ${p.remoteState}, `
        + `MyDiscr ${p.myDiscriminator}, YourDiscr ${p.yourDiscriminator}`);
    }));

    this.broadcast.track(bus.subscribe('ntp.packet.sent', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ntp', `NTP: Send ${e.payload.mode} packet to ${e.payload.serverIp}`);
    }));
    this.broadcast.track(bus.subscribe('ntp.packet.received', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ntp', `NTP: Receive ${e.payload.mode} packet from ${e.payload.fromIp}, stratum ${e.payload.stratum}`);
    }));
    this.broadcast.track(bus.subscribe('ntp.synced', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ntp', `NTP: Clock synchronized to ${p.serverIp}, offset ${p.offsetMs}ms, delay ${p.delayMs}ms, stratum ${p.newStratum}`);
    }));
    this.broadcast.track(bus.subscribe('ntp.unsynced', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ntp', `NTP: Clock unsynchronized (${e.payload.reason})`);
    }));

    this.broadcast.track(bus.subscribe('igmp.packet.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('igmp', `IGMP: Send ${p.messageType} for group ${p.groupAddress} to ${p.destinationIp} on ${nom(p.iface)}`);
    }));
    this.broadcast.track(bus.subscribe('igmp.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('igmp', `IGMP: Receive ${p.messageType} for group ${p.groupAddress} from ${p.fromIp} on ${nom(p.iface)}`);
    }));
    this.broadcast.track(bus.subscribe('igmp.group.joined', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('igmp', `IGMP: Group ${p.groupAddress} joined on ${nom(p.iface)} by ${p.reporterIp}`);
    }));
    this.broadcast.track(bus.subscribe('igmp.group.left', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('igmp', `IGMP: Group ${p.groupAddress} left on ${nom(p.iface)} (${p.reason})`);
    }));

    this.broadcast.track(bus.subscribe('pim.packet.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('pim', `PIM: Send ${p.messageType} to ${p.destinationIp} on ${nom(p.iface)}`);
    }));
    this.broadcast.track(bus.subscribe('pim.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('pim', `PIM: Receive ${p.messageType} from ${p.fromIp} on ${nom(p.iface)}`);
    }));
    this.broadcast.track(bus.subscribe('pim.neighbor.added', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('pim', `PIM: Neighbor ${p.neighborIp} added on ${nom(p.iface)}, DR priority ${p.drPriority}`);
    }));
    this.broadcast.track(bus.subscribe('pim.neighbor.lost', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('pim', `PIM: Neighbor ${p.neighborIp} lost on ${nom(p.iface)} (${p.reason})`);
    }));
    this.broadcast.track(bus.subscribe('pim.dr.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('pim', `PIM: DR on ${nom(p.iface)} changed ${p.oldDrIp ?? 'none'} -> ${p.newDrIp}`);
    }));

    const decodeIp = (frame: unknown): { src: string; dst: string; proto: number; sport: number; dport: number; icmpType?: string } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; protocol?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string }; payload?: { type?: string; icmpType?: string; sourcePort?: number; destinationPort?: number } } };
      if (f?.etherType !== 0x0800 || f.payload?.type !== 'ipv4') return null;
      const ip = f.payload;
      return {
        src: ip.sourceIP?.toString?.() ?? '?',
        dst: ip.destinationIP?.toString?.() ?? '?',
        proto: ip.protocol ?? 0,
        sport: ip.payload?.sourcePort ?? 0,
        dport: ip.payload?.destinationPort ?? 0,
        icmpType: ip.payload?.type === 'icmp' ? ip.payload.icmpType : undefined,
      };
    };
    const decodeArp = (frame: unknown): { op: string; senderIP: string; targetIP: string } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; operation?: string; senderIP?: { toString(): string }; targetIP?: { toString(): string } } };
      if (f?.etherType !== 0x0806 || f.payload?.type !== 'arp') return null;
      return {
        op: f.payload.operation ?? 'request',
        senderIP: f.payload.senderIP?.toString?.() ?? '?',
        targetIP: f.payload.targetIP?.toString?.() ?? '?',
      };
    };
    const onFrame = (frame: unknown, dir: 'received' | 'sent') => {
      const arp = decodeArp(frame);
      if (arp) {
        this.emit('arp-packet',
          `ARP: ${dir === 'sent' ? 'Send' : 'Receive'} ${arp.op}, `
          + `sender ${arp.senderIP}, target ${arp.targetIP}`);
        return;
      }
      const ip = decodeIp(frame);
      if (!ip) return;
      this.emit('ip-packet', `IP: ${dir} packet, src=${ip.src}, dst=${ip.dst}, proto=${ip.proto}`);
      if (ip.proto === 6 || ip.proto === 17) {
        const detail = `${dir} packet, ${ip.src}:${ip.sport} -> ${ip.dst}:${ip.dport}`;
        if (ip.proto === 6) this.emit('tcp-packet', `TCP: ${detail}`);
        else this.emit('udp-packet', `UDP: ${detail}`);
      }
      if (ip.proto === 1) {
        const kind = ip.icmpType === 'echo-reply' ? 'Echo Reply'
          : ip.icmpType === 'echo-request' ? 'Echo Request'
          : (ip.icmpType ?? 'Message');
        this.emit('ip-icmp', `ICMP: ${kind} ${dir}, src=${ip.src}, dst=${ip.dst}`);
      }
    };
    this.broadcast.track(attachOrderedCapture(frames, (tapped) => {
      onFrame(tapped.frame, tapped.direction === 'in' ? 'received' : 'sent');
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }

  static label(category: HuaweiDebugCategory): string {
    return labelDeCategorie(category);
  }

  /** Les categories que cette plateforme peut reellement tracer. */
  categories(): readonly HuaweiDebugCategory[] {
    return categoriesDeLaPlateforme(this.platform).map((s) => s.category);
  }

  /** `display debugging` — une seule voix pour tous les magasins. */
  format(): string {
    const lignes = [
      ...this.list().map((f) => `${labelDeCategorie(f.category)} debugging is on`),
      ...this.switchboards.flatMap((s) => s.lignes()),
    ];
    return lignes.length === 0 ? 'No debugging is on' : lignes.join('\n');
  }
}
