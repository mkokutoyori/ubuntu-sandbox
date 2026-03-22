/**
 * IPv6DataPlane - IPv6 Forwarding Engine (RFC 8200, RFC 4861)
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Handles IPv6 packet processing, NDP, Router Advertisements,
 * and IPv6 forwarding.
 */

import type { Port } from '../../hardware/Port';
import type { RouterCounters } from '../Router';
import {
  IPv6Address, IPv6Packet, ICMPv6Packet, MACAddress,
  NDPNeighborSolicitation, NDPNeighborAdvertisement, NDPRouterSolicitation,
  EthernetFrame,
  ETHERTYPE_IPV6, IP_PROTO_ICMPV6,
  createIPv6Packet, createNeighborSolicitation, createNeighborAdvertisement, createRouterAdvertisement,
  createICMPv6EchoReply,
  IPV6_ALL_NODES_MULTICAST,
} from '../../core/types';
import { Logger } from '../../core/Logger';

// ─── IPv6 Types ─────────────────────────────────────────────────

export interface IPv6RouteEntry {
  prefix: IPv6Address;
  prefixLength: number;
  nextHop: IPv6Address | null;
  iface: string;
  type: 'connected' | 'static' | 'default';
  ad: number;
  metric: number;
  [key: string]: any;
}

export type NeighborState = 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';

export interface NeighborCacheEntry {
  mac: MACAddress;
  iface: string;
  state: NeighborState;
  isRouter: boolean;
  timestamp: number;
}

interface PendingNDP {
  resolve: (mac: MACAddress) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedIPv6Packet {
  frame: IPv6Packet;
  outIface: string;
  nextHopIP: IPv6Address;
  timer: ReturnType<typeof setTimeout>;
}

export interface RAConfig {
  enabled: boolean;
  interval: number;
  curHopLimit: number;
  managedFlag: boolean;
  otherConfigFlag: boolean;
  routerLifetime: number;
  prefixes: Array<{
    prefix: IPv6Address;
    prefixLength: number;
    onLink: boolean;
    autonomous: boolean;
    validLifetime: number;
    preferredLifetime: number;
  }>;
}

/** Interface to access router state needed by IPv6 engine */
export interface IPv6RouterContext {
  readonly id: string;
  readonly name: string;
  getPorts(): Map<string, Port>;
  sendFrame(iface: string, frame: EthernetFrame): void;
  getCounters(): RouterCounters;
}

// ─── IPv6 Data Plane ────────────────────────────────────────────

export class IPv6DataPlane {
  private routingTable: IPv6RouteEntry[] = [];
  private neighborCache: Map<string, NeighborCacheEntry> = new Map();
  private pendingNDPs: Map<string, PendingNDP[]> = new Map();
  private packetQueue: QueuedIPv6Packet[] = [];
  private readonly defaultHopLimit = 64;
  private enabled = false;
  private raConfig: Map<string, RAConfig> = new Map();
  private raTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(private readonly ctx: IPv6RouterContext) {}

  // ─── IPv6 Routing State ─────────────────────────────────────────

  enableRouting(): void { this.enabled = true; }
  disableRouting(): void { this.enabled = false; }
  isRoutingEnabled(): boolean { return this.enabled; }

  getRoutingTable(): IPv6RouteEntry[] { return [...this.routingTable]; }
  getRoutingTableInternal(): IPv6RouteEntry[] { return this.routingTable; }
  setRoutingTable(table: IPv6RouteEntry[]): void { this.routingTable = table; }

  getNeighborCache(): Map<string, NeighborCacheEntry> {
    const copy = new Map<string, NeighborCacheEntry>();
    for (const [k, v] of this.neighborCache) {
      copy.set(k, { ...v });
    }
    return copy;
  }
  getNeighborCacheInternal(): Map<string, NeighborCacheEntry> { return this.neighborCache; }

  configureInterface(portName: string, address: IPv6Address, prefixLength: number): void {
    const port = this.ctx.getPorts().get(portName);
    if (!port) return;

    port.addIPv6Address(address, prefixLength, 'global');

    // Add connected route for the prefix
    const networkPrefix = address.getNetworkPrefix(prefixLength);
    const alreadyExists = this.routingTable.some(
      r => r.type === 'connected' &&
        r.prefix.toString() === networkPrefix.toString() &&
        r.prefixLength === prefixLength
    );
    if (!alreadyExists) {
      this.routingTable.push({
        prefix: networkPrefix,
        prefixLength,
        nextHop: null,
        iface: portName,
        type: 'connected',
        ad: 0,
        metric: 0,
      });
    }

    Logger.info(this.ctx.id, 'router:ipv6-config',
      `${this.ctx.name}: IPv6 ${address}/${prefixLength} configured on ${portName}`);
  }

  addStaticRoute(prefix: IPv6Address, prefixLength: number, nextHop: IPv6Address, iface: string): void {
    this.routingTable.push({
      prefix,
      prefixLength,
      nextHop,
      iface,
      type: 'static',
      ad: 1,
      metric: 0,
    });
  }

  setDefaultRoute(nextHop: IPv6Address, iface: string): void {
    this.routingTable.push({
      prefix: new IPv6Address('::'),
      prefixLength: 0,
      nextHop,
      iface,
      type: 'default',
      ad: 1,
      metric: 0,
    });
  }

  lookupRoute(destIP: IPv6Address): IPv6RouteEntry | null {
    let bestRoute: IPv6RouteEntry | null = null;
    let bestPrefixLen = -1;
    let bestAD = Infinity;

    for (const route of this.routingTable) {
      if (!destIP.matchesPrefix(route.prefix, route.prefixLength)) continue;

      if (route.prefixLength > bestPrefixLen ||
        (route.prefixLength === bestPrefixLen && route.ad < bestAD)) {
        bestRoute = route;
        bestPrefixLen = route.prefixLength;
        bestAD = route.ad;
      }
    }

    return bestRoute;
  }

  findInterfaceForIPv6(ip: IPv6Address): string | null {
    for (const [portName, port] of this.ctx.getPorts()) {
      if (port.hasIPv6Address(ip)) return portName;
    }
    return null;
  }

  // ─── Frame Dispatch ───────────────────────────────────────────

  processPacket(inPort: string, ipv6: IPv6Packet): void {
    if (!ipv6 || ipv6.type !== 'ipv6') return;

    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;

    const destIP = ipv6.destinationIP;
    let isForUs = false;

    for (const [, p] of this.ctx.getPorts()) {
      if (p.hasIPv6Address(destIP)) {
        isForUs = true;
        break;
      }
    }

    const isAllNodesMulticast = destIP.isAllNodesMulticast();
    const isAllRoutersMulticast = destIP.isAllRoutersMulticast();
    const isSolicitedNode = destIP.isSolicitedNodeMulticast();

    if (isForUs || isAllNodesMulticast || isAllRoutersMulticast) {
      this.handleLocalDelivery(inPort, ipv6);
      return;
    }

    if (isSolicitedNode) {
      if (this.shouldAcceptSolicitedNode(destIP)) {
        this.handleLocalDelivery(inPort, ipv6);
        return;
      }
    }

    if (this.enabled) {
      this.forwardPacket(inPort, ipv6);
    }
  }

  // ─── Local Delivery ───────────────────────────────────────────

  private shouldAcceptSolicitedNode(destIP: IPv6Address): boolean {
    const destHextets = destIP.getHextets();
    const low24 = ((destHextets[6] & 0xff) << 16) | destHextets[7];

    for (const [, port] of this.ctx.getPorts()) {
      for (const entry of port.getIPv6Addresses()) {
        const addrHextets = entry.address.getHextets();
        const addrLow24 = ((addrHextets[6] & 0xff) << 16) | addrHextets[7];
        if (low24 === addrLow24) return true;
      }
    }
    return false;
  }

  private handleLocalDelivery(inPort: string, ipv6: IPv6Packet): void {
    if (ipv6.nextHeader === IP_PROTO_ICMPV6) {
      this.handleICMPv6(inPort, ipv6);
    }
  }

  private handleICMPv6(inPort: string, ipv6: IPv6Packet): void {
    const icmpv6 = ipv6.payload as ICMPv6Packet;
    if (!icmpv6 || icmpv6.type !== 'icmpv6') return;

    switch (icmpv6.icmpType) {
      case 'echo-request':
        this.handleEchoRequest(inPort, ipv6, icmpv6);
        break;
      case 'neighbor-solicitation':
        this.handleNeighborSolicitation(inPort, ipv6, icmpv6);
        break;
      case 'neighbor-advertisement':
        this.handleNeighborAdvertisement(inPort, ipv6, icmpv6);
        break;
      case 'router-solicitation':
        this.handleRouterSolicitation(inPort, ipv6, icmpv6);
        break;
    }
  }

  private handleEchoRequest(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;

    let srcIP: IPv6Address | null = null;
    if (ipv6.destinationIP.isLinkLocal()) {
      srcIP = port.getLinkLocalIPv6();
    } else {
      srcIP = port.getGlobalIPv6() || port.getLinkLocalIPv6();
    }
    if (!srcIP) return;

    const reply = createICMPv6EchoReply(icmpv6.id || 0, icmpv6.sequence || 0, icmpv6.dataSize || 56);
    const replyPkt = createIPv6Packet(
      srcIP,
      ipv6.sourceIP,
      IP_PROTO_ICMPV6,
      this.defaultHopLimit,
      reply,
      8 + (icmpv6.dataSize || 56),
    );

    const cached = this.neighborCache.get(ipv6.sourceIP.toString());
    if (cached) {
      this.ctx.sendFrame(inPort, {
        srcMAC: port.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6,
        payload: replyPkt,
      });
    }
  }

  // ─── NDP ──────────────────────────────────────────────────────

  private handleNeighborSolicitation(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const ns = icmpv6.ndp as NDPNeighborSolicitation;
    if (!ns || ns.ndpType !== 'neighbor-solicitation') return;

    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;

    if (!port.hasIPv6Address(ns.targetAddress)) return;

    const srcLLOpt = ns.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer' && !ipv6.sourceIP.isUnspecified()) {
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: inPort,
        state: 'stale',
        isRouter: false,
        timestamp: Date.now(),
      });
    }

    const na = createNeighborAdvertisement(ns.targetAddress, port.getMAC(), {
      router: true,
      solicited: true,
      override: true,
    });

    let dstIP: IPv6Address;
    let dstMAC: MACAddress;

    if (ipv6.sourceIP.isUnspecified()) {
      dstIP = IPV6_ALL_NODES_MULTICAST;
      dstMAC = dstIP.toMulticastMAC();
    } else {
      dstIP = ipv6.sourceIP;
      const cached = this.neighborCache.get(ipv6.sourceIP.toString());
      dstMAC = cached?.mac || (srcLLOpt as { address: MACAddress })?.address;
      if (!dstMAC) return;
    }

    const naPkt = createIPv6Packet(ns.targetAddress, dstIP, IP_PROTO_ICMPV6, 255, na, 32);

    this.ctx.sendFrame(inPort, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: naPkt,
    });
  }

  private handleNeighborAdvertisement(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const na = icmpv6.ndp as NDPNeighborAdvertisement;
    if (!na || na.ndpType !== 'neighbor-advertisement') return;

    const tgtLLOpt = na.options.find(o => o.optionType === 'target-link-layer');
    if (!tgtLLOpt || tgtLLOpt.optionType !== 'target-link-layer') return;

    const mac = tgtLLOpt.address;
    const key = na.targetAddress.toString();

    this.neighborCache.set(key, {
      mac,
      iface: inPort,
      state: na.solicitedFlag ? 'reachable' : 'stale',
      isRouter: na.routerFlag,
      timestamp: Date.now(),
    });

    const pending = this.pendingNDPs.get(key);
    if (pending) {
      for (const p of pending) {
        clearTimeout(p.timer);
        p.resolve(mac);
      }
      this.pendingNDPs.delete(key);
    }

    this.flushPacketQueue(na.targetAddress, mac);
  }

  private handleRouterSolicitation(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    if (!this.enabled) return;

    const rs = icmpv6.ndp as NDPRouterSolicitation;
    if (!rs || rs.ndpType !== 'router-solicitation') return;

    const port = this.ctx.getPorts().get(inPort);
    if (!port || !port.isIPv6Enabled()) return;

    const srcLLOpt = rs.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer' && !ipv6.sourceIP.isUnspecified()) {
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: inPort,
        state: 'stale',
        isRouter: false,
        timestamp: Date.now(),
      });
    }

    this.sendRouterAdvertisement(inPort, ipv6.sourceIP.isUnspecified() ? null : ipv6.sourceIP);
  }

  // ─── Router Advertisements ────────────────────────────────────

  configureRA(ifName: string, config: Partial<RAConfig>): void {
    const existing = this.raConfig.get(ifName) || {
      enabled: true,
      interval: 200000,
      curHopLimit: 64,
      managedFlag: false,
      otherConfigFlag: false,
      routerLifetime: 1800,
      prefixes: [],
    };

    const newConfig = { ...existing, ...config };
    this.raConfig.set(ifName, newConfig);

    const existingTimer = this.raTimers.get(ifName);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.raTimers.delete(ifName);
    }

    if (newConfig.enabled && this.enabled) {
      const timer = setInterval(() => {
        this.sendRouterAdvertisement(ifName, null);
      }, newConfig.interval);
      this.raTimers.set(ifName, timer);
    }
  }

  addRAPrefix(ifName: string, prefix: IPv6Address, prefixLength: number, options?: {
    onLink?: boolean;
    autonomous?: boolean;
    validLifetime?: number;
    preferredLifetime?: number;
  }): void {
    const config = this.raConfig.get(ifName);
    if (!config) {
      this.configureRA(ifName, {
        prefixes: [{
          prefix: prefix.getNetworkPrefix(prefixLength),
          prefixLength,
          onLink: options?.onLink ?? true,
          autonomous: options?.autonomous ?? true,
          validLifetime: options?.validLifetime ?? 2592000,
          preferredLifetime: options?.preferredLifetime ?? 604800,
        }],
      });
    } else {
      config.prefixes.push({
        prefix: prefix.getNetworkPrefix(prefixLength),
        prefixLength,
        onLink: options?.onLink ?? true,
        autonomous: options?.autonomous ?? true,
        validLifetime: options?.validLifetime ?? 2592000,
        preferredLifetime: options?.preferredLifetime ?? 604800,
      });
    }
  }

  private sendRouterAdvertisement(ifName: string, destIP: IPv6Address | null): void {
    const port = this.ctx.getPorts().get(ifName);
    if (!port || !port.isIPv6Enabled()) return;

    const config = this.raConfig.get(ifName);
    const srcIP = port.getLinkLocalIPv6();
    if (!srcIP) return;

    const prefixes = config?.prefixes || [];

    if (prefixes.length === 0) {
      for (const entry of port.getIPv6Addresses()) {
        if (entry.origin !== 'link-local' && entry.address.isGlobalUnicast()) {
          prefixes.push({
            prefix: entry.address.getNetworkPrefix(entry.prefixLength),
            prefixLength: entry.prefixLength,
            onLink: true,
            autonomous: true,
            validLifetime: 2592000,
            preferredLifetime: 604800,
          });
        }
      }
    }

    const ra = createRouterAdvertisement(prefixes, port.getMAC(), {
      curHopLimit: config?.curHopLimit ?? 64,
      managed: config?.managedFlag ?? false,
      other: config?.otherConfigFlag ?? false,
      routerLifetime: config?.routerLifetime ?? 1800,
    });

    const dstIP = destIP || IPV6_ALL_NODES_MULTICAST;
    const dstMAC = destIP
      ? this.neighborCache.get(destIP.toString())?.mac || dstIP.toSolicitedNodeMulticast().toMulticastMAC()
      : IPV6_ALL_NODES_MULTICAST.toMulticastMAC();

    const raPkt = createIPv6Packet(srcIP, dstIP, IP_PROTO_ICMPV6, 255, ra, 64);

    this.ctx.sendFrame(ifName, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: raPkt,
    });

    Logger.debug(this.ctx.id, 'router:ra-sent',
      `${this.ctx.name}: RA sent on ${ifName} with ${prefixes.length} prefixes`);
  }

  // ─── Forwarding ───────────────────────────────────────────────

  private forwardPacket(inPort: string, ipv6: IPv6Packet): void {
    const newHopLimit = ipv6.hopLimit - 1;
    if (newHopLimit <= 0) {
      Logger.info(this.ctx.id, 'router:hop-limit-expired',
        `${this.ctx.name}: Hop limit expired for ${ipv6.sourceIP} → ${ipv6.destinationIP}`);
      this.sendICMPv6Error(inPort, ipv6, 'time-exceeded', 0);
      return;
    }

    const route = this.lookupRoute(ipv6.destinationIP);
    if (!route) {
      Logger.info(this.ctx.id, 'router:no-ipv6-route',
        `${this.ctx.name}: no route for ${ipv6.destinationIP}`);
      this.sendICMPv6Error(inPort, ipv6, 'destination-unreachable', 0);
      return;
    }

    const fwdPkt: IPv6Packet = {
      ...ipv6,
      hopLimit: newHopLimit,
    };

    const nextHopIP = route.nextHop || ipv6.destinationIP;
    const outPort = this.ctx.getPorts().get(route.iface);
    if (!outPort) return;

    const cached = this.neighborCache.get(nextHopIP.toString());
    if (cached) {
      this.ctx.getCounters().ipForwDatagrams++;
      this.ctx.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6,
        payload: fwdPkt,
      });
    } else {
      this.queueAndResolve(fwdPkt, route.iface, nextHopIP, outPort);
    }
  }

  private sendICMPv6Error(
    inPort: string,
    offendingPkt: IPv6Packet,
    errorType: 'time-exceeded' | 'destination-unreachable' | 'packet-too-big',
    code: number,
    mtu?: number,
  ): void {
    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;
    const srcIP = port.getLinkLocalIPv6() || port.getGlobalIPv6();
    if (!srcIP) return;

    const icmpError: ICMPv6Packet = {
      type: 'icmpv6',
      icmpType: errorType,
      code,
      mtu,
    };

    const errorPkt = createIPv6Packet(
      srcIP,
      offendingPkt.sourceIP,
      IP_PROTO_ICMPV6,
      this.defaultHopLimit,
      icmpError,
      48,
    );

    const cached = this.neighborCache.get(offendingPkt.sourceIP.toString());
    if (cached) {
      this.ctx.sendFrame(inPort, {
        srcMAC: port.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6,
        payload: errorPkt,
      });
    }
  }

  // ─── NDP Resolution + Packet Queue ────────────────────────────

  private queueAndResolve(pkt: IPv6Packet, iface: string, nextHopIP: IPv6Address, port: Port): void {
    const timer = setTimeout(() => {
      this.packetQueue = this.packetQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
    }, 2000);

    this.packetQueue.push({ frame: pkt, outIface: iface, nextHopIP, timer });

    const key = nextHopIP.toString();
    if (!this.pendingNDPs.has(key)) {
      this.pendingNDPs.set(key, []);

      const srcIP = port.getLinkLocalIPv6();
      if (!srcIP) return;

      const ns = createNeighborSolicitation(nextHopIP, port.getMAC());
      const nsPkt = createIPv6Packet(
        srcIP,
        nextHopIP.toSolicitedNodeMulticast(),
        IP_PROTO_ICMPV6,
        255,
        ns,
        24,
      );

      this.ctx.sendFrame(iface, {
        srcMAC: port.getMAC(),
        dstMAC: nextHopIP.toSolicitedNodeMulticast().toMulticastMAC(),
        etherType: ETHERTYPE_IPV6,
        payload: nsPkt,
      });
    }
  }

  private flushPacketQueue(resolvedIP: IPv6Address, resolvedMAC: MACAddress): void {
    const ready = this.packetQueue.filter(q => q.nextHopIP.equals(resolvedIP));
    this.packetQueue = this.packetQueue.filter(q => !q.nextHopIP.equals(resolvedIP));

    for (const q of ready) {
      clearTimeout(q.timer);
      const outPort = this.ctx.getPorts().get(q.outIface);
      if (outPort) {
        this.ctx.getCounters().ipForwDatagrams++;
        this.ctx.sendFrame(q.outIface, {
          srcMAC: outPort.getMAC(),
          dstMAC: resolvedMAC,
          etherType: ETHERTYPE_IPV6,
          payload: q.frame,
        });
      }
    }
  }
}
