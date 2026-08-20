import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type PimSnoopingConfig, type PimSnoopingVlanState, type PimSnoopingGroup,
  createDefaultPimSnoopingConfig, defaultPimSnoopingVlanState, pimSnoopingNeighborKey,
} from './types';
import {
  IP_PROTO_PIM, getOption, type PimPacket,
} from '../pim/types';
import { isReservedMulticast, isMulticastIpv4 } from '../igmp/types';
import { type EthernetFrame, type IPv4Packet } from '../core/types';
import { Logger } from '../core/Logger';

export interface PimSnoopingHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  resolveIngressVlan(portName: string): number | undefined;
  isTrunkPort(portName: string): boolean;
}

/**
 * PIM Snooping: constrain multicast flooding on a segment where the
 * interested parties are *routers*, not IGMP hosts. A router never speaks
 * IGMP to another router, so IGMP snooping alone sees no interest at all
 * on a router-to-router segment and can only flood.
 *
 * Deliberately limited to Hello and (*,G) Join/Prune, mirroring what the
 * router-side engine models (`docs/PRD-PIM.md §2.2`): Bootstrap and
 * Candidate-RP messages are recognised only so they are never mistaken
 * for a Hello or a Join, never snooped for state.
 */
export class PimSnoopingAgent extends ReactiveAgentBase {
  private config: PimSnoopingConfig = createDefaultPimSnoopingConfig();

  constructor(
    private readonly host: PimSnoopingHost,
    getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
  }

  getConfig(): Readonly<PimSnoopingConfig> { return this.config; }

  nowMs(): number { return this.getScheduler().now(); }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) { this.armTimers(); return; }
    this.stopTimers();
    for (const v of this.config.vlans.values()) this.clearVlan(v, 'config');
  }

  setVlanEnabled(vlan: number, on: boolean): void {
    const v = this.ensureVlan(vlan);
    if (v.enabled === on) return;
    v.enabled = on;
    if (!on) this.clearVlan(v, 'config');
  }

  getVlanState(vlan: number): PimSnoopingVlanState | undefined {
    return this.config.vlans.get(vlan);
  }

  listVlans(): PimSnoopingVlanState[] {
    return Array.from(this.config.vlans.values()).sort((a, b) => a.vlan - b.vlan);
  }

  listGroups(vlan?: number): Array<{ vlan: number; group: PimSnoopingGroup }> {
    const out: Array<{ vlan: number; group: PimSnoopingGroup }> = [];
    for (const v of this.config.vlans.values()) {
      if (vlan !== undefined && v.vlan !== vlan) continue;
      for (const g of v.groups.values()) out.push({ vlan: v.vlan, group: g });
    }
    return out.sort((a, b) =>
      a.vlan === b.vlan ? a.group.groupAddress.localeCompare(b.group.groupAddress) : a.vlan - b.vlan);
  }

  /**
   * Ports that must receive traffic for a group, from PIM's point of
   * view: the ports whose neighbour joined it, plus every PIM router
   * port (a router upstream still needs to see the flow to forward it).
   */
  computeEgressPorts(ingressPort: string, groupAddress: string): string[] {
    if (!this.config.enabled) return [];
    const vlan = this.host.resolveIngressVlan(ingressPort);
    if (vlan === undefined) return [];
    const v = this.config.vlans.get(vlan);
    if (!v || !v.enabled) return [];
    const g = v.groups.get(groupAddress);
    const union = new Set<string>([
      ...(g ? g.members.keys() : []),
      ...v.routerPorts,
    ]);
    union.delete(ingressPort);
    return Array.from(union);
  }

  handleFrame(portName: string, frame: EthernetFrame): boolean {
    if (!this.isRunning() || !this.config.enabled) return false;
    if (frame.etherType !== 0x0800) return false;
    const ipPkt = frame.payload as IPv4Packet | undefined;
    if (!ipPkt || ipPkt.protocol !== IP_PROTO_PIM) return false;
    const payload = ipPkt.payload as PimPacket | undefined;
    if (!payload || payload.type !== 'pim') return false;
    const vlan = this.host.resolveIngressVlan(portName);
    if (vlan === undefined) return false;
    const v = this.ensureVlan(vlan);
    if (!v.enabled) return false;

    const senderIp = ipPkt.sourceIP.toString();
    if (payload.messageType === 'hello') {
      this.onHello(v, portName, senderIp, payload);
      return false;
    }
    if (payload.messageType === 'join-prune') {
      // A Join/Prune also proves a PIM router lives on that port.
      this.rememberNeighbor(v, portName, senderIp, this.config.routerPortAgeSec * 1000);
      if (payload.joinPrune) this.onJoinPrune(v, portName, senderIp, payload.joinPrune);
    }
    // Bootstrap / Candidate-RP are deliberately not snooped (see class
    // doc) — recognised here only so they never fall into a Join branch.
    return false;
  }

  private onHello(v: PimSnoopingVlanState, port: string, senderIp: string, payload: PimPacket): void {
    const holdSec = getOption<number>(payload.options, 'holdtime') ?? this.config.routerPortAgeSec;
    this.rememberNeighbor(v, port, senderIp, holdSec * 1000);
  }

  private rememberNeighbor(
    v: PimSnoopingVlanState, port: string, neighborIp: string, holdtimeMs: number,
  ): void {
    const key = pimSnoopingNeighborKey(port, neighborIp);
    const had = v.neighbors.has(key);
    v.neighbors.set(key, {
      port, neighborIp, lastHelloMs: this.nowMs(), holdtimeMs,
    });
    if (v.routerPorts.has(port)) return;
    v.routerPorts.add(port);
    this.getBus().publish({
      topic: 'pim.snooping.neighbor.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan: v.vlan, port, neighborIp, added: true,
      },
    });
    if (!had) {
      Logger.info(this.host.id, 'pim-snooping:neighbor',
        `${this.host.name}: vlan ${v.vlan} ${port} PIM neighbor ${neighborIp}`);
    }
  }

  private onJoinPrune(
    v: PimSnoopingVlanState, port: string, senderIp: string,
    body: NonNullable<PimPacket['joinPrune']>,
  ): void {
    const holdtimeMs = (body.holdtimeSec || this.config.groupMembershipSec) * 1000;
    for (const g of body.groups) {
      if (!isMulticastIpv4(g.groupAddress) || isReservedMulticast(g.groupAddress)) continue;
      if (g.joinStarG) this.addInterest(v, port, senderIp, g.groupAddress, holdtimeMs);
      else if (g.pruneStarG) this.removeInterest(v, port, g.groupAddress, 'prune');
    }
  }

  private addInterest(
    v: PimSnoopingVlanState, port: string, neighborIp: string,
    group: string, holdtimeMs: number,
  ): void {
    let g = v.groups.get(group);
    if (!g) {
      g = { vlan: v.vlan, groupAddress: group, members: new Map() };
      v.groups.set(group, g);
    }
    const had = g.members.has(port);
    g.members.set(port, { port, neighborIp, lastJoinMs: this.nowMs(), holdtimeMs });
    if (had) return;
    this.getBus().publish({
      topic: 'pim.snooping.member.joined',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan: v.vlan, groupAddress: group, port, neighborIp,
      },
    });
    Logger.info(this.host.id, 'pim-snooping:join',
      `${this.host.name}: vlan ${v.vlan} ${port} joined ${group} (PIM ${neighborIp})`);
  }

  private removeInterest(
    v: PimSnoopingVlanState, port: string, group: string,
    reason: 'prune' | 'timeout' | 'config' | 'link',
  ): void {
    const g = v.groups.get(group);
    if (!g || !g.members.delete(port)) return;
    this.emitLeft(v.vlan, group, port, reason);
    if (g.members.size === 0) v.groups.delete(group);
  }

  private emitLeft(
    vlan: number, group: string, port: string,
    reason: 'prune' | 'timeout' | 'config' | 'link',
  ): void {
    this.getBus().publish({
      topic: 'pim.snooping.member.left',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan, groupAddress: group, port, reason,
      },
    });
  }

  private clearVlan(v: PimSnoopingVlanState, reason: 'config' | 'link'): void {
    for (const [k, g] of v.groups) {
      for (const m of g.members.values()) this.emitLeft(v.vlan, g.groupAddress, m.port, reason);
      v.groups.delete(k);
    }
    for (const p of [...v.routerPorts]) this.forgetRouterPort(v, p);
    v.neighbors.clear();
  }

  private forgetRouterPort(v: PimSnoopingVlanState, port: string): void {
    if (!v.routerPorts.delete(port)) return;
    this.getBus().publish({
      topic: 'pim.snooping.neighbor.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan: v.vlan, port, neighborIp: '0.0.0.0', added: false,
      },
    });
  }

  private ensureVlan(vlan: number): PimSnoopingVlanState {
    let v = this.config.vlans.get(vlan);
    if (!v) {
      v = defaultPimSnoopingVlanState(vlan);
      v.enabled = this.config.perVlanDefault;
      this.config.vlans.set(vlan, v);
    }
    return v;
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('pim-snoop-expiry', () => this.expireDue(), 1000);
  }

  private expireDue(): void {
    const now = this.nowMs();
    for (const v of this.config.vlans.values()) {
      for (const [k, g] of v.groups) {
        for (const m of [...g.members.values()]) {
          if (now - m.lastJoinMs > m.holdtimeMs) {
            g.members.delete(m.port);
            this.emitLeft(v.vlan, g.groupAddress, m.port, 'timeout');
          }
        }
        if (g.members.size === 0) v.groups.delete(k);
      }
      const livePorts = new Set<string>();
      for (const [k, n] of v.neighbors) {
        if (now - n.lastHelloMs > n.holdtimeMs) v.neighbors.delete(k);
        else livePorts.add(n.port);
      }
      for (const p of [...v.routerPorts]) {
        if (!livePorts.has(p)) this.forgetRouterPort(v, p);
      }
    }
  }

  protected override onPortLinkDown(portName: string): void {
    for (const v of this.config.vlans.values()) {
      this.forgetRouterPort(v, portName);
      for (const [k, n] of v.neighbors) {
        if (n.port === portName) v.neighbors.delete(k);
      }
      for (const [k, g] of v.groups) {
        if (g.members.delete(portName)) this.emitLeft(v.vlan, g.groupAddress, portName, 'link');
        if (g.members.size === 0) v.groups.delete(k);
      }
    }
  }
}
