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

import type { IEventBus } from '@/events/EventBus';
import type { FrameSource } from '@/network/hardware/PortTap';
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
    this.flags.set(category, { category, enabledAtMs: Date.now(), scope });
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
      if (ip.proto === 1) {
        const kind = ip.icmpType === 'echo-reply' ? 'Echo Reply'
          : ip.icmpType === 'echo-request' ? 'Echo Request'
          : (ip.icmpType ?? 'Message');
        this.emit('ip-icmp', `ICMP: ${kind} ${dir}, src=${ip.src}, dst=${ip.dst}`);
      }
    };
    this.broadcast.track(frames.attachCapture((tapped) => {
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
