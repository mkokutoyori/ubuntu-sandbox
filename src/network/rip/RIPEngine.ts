/**
 * RIPEngine — Extracted RIPv2 protocol engine (RFC 2453)
 *
 * Fixes:
 * - 1.1: Extracted ~430 lines from Router.ts God Class
 * - 1.6: Implements IProtocolEngine interface
 * - 1.7: Uses centralized constants from constants.ts
 *
 * Features:
 * - Periodic updates (RFC 2453 §3.9.2)
 * - Triggered updates (RFC 2453 §3.9.3)
 * - Split horizon with poisoned reverse (RFC 2453 §3.5)
 * - Route timeout and garbage collection (RFC 2453 §3.8)
 */

import type { IProtocolEngine } from '../core/interfaces';
import type { IPAddress, SubnetMask, RIPPacket, RIPRouteEntry, UDPPacket, MACAddress } from '../core/types';
import {
  IP_PROTO_UDP, UDP_PORT_RIP, RIP_METRIC_INFINITY, RIP_MAX_ENTRIES_PER_MESSAGE,
  ETHERTYPE_IPV4, createIPv4Packet,
} from '../core/types';
import { RIP_TIMERS, ADMINISTRATIVE_DISTANCE } from '../core/constants';
import { Logger } from '../core/Logger';

// ─── Types ──────────────────────────────────────────────────────────

/** RIP route entry in the RIB */
export interface RIPRouteEntry_RIB {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress;
  iface: string;
  type: 'rip';
  ad: number;
  metric: number;
}

/** Internal RIP route with aging metadata */
export interface RIPRouteState {
  route: RIPRouteEntry_RIB;
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

/**
 * Callbacks that the RIPEngine uses to interact with the owning Router.
 * Decouples the engine from the Router class (Dependency Inversion).
 */
export interface RIPCallbacks {
  /** Get IP address configured on a port */
  getPortIP(portName: string): IPAddress | null;
  /** Get subnet mask configured on a port */
  getPortMask(portName: string): SubnetMask | null;
  /** Get MAC address of a port */
  getPortMAC(portName: string): MACAddress;
  /** Get all port names */
  getPortNames(): string[];
  /** Send a frame out of a port */
  sendFrame(portName: string, frame: import('../core/types').EthernetFrame): boolean;
  /** Get the current routing table for advertising */
  getRoutingTable(): Array<{ network: IPAddress; mask: SubnetMask; iface: string; type: string; metric: number }>;
  /** Install a RIP route into the RIB */
  installRoute(route: RIPRouteEntry_RIB): void;
  /** Remove RIP routes matching a network/mask from the RIB */
  removeRoute(network: IPAddress, mask: SubnetMask): void;
  /** Update an existing RIP route in the RIB */
  updateRoute(network: IPAddress, mask: SubnetMask, route: RIPRouteEntry_RIB): void;
}

// ─── Default Config ─────────────────────────────────────────────────

function createDefaultConfig(): RIPConfig {
  return {
    networks: [],
    updateInterval: RIP_TIMERS.UPDATE_INTERVAL_MS,
    routeTimeout: RIP_TIMERS.ROUTE_TIMEOUT_MS,
    gcTimeout: RIP_TIMERS.GARBAGE_COLLECTION_MS,
    splitHorizon: true,
    poisonedReverse: true,
  };
}

// ─── RIP Engine ─────────────────────────────────────────────────────

/**
 * RIPv2 protocol engine (RFC 2453).
 *
 * Standalone engine that communicates with the Router via callbacks.
 * This follows the same pattern as OSPFEngine (Dependency Inversion).
 *
 * @example
 * ```ts
 * const rip = new RIPEngine('router1', 'R1', {
 *   getPortIP: (name) => port.getIPAddress(),
 *   sendFrame: (name, frame) => router.sendFrame(name, frame),
 *   // ... other callbacks
 * });
 * rip.start();
 * rip.advertiseNetwork(network, mask);
 * ```
 */
export class RIPEngine implements IProtocolEngine {
  private config: RIPConfig;
  private routes: Map<string, RIPRouteState> = new Map();
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  constructor(
    private readonly equipmentId: string,
    private readonly hostname: string,
    private readonly callbacks: RIPCallbacks,
    config?: Partial<RIPConfig>,
  ) {
    this.config = createDefaultConfig();
    if (config) {
      Object.assign(this.config, config);
    }
  }

  // ─── IProtocolEngine ──────────────────────────────────────────────

  start(): void {
    this.running = true;

    this.updateTimer = setInterval(() => {
      this.sendPeriodicUpdate();
    }, this.config.updateInterval);

    this.sendRequest();

    Logger.info(this.equipmentId, 'rip:enabled',
      `${this.hostname}: RIPv2 enabled, update interval ${this.config.updateInterval}ms`);
  }

  stop(): void {
    this.running = false;

    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    for (const [, state] of this.routes) {
      if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
      if (state.gcTimer) clearTimeout(state.gcTimer);
    }
    this.routes.clear();

    Logger.info(this.equipmentId, 'rip:disabled', `${this.hostname}: RIPv2 disabled`);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Configuration ────────────────────────────────────────────────

  getConfig(): RIPConfig {
    return { ...this.config, networks: [...this.config.networks] };
  }

  advertiseNetwork(network: IPAddress, mask: SubnetMask): void {
    this.config.networks.push({ network, mask });
  }

  /** Get route states for debugging/display */
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

  // ─── Packet Processing ────────────────────────────────────────────

  /** Handle an incoming RIP packet */
  processPacket(inPort: string, srcIP: IPAddress, ripPkt: RIPPacket): void {
    if (!this.running) return;
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

  // ─── Private Methods ──────────────────────────────────────────────

  private isRIPInterface(portName: string): boolean {
    const ip = this.callbacks.getPortIP(portName);
    const mask = this.callbacks.getPortMask(portName);
    if (!ip || !mask) return false;

    const portNetInt = ip.toUint32() & mask.toUint32();

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
        ipAddress: new (Object.getPrototypeOf(this.config.networks[0]?.network ?? {}).constructor ?? class { constructor() {} })('0.0.0.0') as IPAddress,
        subnetMask: new (Object.getPrototypeOf(this.config.networks[0]?.mask ?? {}).constructor ?? class { constructor() {} })('0.0.0.0') as SubnetMask,
        nextHop: new (Object.getPrototypeOf(this.config.networks[0]?.network ?? {}).constructor ?? class { constructor() {} })('0.0.0.0') as IPAddress,
        metric: RIP_METRIC_INFINITY,
      }],
    };

    for (const portName of this.callbacks.getPortNames()) {
      if (!this.isRIPInterface(portName)) continue;
      this.sendPacket(portName, request);
    }
  }

  private sendPeriodicUpdate(): void {
    if (!this.running) return;

    for (const portName of this.callbacks.getPortNames()) {
      if (!this.isRIPInterface(portName)) continue;
      this.sendUpdate(portName);
    }
  }

  private sendUpdate(outIface: string): void {
    const entries: RIPRouteEntry[] = [];
    const routingTable = this.callbacks.getRoutingTable();

    for (const route of routingTable) {
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
      const response: RIPPacket = { type: 'rip', command: 2, version: 2, entries: chunk };
      this.sendPacket(outIface, response);
    }
  }

  private sendTriggeredUpdate(changedRoute: RIPRouteEntry_RIB): void {
    if (!this.running) return;

    for (const portName of this.callbacks.getPortNames()) {
      if (!this.isRIPInterface(portName)) continue;

      if (this.config.splitHorizon && changedRoute.iface === portName) {
        if (this.config.poisonedReverse) {
          const entry = this.routeToRIPEntry(changedRoute, RIP_METRIC_INFINITY);
          this.sendPacket(portName, { type: 'rip', command: 2, version: 2, entries: [entry] });
        }
        continue;
      }

      const metric = Math.min(changedRoute.metric + 1, RIP_METRIC_INFINITY);
      const entry = this.routeToRIPEntry(changedRoute, metric);
      this.sendPacket(portName, { type: 'rip', command: 2, version: 2, entries: [entry] });
    }
  }

  private routeToRIPEntry(
    route: { network: IPAddress; mask: SubnetMask },
    metric: number,
  ): RIPRouteEntry {
    return {
      afi: 2,
      routeTag: 0,
      ipAddress: route.network,
      subnetMask: route.mask,
      nextHop: new (route.network.constructor as new (s: string) => IPAddress)('0.0.0.0'),
      metric,
    };
  }

  private sendPacket(outIface: string, ripPkt: RIPPacket): void {
    const myIP = this.callbacks.getPortIP(outIface);
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

    const dstIP = new (myIP.constructor as new (s: string) => IPAddress)('255.255.255.255');
    const ipPkt = createIPv4Packet(myIP, dstIP, IP_PROTO_UDP, 1, udpPkt, 8 + ripSize);

    const mac = this.callbacks.getPortMAC(outIface);
    this.callbacks.sendFrame(outIface, {
      srcMAC: mac,
      dstMAC: (mac.constructor as { broadcast(): MACAddress }).broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });

    Logger.debug(this.equipmentId, 'rip:send',
      `${this.hostname}: RIP ${ripPkt.command === 1 ? 'Request' : 'Response'} sent on ${outIface} (${ripPkt.entries.length} entries)`);
  }

  private processRouteEntry(inPort: string, srcIP: IPAddress, entry: RIPRouteEntry): void {
    if (entry.afi !== 2 && entry.afi !== 0) return;
    if (entry.metric < 1 || entry.metric > RIP_METRIC_INFINITY) return;

    const newMetric = Math.min(entry.metric, RIP_METRIC_INFINITY);
    const key = `${entry.ipAddress}/${entry.subnetMask.toCIDR()}`;
    const existing = this.routes.get(key);

    // Don't install routes for own connected networks
    for (const route of this.callbacks.getRoutingTable()) {
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
        this.callbacks.updateRoute(existing.route.network, existing.route.mask, existing.route);
      }
    } else {
      if (newMetric < existing.route.metric) {
        if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer);
        if (existing.gcTimer) clearTimeout(existing.gcTimer);
        this.callbacks.removeRoute(entry.ipAddress, entry.subnetMask);
        this.installRoute(key, entry, newMetric, srcIP, inPort);
      }
    }
  }

  private installRoute(key: string, entry: RIPRouteEntry, metric: number, srcIP: IPAddress, inPort: string): void {
    const route: RIPRouteEntry_RIB = {
      network: entry.ipAddress,
      mask: entry.subnetMask,
      nextHop: srcIP,
      iface: inPort,
      type: 'rip',
      ad: ADMINISTRATIVE_DISTANCE.RIP,
      metric,
    };

    this.callbacks.installRoute(route);

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

    Logger.info(this.equipmentId, 'rip:route-learned',
      `${this.hostname}: RIP learned ${key} via ${srcIP} metric ${metric}`);
  }

  private invalidateRoute(key: string, state: RIPRouteState): void {
    state.route.metric = RIP_METRIC_INFINITY;
    state.garbageCollect = true;
    state.lastUpdate = Date.now();

    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    this.callbacks.updateRoute(state.route.network, state.route.mask, state.route);
    this.sendTriggeredUpdate(state.route);

    state.gcTimer = setTimeout(() => {
      this.garbageCollect(key);
    }, this.config.gcTimeout);

    Logger.info(this.equipmentId, 'rip:route-invalidated',
      `${this.hostname}: RIP route ${key} invalidated (metric=16)`);
  }

  private garbageCollect(key: string): void {
    const state = this.routes.get(key);
    if (!state) return;

    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.gcTimer) clearTimeout(state.gcTimer);

    this.routes.delete(key);
    this.callbacks.removeRoute(state.route.network, state.route.mask);

    Logger.info(this.equipmentId, 'rip:route-gc',
      `${this.hostname}: RIP route ${key} garbage-collected`);
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
