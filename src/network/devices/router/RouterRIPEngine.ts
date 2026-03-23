/**
 * RouterRIPEngine - RIPv2 Protocol Engine (RFC 2453)
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Manages RIP state, route learning, split horizon, and periodic updates.
 */

import type { Port } from '../../hardware/Port';
import {
  IPAddress, SubnetMask, MACAddress,
  IPv4Packet, UDPPacket, RIPPacket, RIPRouteEntry, EthernetFrame,
  ETHERTYPE_IPV4, IP_PROTO_UDP, UDP_PORT_RIP,
  RIP_METRIC_INFINITY, RIP_MAX_ENTRIES_PER_MESSAGE,
  createIPv4Packet,
} from '../../core/types';
import { Logger } from '../../core/Logger';
import type { RouteEntry } from '../Router';

// ─── RIP State Types ────────────────────────────────────────────

/** Internal RIP route with aging metadata */
interface RIPRouteState {
  route: RouteEntry;
  lastUpdate: number;
  learnedFrom: string;
  learnedOnIface: string;
  garbageCollect: boolean;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

/** RIP configuration */
export interface RIPConfig {
  networks: Array<{ network: IPAddress; mask: SubnetMask }>;
  updateInterval: number;
  routeTimeout: number;
  gcTimeout: number;
  splitHorizon: boolean;
  poisonedReverse: boolean;
}

/** Interface to access router state needed by RIP */
export interface RIPRouterContext {
  readonly id: string;
  readonly name: string;
  getPorts(): Map<string, Port>;
  getRoutingTable(): RouteEntry[];
  setRoutingTable(table: RouteEntry[]): void;
  pushRoute(route: RouteEntry): void;
  sendFrame(iface: string, frame: EthernetFrame): void;
}

// ─── RIP Engine ─────────────────────────────────────────────────

export class RouterRIPEngine {
  private enabled = false;
  private config: RIPConfig = {
    networks: [],
    updateInterval: 30000,
    routeTimeout: 180000,
    gcTimeout: 120000,
    splitHorizon: true,
    poisonedReverse: true,
  };
  private routes: Map<string, RIPRouteState> = new Map();
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: RIPRouterContext) {}

  enable(config?: Partial<RIPConfig>): void {
    if (config) {
      Object.assign(this.config, config);
    }
    this.enabled = true;

    this.updateTimer = setInterval(() => {
      this.sendPeriodicUpdate();
    }, this.config.updateInterval);

    this.sendRequest();

    Logger.info(this.ctx.id, 'rip:enabled',
      `${this.ctx.name}: RIPv2 enabled, update interval ${this.config.updateInterval}ms`);
  }

  disable(): void {
    this.enabled = false;

    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    for (const [, state] of this.routes) {
      if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
      if (state.gcTimer) clearTimeout(state.gcTimer);
    }
    this.routes.clear();

    this.ctx.setRoutingTable(this.ctx.getRoutingTable().filter(r => r.type !== 'rip'));

    Logger.info(this.ctx.id, 'rip:disabled', `${this.ctx.name}: RIPv2 disabled`);
  }

  isEnabled(): boolean { return this.enabled; }

  getConfig(): RIPConfig { return { ...this.config, networks: [...this.config.networks] }; }

  getRoutes(): Map<string, { metric: number; learnedFrom: string; age: number; garbageCollect: boolean }> {
    const result = new Map<string, { metric: number; learnedFrom: string; age: number; garbageCollect: boolean }>();
    for (const [key, state] of this.routes) {
      result.set(key, {
        metric: state.route.metric,
        learnedFrom: state.learnedFrom,
        age: Math.floor((Date.now() - state.lastUpdate) / 1000),
        garbageCollect: state.garbageCollect,
      });
    }
    return result;
  }

  advertiseNetwork(network: IPAddress, mask: SubnetMask): void {
    this.config.networks.push({ network, mask });
  }

  /** Handle an incoming RIP packet (called from Router's handleLocalDelivery) */
  processPacket(inPort: string, srcIP: IPAddress, ripPkt: RIPPacket): void {
    if (!this.enabled) return;
    if (!this.isRIPInterface(inPort)) return;

    if (ripPkt.command === 1) {
      this.sendUpdate(inPort);
      return;
    }

    if (ripPkt.command === 2) {
      for (const entry of ripPkt.entries) {
        this.processRouteEntry(inPort, srcIP, entry);
      }
    }
  }

  // ─── Private Methods ────────────────────────────────────────────

  private isRIPInterface(portName: string): boolean {
    const port = this.ctx.getPorts().get(portName);
    if (!port) return false;
    const ip = port.getIPAddress();
    const portMask = port.getSubnetMask();
    if (!ip || !portMask) return false;

    const portNetInt = ip.toUint32() & portMask.toUint32();

    for (const net of this.config.networks) {
      const cfgNetInt = net.network.toUint32() & net.mask.toUint32();
      const cfgMaskInt = net.mask.toUint32();
      if ((portNetInt & cfgMaskInt) === cfgNetInt) return true;
    }
    return false;
  }

  private sendRequest(): void {
    const request: RIPPacket = {
      type: 'rip',
      command: 1,
      version: 2,
      entries: [{
        afi: 0, routeTag: 0,
        ipAddress: new IPAddress('0.0.0.0'),
        subnetMask: new SubnetMask('0.0.0.0'),
        nextHop: new IPAddress('0.0.0.0'),
        metric: RIP_METRIC_INFINITY,
      }],
    };

    for (const [portName] of this.ctx.getPorts()) {
      if (!this.isRIPInterface(portName)) continue;
      this.sendPacket(portName, request);
    }
  }

  private sendPeriodicUpdate(): void {
    if (!this.enabled) return;

    for (const [portName] of this.ctx.getPorts()) {
      if (!this.isRIPInterface(portName)) continue;
      this.sendUpdate(portName);
    }
  }

  private sendUpdate(outIface: string): void {
    const entries: RIPRouteEntry[] = [];

    for (const route of this.ctx.getRoutingTable()) {
      if (route.type === 'rip' && route.metric >= RIP_METRIC_INFINITY) continue;

      if (this.config.splitHorizon && route.iface === outIface) {
        if (this.config.poisonedReverse && route.type === 'rip') {
          entries.push(this.routeToRIPEntry(route, RIP_METRIC_INFINITY));
        }
        continue;
      }

      const metric = route.type === 'connected' ? 1 : Math.min(route.metric + 1, RIP_METRIC_INFINITY);
      entries.push(this.routeToRIPEntry(route, metric));
    }

    for (let i = 0; i < entries.length; i += RIP_MAX_ENTRIES_PER_MESSAGE) {
      const chunk = entries.slice(i, i + RIP_MAX_ENTRIES_PER_MESSAGE);
      const response: RIPPacket = {
        type: 'rip',
        command: 2,
        version: 2,
        entries: chunk,
      };
      this.sendPacket(outIface, response);
    }
  }

  private sendTriggeredUpdate(changedRoute: RouteEntry): void {
    if (!this.enabled) return;

    for (const [portName] of this.ctx.getPorts()) {
      if (!this.isRIPInterface(portName)) continue;

      if (this.config.splitHorizon && changedRoute.iface === portName) {
        if (this.config.poisonedReverse && changedRoute.type === 'rip') {
          const entry = this.routeToRIPEntry(changedRoute, RIP_METRIC_INFINITY);
          this.sendPacket(portName, {
            type: 'rip', command: 2, version: 2, entries: [entry],
          });
        }
        continue;
      }

      const metric = changedRoute.type === 'connected' ? 1
        : Math.min(changedRoute.metric + 1, RIP_METRIC_INFINITY);
      const entry = this.routeToRIPEntry(changedRoute, metric);
      this.sendPacket(portName, {
        type: 'rip', command: 2, version: 2, entries: [entry],
      });
    }
  }

  private routeToRIPEntry(route: RouteEntry, metric: number): RIPRouteEntry {
    return {
      afi: 2,
      routeTag: 0,
      ipAddress: route.network,
      subnetMask: route.mask,
      nextHop: new IPAddress('0.0.0.0'),
      metric,
    };
  }

  private sendPacket(outIface: string, ripPkt: RIPPacket): void {
    const port = this.ctx.getPorts().get(outIface);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    const ripSize = 4 + ripPkt.entries.length * 20;

    const udpPkt: UDPPacket = {
      type: 'udp',
      sourcePort: UDP_PORT_RIP,
      destinationPort: UDP_PORT_RIP,
      length: 8 + ripSize,
      checksum: 0,
      payload: ripPkt,
    };

    const ipPkt = createIPv4Packet(
      myIP,
      new IPAddress('255.255.255.255'),
      IP_PROTO_UDP,
      1,
      udpPkt,
      8 + ripSize,
    );

    this.ctx.sendFrame(outIface, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });

    Logger.debug(this.ctx.id, 'rip:send',
      `${this.ctx.name}: RIP ${ripPkt.command === 1 ? 'Request' : 'Response'} sent on ${outIface} (${ripPkt.entries.length} entries)`);
  }

  private processRouteEntry(inPort: string, srcIP: IPAddress, entry: RIPRouteEntry): void {
    if (entry.afi !== 2 && entry.afi !== 0) return;
    if (entry.metric < 1 || entry.metric > RIP_METRIC_INFINITY) return;

    const newMetric = Math.min(entry.metric, RIP_METRIC_INFINITY);
    const key = `${entry.ipAddress}/${entry.subnetMask.toCIDR()}`;
    const existing = this.routes.get(key);

    for (const route of this.ctx.getRoutingTable()) {
      if (route.type === 'connected' &&
          route.network.equals(entry.ipAddress) &&
          route.mask.toCIDR() === entry.subnetMask.toCIDR()) {
        return;
      }
    }

    if (!existing) {
      if (newMetric < RIP_METRIC_INFINITY) {
        this.installRoute(key, entry, newMetric, srcIP, inPort);
      }
      return;
    }

    if (existing.learnedFrom === srcIP.toString()) {
      if (newMetric >= RIP_METRIC_INFINITY) {
        this.invalidateRoute(key, existing);
      } else {
        existing.route.metric = newMetric;
        existing.lastUpdate = Date.now();
        existing.garbageCollect = false;
        this.resetTimeout(key, existing);
        this.updateRIB(key, existing);
      }
    } else {
      if (newMetric < existing.route.metric) {
        if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer);
        if (existing.gcTimer) clearTimeout(existing.gcTimer);

        this.ctx.setRoutingTable(this.ctx.getRoutingTable().filter(r =>
          !(r.type === 'rip' && r.network.equals(entry.ipAddress) && r.mask.toCIDR() === entry.subnetMask.toCIDR())
        ));

        this.installRoute(key, entry, newMetric, srcIP, inPort);
      }
    }
  }

  private installRoute(key: string, entry: RIPRouteEntry, metric: number, srcIP: IPAddress, inPort: string): void {
    const route: RouteEntry = {
      network: entry.ipAddress,
      mask: entry.subnetMask,
      nextHop: srcIP,
      iface: inPort,
      type: 'rip',
      ad: 120,
      metric,
    };

    this.ctx.pushRoute(route);

    const state: RIPRouteState = {
      route,
      lastUpdate: Date.now(),
      learnedFrom: srcIP.toString(),
      learnedOnIface: inPort,
      garbageCollect: false,
      timeoutTimer: null,
      gcTimer: null,
    };
    this.routes.set(key, state);
    this.resetTimeout(key, state);

    Logger.info(this.ctx.id, 'rip:route-learned',
      `${this.ctx.name}: RIP learned ${key} via ${srcIP} metric ${metric}`);
  }

  private updateRIB(key: string, state: RIPRouteState): void {
    const table = this.ctx.getRoutingTable();
    const idx = table.findIndex(r =>
      r.type === 'rip' &&
      r.network.equals(state.route.network) &&
      r.mask.toCIDR() === state.route.mask.toCIDR()
    );
    if (idx >= 0) {
      table[idx] = state.route;
    }
  }

  private invalidateRoute(key: string, state: RIPRouteState): void {
    state.route.metric = RIP_METRIC_INFINITY;
    state.garbageCollect = true;
    state.lastUpdate = Date.now();

    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    this.updateRIB(key, state);
    this.sendTriggeredUpdate(state.route);

    state.gcTimer = setTimeout(() => {
      this.garbageCollect(key);
    }, this.config.gcTimeout);

    Logger.info(this.ctx.id, 'rip:route-invalidated',
      `${this.ctx.name}: RIP route ${key} invalidated (metric=16)`);
  }

  private garbageCollect(key: string): void {
    const state = this.routes.get(key);
    if (!state) return;

    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.gcTimer) clearTimeout(state.gcTimer);

    this.routes.delete(key);
    this.ctx.setRoutingTable(this.ctx.getRoutingTable().filter(r =>
      !(r.type === 'rip' && r.network.equals(state.route.network) && r.mask.toCIDR() === state.route.mask.toCIDR())
    ));

    Logger.info(this.ctx.id, 'rip:route-gc',
      `${this.ctx.name}: RIP route ${key} garbage-collected`);
  }

  private resetTimeout(key: string, state: RIPRouteState): void {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.gcTimer) {
      clearTimeout(state.gcTimer);
      state.gcTimer = null;
    }

    state.timeoutTimer = setTimeout(() => {
      this.invalidateRoute(key, state);
    }, this.config.routeTimeout);
  }
}
