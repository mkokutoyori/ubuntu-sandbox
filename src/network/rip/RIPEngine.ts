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
import type { RIPPacket, RIPRouteEntry, UDPPacket } from '../core/types';
import {
  IPAddress, SubnetMask, MACAddress,
  IP_PROTO_UDP, UDP_PORT_RIP, RIP_METRIC_INFINITY, RIP_MAX_ENTRIES_PER_MESSAGE,
  ETHERTYPE_IPV4, createIPv4Packet,
} from '../core/types';
import {
  RIP_TIMERS, ADMINISTRATIVE_DISTANCE,
  RIP_V2_MULTICAST_IP, RIP_V2_MULTICAST_MAC,
} from '../core/constants';
import { Logger } from '../core/Logger';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  RIPSignalStore,
  makeReadonlyRIPObservables,
  projectRipRoutes,
  projectRipStats,
  type RIPObservables,
} from './observables';
import { RIPSignalRefreshActor } from './actors';

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
  /** TimerSet token (Phase 4b2-RIP migration). */
  timeoutTimer: symbol | null;
  gcTimer: symbol | null;
}

export type RIPRedistSource = 'static' | 'connected' | 'ospf' | 'eigrp' | 'bgp';

/** RIP configuration */
export interface RIPConfig {
  networks: Array<{ network: IPAddress; mask: SubnetMask }>;
  updateInterval: number;
  routeTimeout: number;
  gcTimeout: number;
  splitHorizon: boolean;
  poisonedReverse: boolean;
  /**
   * Interfaces on which RIP never transmits (Cisco `passive-interface`,
   * Huawei `silent-interface`). Received Responses are still processed —
   * the interface keeps learning routes, it just stays silent.
   */
  passiveInterfaces: Set<string>;
  redistribute: Map<RIPRedistSource, { metric?: number }>;
  defaultMetric: number | null;
  defaultInformationOriginate: boolean;
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
  /**
   * Live protocol version (`version 1|2` CLI). v2 sends to the
   * 224.0.0.9 multicast group (RFC 2453 §4.3); v1 broadcasts
   * (RFC 1058). Defaults to 2 when absent.
   */
  getRipVersion?(): 1 | 2;
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
    passiveInterfaces: new Set(),
    redistribute: new Map(),
    defaultMetric: null,
    defaultInformationOriginate: false,
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
  private updateTimer: symbol | null = null;
  private running: boolean = false;

  // ── Reactive plumbing (Phase 4b2-RIP) ───────────────────────────────
  private busOverride: IEventBus | null = null;
  private schedulerOverride: IScheduler | null = null;
  private readonly timers = new TimerSet(() => this.getScheduler());
  private readonly signalStore = new RIPSignalStore();
  /** Read-only observables (routes, stats). */
  readonly observables: RIPObservables = makeReadonlyRIPObservables(this.signalStore);
  private signalRefreshActor: RIPSignalRefreshActor | null = null;

  // Counters that feed projectRipStats.
  private updatesSent = 0;
  private updatesReceived = 0;
  private routesAddedCount = 0;
  private routesRemovedCount = 0;

  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
    this.attachActors();
  }
  setScheduler(scheduler: IScheduler | null): void { this.schedulerOverride = scheduler; }
  private getBus(): IEventBus { return this.busOverride ?? getDefaultEventBus(); }
  private getScheduler(): IScheduler { return this.schedulerOverride ?? getDefaultScheduler(); }
  /** Public — used by `RIPSignalRefreshActor` to filter events. */
  getDeviceId(): string { return this.equipmentId; }

  private deviceRef() {
    return { deviceId: this.equipmentId, hostname: this.hostname };
  }

  private attachActors(): void {
    this.signalRefreshActor?.stop();
    this.signalRefreshActor = new RIPSignalRefreshActor(this.getBus(), this);
    this.signalRefreshActor.start();
  }

  // ── Actor-API: signal refresh helpers ──────────────────────────────

  /** [actor-API] Refresh routes + stats. */
  _refreshAllSignals(): void {
    this.signalStore.routes.set(projectRipRoutes(this.routes));
    this._refreshStatsSignal();
  }

  /** [actor-API] Refresh stats only. */
  _refreshStatsSignal(): void {
    this.signalStore.stats.set(projectRipStats({
      running: this.running,
      routes: this.routes,
      updatesSent: this.updatesSent,
      updatesReceived: this.updatesReceived,
      routesAdded: this.routesAddedCount,
      routesRemoved: this.routesRemovedCount,
    }));
  }

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
    this.attachActors();
  }

  // ─── IProtocolEngine ──────────────────────────────────────────────

  start(): void {
    this.running = true;

    this.updateTimer = this.timers.setInterval(() => {
      this.sendPeriodicUpdate();
    }, this.config.updateInterval);

    this.signalRefreshActor?.start();
    this.sendRequest();

    Logger.info(this.equipmentId, 'rip:enabled',
      `${this.hostname}: RIPv2 enabled, update interval ${this.config.updateInterval}ms`);

    this.getBus().publish({
      topic: 'rip.engine.started',
      payload: { ...this.deviceRef(), updateIntervalMs: this.config.updateInterval },
    });
    this._refreshAllSignals();
  }

  stop(): void {
    this.running = false;

    // TimerSet.clearAll() releases every per-route timer in one call.
    this.timers.clearAll();
    this.updateTimer = null;
    this.triggeredTimer = null;
    this.pendingTriggered.clear();
    for (const [, state] of this.routes) {
      state.timeoutTimer = null;
      state.gcTimer = null;
    }
    this.routes.clear();
    this.signalRefreshActor?.stop();

    Logger.info(this.equipmentId, 'rip:disabled', `${this.hostname}: RIPv2 disabled`);

    this.getBus().publish({
      topic: 'rip.engine.stopped',
      payload: this.deviceRef(),
    });
    this._refreshAllSignals();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Configuration ────────────────────────────────────────────────

  getConfig(): RIPConfig {
    return {
      ...this.config,
      networks: [...this.config.networks],
      passiveInterfaces: new Set(this.config.passiveInterfaces),
      redistribute: new Map(this.config.redistribute),
    };
  }

  /** Merge a partial config (used by `router rip` re-entry). */
  configure(config: Partial<RIPConfig>): void {
    Object.assign(this.config, config);
  }

  advertiseNetwork(network: IPAddress, mask: SubnetMask): void {
    this.config.networks.push({ network, mask });
  }

  // ── Passive interfaces (IOS `passive-interface` / VRP `silent-interface`) ──
  //
  // RFC 2453 has no passive concept; this models real router behaviour:
  // the interface sends NO RIP traffic (no Request at startup, no periodic
  // or triggered Responses, no answer to received Requests) but received
  // Responses are still processed, so routes keep being learned on it.

  setPassiveInterface(iface: string): void {
    this.config.passiveInterfaces.add(iface);
  }

  removePassiveInterface(iface: string): void {
    this.config.passiveInterfaces.delete(iface);
  }

  isPassiveInterface(iface: string): boolean {
    return this.config.passiveInterfaces.has(iface);
  }

  setRedistribution(source: RIPRedistSource, metric?: number): void {
    this.config.redistribute.set(source, { metric });
  }

  removeRedistribution(source: RIPRedistSource): void {
    this.config.redistribute.delete(source);
  }

  setDefaultMetric(metric: number | null): void {
    this.config.defaultMetric = metric;
  }

  setDefaultInformationOriginate(on: boolean): void {
    this.config.defaultInformationOriginate = on;
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
      // A passive interface never transmits — not even Request replies.
      if (!this.isPassiveInterface(inPort)) this.sendUpdate(inPort);
      return;
    }

    if (ripPkt.command === 2) {
      this.updatesReceived++;
      this.getBus().publish({
        topic: 'rip.update.received',
        payload: {
          ...this.deviceRef(),
          iface: inPort,
          fromIp: srcIP.toString(),
          routeCount: ripPkt.entries.length,
        },
      });
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

  /** Live version: the CLI override, or RIPv2 by default. */
  private ripVersion(): 1 | 2 {
    return this.callbacks.getRipVersion?.() ?? 2;
  }

  private sendRequest(): void {
    // RFC 2453 §3.9.1 — a request for the full table is a single
    // entry with AFI 0 and metric 16.
    const request: RIPPacket = {
      type: 'rip',
      command: 1,
      version: this.ripVersion(),
      entries: [{
        afi: 0, routeTag: 0,
        ipAddress: new IPAddress('0.0.0.0'),
        subnetMask: new SubnetMask('0.0.0.0'),
        nextHop: new IPAddress('0.0.0.0'),
        metric: RIP_METRIC_INFINITY,
      }],
    };

    for (const portName of this.callbacks.getPortNames()) {
      if (!this.isRIPInterface(portName)) continue;
      if (this.isPassiveInterface(portName)) continue;
      this.sendPacket(portName, request);
    }
  }

  private sendPeriodicUpdate(): void {
    if (!this.running) return;

    for (const portName of this.callbacks.getPortNames()) {
      if (!this.isRIPInterface(portName)) continue;
      if (this.isPassiveInterface(portName)) continue;
      this.sendUpdate(portName);
    }
  }

  private coveredByNetworkStatement(network: IPAddress): boolean {
    const netInt = network.toUint32();
    for (const stmt of this.config.networks) {
      const cfgNetInt = stmt.network.toUint32() & stmt.mask.toUint32();
      if ((netInt & stmt.mask.toUint32()) === cfgNetInt) return true;
    }
    return false;
  }

  private advertisableMetric(
    route: { network: IPAddress; type: string; metric: number },
  ): number | null {
    const isDefaultPrefix = route.network.toUint32() === 0;
    if (isDefaultPrefix) {
      return this.config.defaultInformationOriginate ? 1 : null;
    }
    switch (route.type) {
      case 'rip':
        return route.metric >= RIP_METRIC_INFINITY
          ? null : Math.min(route.metric + 1, RIP_METRIC_INFINITY);
      case 'connected': {
        if (this.coveredByNetworkStatement(route.network)) return 1;
        const redist = this.config.redistribute.get('connected');
        return redist ? Math.min(redist.metric ?? 1, RIP_METRIC_INFINITY) : null;
      }
      case 'static': {
        const redist = this.config.redistribute.get('static');
        return redist ? Math.min(redist.metric ?? 1, RIP_METRIC_INFINITY) : null;
      }
      case 'ospf':
      case 'eigrp':
      case 'bgp': {
        const redist = this.config.redistribute.get(route.type);
        if (!redist) return null;
        const metric = redist.metric ?? this.config.defaultMetric;
        return metric === null || metric === undefined
          ? null : Math.min(metric, RIP_METRIC_INFINITY);
      }
      default:
        return null;
    }
  }

  private sendUpdate(outIface: string): void {
    const entries: RIPRouteEntry[] = [];
    const routingTable = this.callbacks.getRoutingTable();

    for (const route of routingTable) {
      const metric = this.advertisableMetric(route);
      if (metric === null) continue;

      if (this.config.splitHorizon && route.iface === outIface) {
        if (this.config.poisonedReverse && route.type === 'rip') {
          entries.push(this.routeToRIPEntry(route, RIP_METRIC_INFINITY));
        }
        continue;
      }

      entries.push(this.routeToRIPEntry(route, metric));
    }

    for (let i = 0; i < entries.length; i += RIP_MAX_ENTRIES_PER_MESSAGE) {
      const chunk = entries.slice(i, i + RIP_MAX_ENTRIES_PER_MESSAGE);
      const response: RIPPacket = {
        type: 'rip', command: 2, version: this.ripVersion(), entries: chunk,
      };
      this.sendPacket(outIface, response);
    }
    this.updatesSent++;
    this.getBus().publish({
      topic: 'rip.update.sent',
      payload: {
        ...this.deviceRef(),
        iface: outIface,
        routeCount: entries.length,
        destIp: this.destinationIp().toString(),
        triggered: false,
      },
    });
  }

  // ── Triggered updates (RFC 2453 §3.10.1) ───────────────────────────
  //
  // Route changes are coalesced and flushed after a random 1–5 s delay
  // so a cascade of changes produces ONE batched update per interface
  // instead of an update storm.

  private readonly pendingTriggered = new Map<string, RIPRouteEntry_RIB>();
  private triggeredTimer: symbol | null = null;

  private scheduleTriggeredUpdate(changedRoute: RIPRouteEntry_RIB): void {
    if (!this.running) return;
    const key = `${changedRoute.network}/${changedRoute.mask.toCIDR()}`;
    this.pendingTriggered.set(key, changedRoute);
    if (this.triggeredTimer) return;            // window already armed
    const span = RIP_TIMERS.TRIGGERED_DELAY_MAX_MS
      - RIP_TIMERS.TRIGGERED_DELAY_MIN_MS;
    const delay = RIP_TIMERS.TRIGGERED_DELAY_MIN_MS + Math.random() * span;
    this.triggeredTimer = this.timers.setTimeout(
      () => this.flushTriggeredUpdates(), delay);
  }

  private flushTriggeredUpdates(): void {
    this.triggeredTimer = null;
    const changed = [...this.pendingTriggered.values()];
    this.pendingTriggered.clear();
    if (!this.running || changed.length === 0) return;

    let totalEntries = 0;
    for (const portName of this.callbacks.getPortNames()) {
      if (!this.isRIPInterface(portName)) continue;
      if (this.isPassiveInterface(portName)) continue;
      const entries: RIPRouteEntry[] = [];
      for (const route of changed) {
        if (this.config.splitHorizon && route.iface === portName) {
          if (this.config.poisonedReverse) {
            entries.push(this.routeToRIPEntry(route, RIP_METRIC_INFINITY));
          }
          continue;
        }
        entries.push(this.routeToRIPEntry(
          route, Math.min(route.metric + 1, RIP_METRIC_INFINITY)));
      }
      for (let i = 0; i < entries.length; i += RIP_MAX_ENTRIES_PER_MESSAGE) {
        this.sendPacket(portName, {
          type: 'rip', command: 2, version: this.ripVersion(),
          entries: entries.slice(i, i + RIP_MAX_ENTRIES_PER_MESSAGE),
        });
      }
      totalEntries += entries.length;
    }
    if (totalEntries > 0) {
      this.updatesSent++;
      this.getBus().publish({
        topic: 'rip.update.sent',
        payload: {
          ...this.deviceRef(),
          iface: '*',
          routeCount: totalEntries,
          destIp: this.destinationIp().toString(),
          triggered: true,
        },
      });
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
      nextHop: new IPAddress('0.0.0.0'),
      metric,
    };
  }

  /** RIPv2 multicasts to 224.0.0.9; RIPv1 broadcasts (RFC 2453 §4.3). */
  private destinationIp(): IPAddress {
    return this.ripVersion() === 2
      ? new IPAddress(RIP_V2_MULTICAST_IP)
      : new IPAddress('255.255.255.255');
  }

  private destinationMac(): MACAddress {
    return this.ripVersion() === 2
      ? new MACAddress(RIP_V2_MULTICAST_MAC)
      : MACAddress.broadcast();
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

    const ipPkt = createIPv4Packet(
      myIP, this.destinationIp(), IP_PROTO_UDP, 1, udpPkt, 8 + ripSize);

    this.callbacks.sendFrame(outIface, {
      srcMAC: this.callbacks.getPortMAC(outIface),
      dstMAC: this.destinationMac(),
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
        const metricChanged = existing.route.metric !== newMetric;
        existing.route.metric = newMetric;
        existing.lastUpdate = Date.now();
        existing.garbageCollect = false;
        this.resetTimeout(key, existing);
        this.callbacks.updateRoute(existing.route.network, existing.route.mask, existing.route);
        // RFC 2453 §3.10.1 — metric changes trigger an update.
        if (metricChanged) this.scheduleTriggeredUpdate(existing.route);
      }
    } else {
      if (newMetric < existing.route.metric) {
        if (existing.timeoutTimer) this.timers.clear(existing.timeoutTimer);
        if (existing.gcTimer) this.timers.clear(existing.gcTimer);
        this.getBus().publish({
          topic: 'rip.route.updated',
          payload: {
            ...this.deviceRef(),
            network: entry.ipAddress.toString(),
            mask: entry.subnetMask.toString(),
            oldMetric: existing.route.metric,
            newMetric,
            nextHop: srcIP.toString(),
            iface: inPort,
          },
        });
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
    this.routesAddedCount++;
    // RFC 2453 §3.10.1 — new routes trigger an update.
    this.scheduleTriggeredUpdate(route);

    Logger.info(this.equipmentId, 'rip:route-learned',
      `${this.hostname}: RIP learned ${key} via ${srcIP} metric ${metric}`);

    this.getBus().publish({
      topic: 'rip.route.added',
      payload: {
        ...this.deviceRef(),
        network: entry.ipAddress.toString(),
        mask: entry.subnetMask.toString(),
        nextHop: srcIP.toString(),
        iface: inPort,
        metric,
        learnedFrom: srcIP.toString(),
      },
    });
  }

  private invalidateRoute(key: string, state: RIPRouteState): void {
    state.route.metric = RIP_METRIC_INFINITY;
    state.garbageCollect = true;
    state.lastUpdate = Date.now();

    if (state.timeoutTimer) {
      this.timers.clear(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    this.callbacks.updateRoute(state.route.network, state.route.mask, state.route);
    this.scheduleTriggeredUpdate(state.route);

    state.gcTimer = this.timers.setTimeout(() => {
      this.garbageCollect(key);
    }, this.config.gcTimeout);

    Logger.info(this.equipmentId, 'rip:route-invalidated',
      `${this.hostname}: RIP route ${key} invalidated (metric=16)`);

    this.getBus().publish({
      topic: 'rip.route.timed-out',
      payload: {
        ...this.deviceRef(),
        network: state.route.network.toString(),
        mask: state.route.mask.toString(),
      },
    });
  }

  private garbageCollect(key: string): void {
    const state = this.routes.get(key);
    if (!state) return;

    if (state.timeoutTimer) this.timers.clear(state.timeoutTimer);
    if (state.gcTimer) this.timers.clear(state.gcTimer);

    this.routes.delete(key);
    this.callbacks.removeRoute(state.route.network, state.route.mask);
    this.routesRemovedCount++;

    Logger.info(this.equipmentId, 'rip:route-gc',
      `${this.hostname}: RIP route ${key} garbage-collected`);

    this.getBus().publish({
      topic: 'rip.route.removed',
      payload: {
        ...this.deviceRef(),
        network: state.route.network.toString(),
        mask: state.route.mask.toString(),
        reason: 'gc',
      },
    });
  }

  private resetTimeout(key: string, state: RIPRouteState): void {
    if (state.timeoutTimer) this.timers.clear(state.timeoutTimer);
    if (state.gcTimer) {
      this.timers.clear(state.gcTimer);
      state.gcTimer = null;
    }

    state.timeoutTimer = this.timers.setTimeout(() => {
      this.invalidateRoute(key, state);
    }, this.config.routeTimeout);
  }
}
