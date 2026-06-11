/**
 * RouterRIPEngine — thin Adapter binding the reactive RIPv2 engine
 * (`src/network/rip/RIPEngine`) to a Router's ports and RIB.
 *
 * Historically this file carried a full copy of the RIP protocol
 * logic with native `setTimeout` timers, duplicating ~350 lines of
 * `rip/RIPEngine.ts` minus its reactive plumbing. It is now a pure
 * seam: port/RIB callbacks in, the single real engine underneath —
 * one source of truth for RFC 2453 behaviour (multicast updates,
 * split horizon, triggered updates, timers).
 */

import {
  IPAddress, SubnetMask, RIPPacket, EthernetFrame, MACAddress,
} from '../../core/types';
import type { Port } from '../../hardware/Port';
import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';
import {
  RIPEngine, type RIPConfig, type RIPRouteEntry_RIB,
} from '../../rip/RIPEngine';
import type { RouteEntry } from '../Router';

export type { RIPConfig } from '../../rip/RIPEngine';

/** Interface to access router state needed by RIP */
export interface RIPRouterContext {
  readonly id: string;
  readonly name: string;
  getPorts(): Map<string, Port>;
  getRoutingTable(): RouteEntry[];
  setRoutingTable(table: RouteEntry[]): void;
  pushRoute(route: RouteEntry): void;
  sendFrame(iface: string, frame: EthernetFrame): void;
  getRipVersion?(): 1 | 2;
  /** Optional reactive overrides (multi-topology tests). */
  getBus?(): IEventBus;
  getScheduler?(): IScheduler;
}

export class RouterRIPEngine {
  private readonly engine: RIPEngine;

  constructor(private readonly ctx: RIPRouterContext) {
    this.engine = new RIPEngine(ctx.id, ctx.name, {
      getPortIP: (n) => ctx.getPorts().get(n)?.getIPAddress() ?? null,
      getPortMask: (n) => ctx.getPorts().get(n)?.getSubnetMask() ?? null,
      getPortMAC: (n) =>
        ctx.getPorts().get(n)?.getMAC() ?? MACAddress.broadcast(),
      getPortNames: () => [...ctx.getPorts().keys()],
      sendFrame: (n, frame) => { ctx.sendFrame(n, frame); return true; },
      getRoutingTable: () => ctx.getRoutingTable(),
      installRoute: (route) => ctx.pushRoute(route as RouteEntry),
      removeRoute: (network, mask) => this.removeFromRib(network, mask),
      updateRoute: (network, mask, route) =>
        this.updateInRib(network, mask, route),
      getRipVersion: () => ctx.getRipVersion?.() ?? 2,
    });
    if (ctx.getBus) this.engine.setEventBus(ctx.getBus());
    if (ctx.getScheduler) this.engine.setScheduler(ctx.getScheduler());
  }

  enable(config?: Partial<RIPConfig>): void {
    if (config) this.engine.configure(config);
    if (!this.engine.isRunning()) this.engine.start();
  }

  disable(): void {
    if (!this.engine.isRunning()) return;
    this.engine.stop();
    this.ctx.setRoutingTable(
      this.ctx.getRoutingTable().filter((r) => r.type !== 'rip'));
  }

  isEnabled(): boolean { return this.engine.isRunning(); }

  getConfig(): RIPConfig { return this.engine.getConfig(); }

  getRoutes(): ReturnType<RIPEngine['getRoutes']> {
    return this.engine.getRoutes();
  }

  advertiseNetwork(network: IPAddress, mask: SubnetMask): void {
    this.engine.advertiseNetwork(network, mask);
  }

  setPassiveInterface(iface: string): void {
    this.engine.setPassiveInterface(iface);
  }

  removePassiveInterface(iface: string): void {
    this.engine.removePassiveInterface(iface);
  }

  /** Handle an incoming RIP packet (from the Router's local delivery). */
  processPacket(inPort: string, srcIP: IPAddress, ripPkt: RIPPacket): void {
    this.engine.processPacket(inPort, srcIP, ripPkt);
  }

  // ── RIB mutation seams ────────────────────────────────────────────

  private removeFromRib(network: IPAddress, mask: SubnetMask): void {
    this.ctx.setRoutingTable(this.ctx.getRoutingTable().filter((r) =>
      !(r.type === 'rip' && r.network.equals(network)
        && r.mask.toCIDR() === mask.toCIDR())));
  }

  private updateInRib(
    network: IPAddress, mask: SubnetMask, route: RIPRouteEntry_RIB,
  ): void {
    const table = this.ctx.getRoutingTable();
    const idx = table.findIndex((r) =>
      r.type === 'rip' && r.network.equals(network)
      && r.mask.toCIDR() === mask.toCIDR());
    if (idx >= 0) table[idx] = route as RouteEntry;
  }
}
