/**
 * IPv6DataPlane - IPv6 Forwarding Engine (RFC 8200, RFC 4861)
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Handles IPv6 packet processing, NDP, Router Advertisements,
 * and IPv6 forwarding.
 */

import type { Port } from '../../hardware/Port';
import type { RouterCounters } from '../Router';
import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import { stampUdpChecksum } from '../../layers/transport/UdpChecksum';
import { selectIpv6SourceAddress } from '../../layers/internet/Ipv6Egress';
import {
  IPv6Address, IPv6Packet, ICMPv6Packet, MACAddress, UDPPacket,
  NDPNeighborSolicitation, NDPNeighborAdvertisement, NDPRouterSolicitation,
  EthernetFrame,
  ETHERTYPE_IPV6, IP_PROTO_ICMPV6, IP_PROTO_UDP, IP_PROTO_OSPF, IP_PROTO_TCP,
  createIPv6Packet, createNeighborSolicitation, createNeighborAdvertisement, createRouterAdvertisement,
  createICMPv6EchoReply, createICMPv6EchoRequest,
  IPV6_ALL_NODES_MULTICAST,
} from '../../core/types';
import { Logger } from '../../core/Logger';
import { NeighborCache, type NeighborCacheEntry } from '../host/NeighborCache';
import { DHCPv6Server } from '../../dhcpv6/DHCPv6Server';
import { DHCPv6Packet } from '../../dhcpv6/DHCPv6Packet';

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

export type { NeighborState, NeighborCacheEntry } from '../host/NeighborCache';

interface QueuedIPv6Packet {
  frame: IPv6Packet;
  outIface: string;
  nextHopIP: IPv6Address;
  timer: symbol;
}

export interface RAConfig {
  /**
   * `ipv6 nd ra suppress`: unsolicited advertisements go quiet. The
   * router still answers a solicitation — `suppress all` stops that too.
   */
  enabled: boolean;
  /** `ipv6 nd ra suppress all`: nothing at all, answers included. */
  suppressAll?: boolean;
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
  /** Reactive bus accessor (Phase 5.10 — NDP learn emissions). */
  getBus(): IEventBus;
  /** Scheduler accessor (Phase 5.10 — RA intervals run through TimerSet). */
  getScheduler(): IScheduler;
  /** DHCPv6 (RFC 8415) server engine, shared with the router's CLI layer. */
  getDhcpv6Server(): DHCPv6Server;
  deliverTcp6?(inPort: string, ipv6: IPv6Packet): void;
  /** `ipv6 dhcp server <pool>` binding for a directly-attached interface. */
  getDhcpv6ServerPool(iface: string): string | undefined;
  /** `ipv6 dhcp relay destination <addr>` targets for a relaying interface. */
  getDhcpv6RelayDestinations(iface: string): string[];
  /**
   * OSPFv3 runs directly over IPv6 (next header 89, RFC 5340 §2). Narrow
   * port into the OSPF integration, absent on a router that has none.
   */
  deliverOspfv3?(inPort: string, srcIP: string, packet: unknown, ipsecProtected: boolean): void;
  /**
   * An Echo Reply, or an ICMPv6 error ending a probe, addressed to this
   * router. The data plane owns the receive path; who is waiting for the
   * answer is the router's business, so it settles its own awaiters.
   */
  onIcmpv6EchoReply?(payload: {
    fromIp: string; toIp: string; id: number; seq: number; hopLimit: number;
  }): void;
  onIcmpv6EchoFailed?(payload: { fromIp: string; reason: string }): void;
  /**
   * `ipv6 traffic-filter <name> in|out` on this interface. Absent on a
   * platform with no IPv6 access lists; `true` means the packet passes.
   */
  ipv6FilterPermits?(
    iface: string, direction: 'in' | 'out', pkt: IPv6Packet, ingress?: string,
  ): boolean;
}

/**
 * What an IPv6 data plane can HONESTLY count.
 *
 * Every field here is incremented at a real point of this file; the
 * fields IOS also prints but this simulator cannot observe (checksum
 * errors — nothing verifies an ICMPv6 checksum; fragments and reassembly
 * — IPv6 fragmentation is not modelled; routing-header source routing —
 * not modelled) are deliberately ABSENT rather than rendered as a zero
 * nothing backs. Where a zero IS the true count it stays: `hopLimit`
 * really does count expiries, and reads zero because none happened.
 */
export interface Ipv6Counters {
  inReceives: number;
  inDelivers: number;
  inNoRoutes: number;
  inHopLimitExceeded: number;
  inFiltered: number;
  outFiltered: number;
  outForwarded: number;
  outRequests: number;
  icmpInEchoRequests: number;
  icmpInEchoReplies: number;
  icmpOutEchoReplies: number;
  icmpOutErrors: number;
  ndInSolicits: number;
  ndInAdverts: number;
  ndOutSolicits: number;
  ndOutAdverts: number;
  ndInRouterSolicits: number;
  ndOutRouterAdverts: number;
}

export function emptyIpv6Counters(): Ipv6Counters {
  return {
    inReceives: 0, inDelivers: 0, inNoRoutes: 0, inHopLimitExceeded: 0,
    inFiltered: 0, outFiltered: 0,
    outForwarded: 0, outRequests: 0,
    icmpInEchoRequests: 0, icmpInEchoReplies: 0, icmpOutEchoReplies: 0,
    icmpOutErrors: 0,
    ndInSolicits: 0, ndInAdverts: 0, ndOutSolicits: 0, ndOutAdverts: 0,
    ndInRouterSolicits: 0, ndOutRouterAdverts: 0,
  };
}

/** Where a locally-originated IPv6 packet leaves, once resolved. */
export interface IPv6PathResolution {
  iface: string;
  port: Port;
  nextHopIP: IPv6Address;
}

export interface IPv6EgressResolution {
  iface: string;
  port: Port;
  sourceIP: IPv6Address;
  nextHopMAC: MACAddress;
}

// ─── IPv6 Data Plane ────────────────────────────────────────────

export class IPv6DataPlane {
  private routingTable: IPv6RouteEntry[] = [];
  private readonly neighborCache = new NeighborCache(() => this.ctx.getScheduler(), {
    onLearned: (ip, entry) => this.emitNdpLearned({
      ip, mac: entry.mac.toString(), iface: entry.iface,
    }),
    sendUnicastSolicit: (ip, entry) => this.sendUnicastNeighborSolicit(ip, entry),
  });
  /** Dedup signal for in-flight NDP solicitations (Phase 5.9, replaces
   *  the pendingNDPs Map which only carried the same dedup semantics). */
  private inFlightNDPs: Set<string> = new Set();
  private packetQueue: QueuedIPv6Packet[] = [];
  private readonly defaultHopLimit = 64;
  private enabled = false;
  private raConfig: Map<string, RAConfig> = new Map();
  /** Per-interface RA interval timers — scheduler tokens (Phase 5.10). */
  private raTimers: Map<string, symbol> = new Map();
  /** TimerSet bound to the injected scheduler. */
  private readonly timers = new TimerSet(() => this.ctx.getScheduler());
  private readonly v6Counters: Ipv6Counters = emptyIpv6Counters();

  constructor(private readonly ctx: IPv6RouterContext) {}

  /** Bus emission helper for NDP entry learned (Phase 5.10). */
  private emitNdpLearned(payload: { ip: string; mac: string; iface: string }): void {
    this.ctx.getBus().publish({
      topic: 'host.ndp.entry-learned',
      payload: { deviceId: this.ctx.id, hostname: this.ctx.name, ...payload },
    });
  }

  // ─── IPv6 Routing State ─────────────────────────────────────────

  enableRouting(): void { this.enabled = true; }
  disableRouting(): void { this.enabled = false; }
  isRoutingEnabled(): boolean { return this.enabled; }

  getRoutingTable(): IPv6RouteEntry[] { return [...this.routingTable]; }
  getRoutingTableInternal(): IPv6RouteEntry[] { return this.routingTable; }
  setRoutingTable(table: IPv6RouteEntry[]): void { this.routingTable = table; }

  getNeighborCache(): Map<string, NeighborCacheEntry> {
    return this.neighborCache.snapshot();
  }
  getNeighborCacheInternal(): Map<string, NeighborCacheEntry> { return this.neighborCache.internalMap(); }

  getIpv6Counters(): Ipv6Counters { return { ...this.v6Counters }; }
  clearIpv6Counters(): void { Object.assign(this.v6Counters, emptyIpv6Counters()); }

  /** The clock the neighbour cache stamps its entries with. */
  neighborCacheNow(): number { return this.neighborCache.nowMs(); }

  /** Drop every learned neighbour, timers included. */
  clearNeighborCache(): void { this.neighborCache.clear(); }

  configureInterface(portName: string, address: IPv6Address, prefixLength: number): boolean {
    const port = this.ctx.getPorts().get(portName);
    if (!port) return false;

    port.configureIPv6(address, prefixLength);

    // Remove old connected route for this interface/prefix (handles reconfiguration)
    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === portName && r.prefixLength === prefixLength)
    );

    // Add connected route
    const networkPrefix = address.getNetworkPrefix(prefixLength);
    this.routingTable.push({
      prefix: networkPrefix,
      prefixLength,
      nextHop: null,
      iface: portName,
      type: 'connected',
      ad: 0,
      metric: 0,
    });

    Logger.info(this.ctx.id, 'router:ipv6-interface-config',
      `${this.ctx.name}: ${portName} configured ${address}/${prefixLength}`);
    this.advertiseOnInterface(portName);
    return true;
  }

/**
   * The unsolicited advertisement a router emits when an interface
   * starts carrying a prefix (RFC 4861 §6.2.4). It serves the host that
   * was already there; one arriving later solicits for itself.
   *
   * The periodic timer stays armed by `configureRA` alone: advertising
   * every 200 s would add nothing to a lab and would run a timer on
   * every interface of every router.
   */
  advertiseOnInterface(portName: string): void {
    if (!this.enabled) return;
    const ra = this.raConfig.get(portName);
    if (ra && (ra.enabled === false || ra.suppressAll)) return;
    const port = this.ctx.getPorts().get(portName);
    if (!port || !port.isIPv6Enabled() || !port.getIsUp()) return;
    const aUnPrefixe = port.getIPv6Addresses()
      .some((e) => e.origin !== 'link-local' && e.address.isGlobalUnicast());
    if (!aUnPrefixe) return;
    this.sendRouterAdvertisement(portName, null);
  }

  addStaticRoute(prefix: IPv6Address, prefixLength: number, nextHop: IPv6Address, iface: string, metric: number = 0): void {
    this.routingTable.push({
      prefix,
      prefixLength,
      nextHop,
      iface,
      type: 'static',
      ad: 1,
      metric,
    });
  }

  setDefaultRoute(nextHop: IPv6Address, iface: string, metric: number = 0): void {
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
    this.routingTable.push({
      prefix: new IPv6Address('::'),
      prefixLength: 0,
      nextHop,
      iface,
      type: 'default',
      ad: 1,
      metric,
    });
  }

  lookupRoute(destIP: IPv6Address): IPv6RouteEntry | null {
    let bestRoute: IPv6RouteEntry | null = null;
    let bestPrefixLen = -1;
    let bestAD = Infinity;

    for (const route of this.routingTable) {
      if (!destIP.isInSameSubnet(route.prefix, route.prefixLength)) continue;

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

  processPacket(inPort: string, ipv6: IPv6Packet, srcMAC?: MACAddress): void {
    if (!ipv6 || ipv6.type !== 'ipv6') return;

    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;
    this.v6Counters.inReceives++;

    // An inbound filter is applied to EVERYTHING arriving on the
    // interface, transit and self-destined alike — that is what makes it
    // a way to protect the router itself.
    if (this.ctx.ipv6FilterPermits?.(inPort, 'in', ipv6) === false) {
      this.v6Counters.inFiltered++;
      Logger.info(this.ctx.id, 'router:ipv6-acl-deny-in',
        `${this.ctx.name}: IPv6 ACL denied inbound on ${inPort}: `
        + `${ipv6.sourceIP} -> ${ipv6.destinationIP}`);
      return;
    }

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
    const isAllDhcpMulticast = destIP.isAllDhcpRelayAgentsAndServersMulticast();
    const isSolicitedNode = destIP.isSolicitedNodeMulticast();
    // ff02::5 / ff02::6 (RFC 5340 §A.1): a router speaking OSPFv3 is a
    // member of these groups, and they are never forwarded.
    const isOspfv3Group = destIP.isAllSpfRoutersMulticast() || destIP.isAllDRoutersMulticast();

    if (isForUs || isAllNodesMulticast || isAllRoutersMulticast || isAllDhcpMulticast
      || isOspfv3Group) {
      this.handleLocalDelivery(inPort, ipv6, srcMAC);
      return;
    }

    if (isSolicitedNode) {
      if (this.shouldAcceptSolicitedNode(destIP)) {
        this.handleLocalDelivery(inPort, ipv6, srcMAC);
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

  private handleLocalDelivery(inPort: string, ipv6: IPv6Packet, srcMAC?: MACAddress): void {
    this.v6Counters.inDelivers++;
    if (ipv6.nextHeader === IP_PROTO_OSPF) {
      const pkt = ipv6.payload as { type?: string; version?: number } | undefined;
      if (pkt?.type === 'ospf' && pkt.version === 3) {
        this.ctx.deliverOspfv3?.(
          inPort, ipv6.sourceIP.toString(), ipv6.payload, !!ipv6.ipsecProtected,
        );
      }
      return;
    }

    if (ipv6.nextHeader === IP_PROTO_TCP) {
      this.ctx.deliverTcp6?.(inPort, ipv6);
      return;
    }

    if (ipv6.nextHeader === IP_PROTO_ICMPV6) {
      this.handleICMPv6(inPort, ipv6);
    } else if (ipv6.nextHeader === IP_PROTO_UDP) {
      const udp = ipv6.payload as UDPPacket | undefined;
      if (udp?.type === 'udp' && udp.destinationPort === 547) {
        this.handleDhcpv6Udp(inPort, ipv6, udp, srcMAC);
      }
    }
  }

  // ─── DHCPv6 (RFC 8415) ────────────────────────────────────────

  private handleDhcpv6Udp(inPort: string, ipv6: IPv6Packet, udp: UDPPacket, srcMAC?: MACAddress): void {
    const pkt = udp.payload;
    if (!(pkt instanceof DHCPv6Packet)) return;

    if (pkt.msgType === 'RELAY-FORW') {
      this.handleDhcpv6RelayForw(inPort, pkt);
      return;
    }
    if (pkt.msgType === 'RELAY-REPL') {
      this.handleDhcpv6RelayRepl(pkt);
      return;
    }

    const relayDests = this.ctx.getDhcpv6RelayDestinations(inPort);
    if (relayDests.length > 0) {
      // The final RELAY-REPL leg needs to reach the client back on this
      // same link; observing its real MAC now (instead of a separate NDP
      // round-trip for a link we're already on) is what lets that unwind.
      if (srcMAC) this.neighborCache.learnFromSource(ipv6.sourceIP.toString(), srcMAC, inPort, false);
      this.relayDhcpv6ToDestinations(inPort, ipv6, pkt, relayDests);
      return;
    }

    const poolName = this.ctx.getDhcpv6ServerPool(inPort);
    if (!poolName) return;
    this.serveDhcpv6(inPort, ipv6.sourceIP, pkt, poolName, srcMAC);
  }

  /** Directly-attached client (or a relayed exchange re-entering after RELAY-FORW unwrap): run the pool through the server engine and reply. */
  private serveDhcpv6(
    inPort: string, clientAddr: IPv6Address, pkt: DHCPv6Packet, poolName: string, dstMAC?: MACAddress,
  ): void {
    const server = this.ctx.getDhcpv6Server();
    const iaid = pkt.ia?.iaid ?? 0;
    let replyType: 'ADVERTISE' | 'REPLY';
    let result;
    if (pkt.msgType === 'SOLICIT') {
      result = server.processSolicit({ clientDuid: pkt.clientDuid!, iaid, transactionId: pkt.transactionId }, poolName);
      replyType = 'ADVERTISE';
    } else if (pkt.msgType === 'REQUEST' || pkt.msgType === 'RENEW' || pkt.msgType === 'REBIND') {
      result = server.processRequest({
        clientDuid: pkt.clientDuid!, iaid, transactionId: pkt.transactionId,
        requestedAddress: pkt.ia?.addresses[0]?.address ?? '', serverDuid: pkt.serverDuid ?? server.getServerDuid(),
      }, poolName);
      replyType = 'REPLY';
    } else if (pkt.msgType === 'RELEASE') {
      server.processRelease({ clientDuid: pkt.clientDuid!, iaid, address: pkt.ia?.addresses[0]?.address ?? '' });
      return;
    } else if (pkt.msgType === 'INFORMATION-REQUEST') {
      // Stateless service (RFC 8415 §18.3.5): the reply carries only
      // the other configuration; nothing is assigned or retained.
      const info = server.processInformationRequest(
        { transactionId: pkt.transactionId }, poolName, clientAddr.toString());
      if (!info) return;
      this.sendDhcpv6Reply(inPort, clientAddr, DHCPv6Packet.createInformationReply(
        pkt.clientDuid!, server.getServerDuid(), pkt.transactionId,
        info.pool.dnsServers, info.pool.domainName,
      ), dstMAC);
      return;
    } else {
      return;
    }
    if (!result) return;

    const reply = replyType === 'ADVERTISE'
      ? DHCPv6Packet.createAdvertise(pkt.clientDuid!, server.getServerDuid(), pkt.transactionId, iaid, result.address, result.pool.preferredLifetime, result.pool.validLifetime, result.pool.dnsServers, result.pool.domainName)
      : DHCPv6Packet.createReply(pkt.clientDuid!, server.getServerDuid(), pkt.transactionId, iaid, result.address, result.pool.preferredLifetime, result.pool.validLifetime, result.pool.dnsServers, result.pool.domainName);

    this.sendDhcpv6Reply(inPort, clientAddr, reply, dstMAC);
  }

  private sendDhcpv6Reply(inPort: string, dstIp: IPv6Address, reply: DHCPv6Packet, dstMAC?: MACAddress): void {
    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;
    const srcIp = port.getLinkLocalIPv6() ?? port.getGlobalIPv6();
    if (!srcIp) return;
    const mac = dstMAC ?? this.neighborCache.get(dstIp.toString())?.mac;
    if (!mac) return;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 547, destinationPort: 546, length: 8 + 300, checksum: 0, payload: reply,
    };
    const ipPkt = createIPv6Packet(srcIp, dstIp, IP_PROTO_UDP, this.defaultHopLimit,
      stampUdpChecksum(udp, srcIp.toString(), dstIp.toString()), 8 + 300);
    this.ctx.sendFrame(inPort, { srcMAC: port.getMAC(), dstMAC: mac, etherType: ETHERTYPE_IPV6, payload: ipPkt });
  }

  /** `ipv6 dhcp relay destination <addr>`: wrap the client's message in RELAY-FORW toward each configured server. */
  private relayDhcpv6ToDestinations(inPort: string, ipv6: IPv6Packet, pkt: DHCPv6Packet, destinations: string[]): void {
    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;
    const linkAddr = port.getGlobalIPv6() ?? port.getLinkLocalIPv6();
    if (!linkAddr) return;
    const relayForw = DHCPv6Packet.createRelayForw(linkAddr.toString(), ipv6.sourceIP.toString(), pkt.hopCount + 1, inPort, pkt);

    for (const dest of destinations) {
      const dstIp = new IPv6Address(dest);
      const route = this.lookupRoute(dstIp);
      if (!route) continue;
      const egressPort = this.ctx.getPorts().get(route.iface);
      const egressSrcIp = egressPort?.getGlobalIPv6() ?? egressPort?.getLinkLocalIPv6();
      if (!egressPort || !egressSrcIp) continue;
      const nextHopMac = this.resolveNeighborSync(route.iface, route.nextHop ?? dstIp);
      if (!nextHopMac) continue;
      const udp: UDPPacket = {
        type: 'udp', sourcePort: 547, destinationPort: 547, length: 8 + 300, checksum: 0, payload: relayForw,
      };
      const relayedPkt = createIPv6Packet(egressSrcIp, dstIp, IP_PROTO_UDP, this.defaultHopLimit,
        stampUdpChecksum(udp, egressSrcIp.toString(), dstIp.toString()), 8 + 300);
      this.ctx.sendFrame(route.iface, {
        srcMAC: egressPort.getMAC(), dstMAC: nextHopMac, etherType: ETHERTYPE_IPV6, payload: relayedPkt,
      });
    }
  }

  /** A relay agent's RELAY-FORW reached us: unwrap and serve the inner message from the relay's own link-address subnet. */
  private handleDhcpv6RelayForw(inPort: string, pkt: DHCPv6Packet): void {
    const inner = pkt.relayedMessage;
    if (!inner) return;
    if (inner.msgType === 'RELAY-FORW') { this.handleDhcpv6RelayForw(inPort, inner); return; }
    const server = this.ctx.getDhcpv6Server();
    const iaid = inner.ia?.iaid ?? 0;
    let replyType: 'ADVERTISE' | 'REPLY';
    let result;
    if (inner.msgType === 'SOLICIT') {
      result = server.processSolicit({ clientDuid: inner.clientDuid!, iaid, transactionId: inner.transactionId, linkAddress: pkt.linkAddress });
      replyType = 'ADVERTISE';
    } else if (inner.msgType === 'REQUEST' || inner.msgType === 'RENEW' || inner.msgType === 'REBIND') {
      result = server.processRequest({
        clientDuid: inner.clientDuid!, iaid, transactionId: inner.transactionId, linkAddress: pkt.linkAddress,
        requestedAddress: inner.ia?.addresses[0]?.address ?? '', serverDuid: inner.serverDuid ?? server.getServerDuid(),
      });
      replyType = 'REPLY';
    } else if (inner.msgType === 'RELEASE') {
      server.processRelease({ clientDuid: inner.clientDuid!, iaid, address: inner.ia?.addresses[0]?.address ?? '' });
      return;
    } else {
      return;
    }
    if (!result) return;

    const innerReply = replyType === 'ADVERTISE'
      ? DHCPv6Packet.createAdvertise(inner.clientDuid!, server.getServerDuid(), inner.transactionId, iaid, result.address, result.pool.preferredLifetime, result.pool.validLifetime, result.pool.dnsServers, result.pool.domainName)
      : DHCPv6Packet.createReply(inner.clientDuid!, server.getServerDuid(), inner.transactionId, iaid, result.address, result.pool.preferredLifetime, result.pool.validLifetime, result.pool.dnsServers, result.pool.domainName);

    const relayRepl = DHCPv6Packet.createRelayRepl(pkt.linkAddress, pkt.peerAddress, pkt.interfaceId, innerReply);
    const dstIp = new IPv6Address(pkt.linkAddress);
    const route = this.lookupRoute(dstIp);
    if (!route) return;
    const egressPort = this.ctx.getPorts().get(route.iface);
    const egressSrcIp = egressPort?.getGlobalIPv6() ?? egressPort?.getLinkLocalIPv6();
    if (!egressPort || !egressSrcIp) return;
    const nextHopMac = this.resolveNeighborSync(route.iface, route.nextHop ?? dstIp);
    if (!nextHopMac) return;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 547, destinationPort: 547, length: 8 + 300, checksum: 0, payload: relayRepl,
    };
    const replyPkt = createIPv6Packet(egressSrcIp, dstIp, IP_PROTO_UDP, this.defaultHopLimit,
      stampUdpChecksum(udp, egressSrcIp.toString(), dstIp.toString()), 8 + 300);
    this.ctx.sendFrame(route.iface, {
      srcMAC: egressPort.getMAC(), dstMAC: nextHopMac, etherType: ETHERTYPE_IPV6, payload: replyPkt,
    });
  }

  /** RELAY-REPL arrived back at the originating relay agent: unwrap and forward the inner reply onto the client's own link. */
  private handleDhcpv6RelayRepl(pkt: DHCPv6Packet): void {
    const inner = pkt.relayedMessage;
    if (!inner || !pkt.interfaceId) return;
    if (inner.msgType === 'RELAY-REPL') { this.handleDhcpv6RelayRepl(inner); return; }
    const clientAddr = new IPv6Address(pkt.peerAddress);
    this.sendDhcpv6Reply(pkt.interfaceId, clientAddr, inner);
  }

  /** Synchronous NDP resolution for a next-hop the relay hasn't seen yet — same cable-is-synchronous assumption as SwitchSvi.resolveArp. */
  private resolveNeighborSync(iface: string, dstIp: IPv6Address): MACAddress | null {
    const cached = this.neighborCache.get(dstIp.toString());
    if (cached) return cached.mac;
    const port = this.ctx.getPorts().get(iface);
    const srcIp = port?.getLinkLocalIPv6();
    if (!port || !srcIp) return null;
    const solicitedNode = dstIp.toSolicitedNodeMulticast();
    this.v6Counters.ndOutSolicits++;
    this.v6Counters.outRequests++;
    const ns = createNeighborSolicitation(dstIp, port.getMAC());
    const nsPkt = createIPv6Packet(srcIp, solicitedNode, IP_PROTO_ICMPV6, 255, ns, 32);
    this.ctx.sendFrame(iface, {
      srcMAC: port.getMAC(), dstMAC: solicitedNode.toMulticastMAC(), etherType: ETHERTYPE_IPV6, payload: nsPkt,
    });
    return this.neighborCache.get(dstIp.toString())?.mac ?? null;
  }

  /**
   * Where a packet this router originates itself would leave, and with
   * which source address and next-hop MAC. Returns null when no route
   * covers the destination, when the egress link is down, or when the
   * next hop cannot be resolved — the three distinct reasons a probe
   * never reaches the wire.
   */
  resolvePath(destIP: IPv6Address): IPv6PathResolution | null {
    let iface: string | null = null;
    let nextHopIP = destIP;
    if (destIP.isLinkLocal() || destIP.isMulticast()) {
      for (const [name, p] of this.ctx.getPorts()) {
        if (p.isIPv6Enabled() && p.isOperationallyUp()) { iface = name; break; }
      }
    } else {
      const route = this.lookupRoute(destIP);
      if (!route) return null;
      iface = route.iface;
      if (route.nextHop) nextHopIP = route.nextHop;
    }
    if (!iface) return null;
    const port = this.ctx.getPorts().get(iface);
    if (!port || !port.isOperationallyUp()) return null;
    return { iface, port, nextHopIP };
  }

  resolveEgress(destIP: IPv6Address, sourceIPStr?: string): IPv6EgressResolution | null {
    const path = this.resolvePath(destIP);
    if (!path) return null;
    const { iface, port, nextHopIP } = path;

    let sourceIP: IPv6Address | null = sourceIPStr
      ? new IPv6Address(sourceIPStr)
      : selectIpv6SourceAddress(port, destIP);
    if (!sourceIP) return null;
    // A zone index is LOCAL metadata — it is not part of the 128 bits and
    // never goes on the wire. A receiver notes the interface it heard the
    // packet on and stamps its OWN zone.
    sourceIP = sourceIP.withScopeId(null);

    const nextHopMAC = this.resolveNeighborSync(iface, nextHopIP);
    if (!nextHopMAC) return null;
    return { iface, port, sourceIP, nextHopMAC };
  }

  /** Put one Echo Request on the wire; the caller awaits the reply. */
  sendEchoRequest(
    egress: IPv6EgressResolution, destIP: IPv6Address,
    id: number, seq: number, dataSize: number, hopLimit?: number,
  ): void {
    this.v6Counters.outRequests++;
    const echo = createICMPv6EchoRequest(id, seq, dataSize);
    const pkt = createIPv6Packet(
      egress.sourceIP, destIP, IP_PROTO_ICMPV6,
      hopLimit ?? this.defaultHopLimit, echo, 8 + dataSize,
    );
    this.ctx.sendFrame(egress.iface, {
      srcMAC: egress.port.getMAC(),
      dstMAC: egress.nextHopMAC,
      etherType: ETHERTYPE_IPV6,
      payload: pkt,
    });
  }

  private handleICMPv6(inPort: string, ipv6: IPv6Packet): void {
    const icmpv6 = ipv6.payload as ICMPv6Packet;
    if (!icmpv6 || icmpv6.type !== 'icmpv6') return;

    switch (icmpv6.icmpType) {
      case 'echo-request':
        this.v6Counters.icmpInEchoRequests++;
        this.handleEchoRequest(inPort, ipv6, icmpv6);
        break;
      case 'neighbor-solicitation':
        this.v6Counters.ndInSolicits++;
        this.handleNeighborSolicitation(inPort, ipv6, icmpv6);
        break;
      case 'neighbor-advertisement':
        this.v6Counters.ndInAdverts++;
        this.handleNeighborAdvertisement(inPort, ipv6, icmpv6);
        break;
      case 'router-solicitation':
        this.v6Counters.ndInRouterSolicits++;
        this.handleRouterSolicitation(inPort, ipv6, icmpv6);
        break;
      case 'echo-reply':
        this.v6Counters.icmpInEchoReplies++;
        this.handleEchoReply(ipv6, icmpv6);
        break;
      case 'destination-unreachable':
      case 'time-exceeded':
      case 'packet-too-big':
        this.handleIcmpv6Error(ipv6, icmpv6);
        break;
    }
  }

  private handleEchoReply(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    this.neighborCache.confirmReachability(ipv6.sourceIP.toString());
    this.ctx.onIcmpv6EchoReply?.({
      fromIp: ipv6.sourceIP.toString(),
      toIp: ipv6.destinationIP.toString(),
      id: icmpv6.id ?? 0,
      seq: icmpv6.sequence ?? 0,
      hopLimit: ipv6.hopLimit,
    });
  }

  private handleIcmpv6Error(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const reason = icmpv6.icmpType === 'time-exceeded'
      ? 'ttl-exceeded'
      : (icmpv6.icmpType === 'packet-too-big' ? 'frag-needed' : 'unreachable');
    this.ctx.onIcmpv6EchoFailed?.({ fromIp: ipv6.sourceIP.toString(), reason });
  }

  private handleEchoRequest(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const port = this.ctx.getPorts().get(inPort);
    if (!port) return;

    // RFC 4443 §4.2: the reply's source is the address the request was
    // addressed to, when that was a unicast address of ours.
    const srcIP = ipv6.destinationIP.isMulticast()
      ? (ipv6.sourceIP.isLinkLocal()
        ? port.getLinkLocalIPv6()
        : (port.getGlobalIPv6() || port.getLinkLocalIPv6()))
      : ipv6.destinationIP;
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

    // The reply is ROUTED, not handed to the neighbour whose address the
    // asker happens to carry. Soliciting the source address as if it
    // were on this link works only while the asker IS on this link:
    // measured, a router two hops away got no reply at all, because the
    // Neighbor Solicitation for its address went out on a segment that
    // does not hold it and nobody answered.
    const egress = this.resolveEgress(ipv6.sourceIP, srcIP.toString());
    if (!egress) return;
    this.v6Counters.icmpOutEchoReplies++;
    this.v6Counters.outRequests++;
    this.ctx.sendFrame(egress.iface, {
      srcMAC: egress.port.getMAC(),
      dstMAC: egress.nextHopMAC,
      etherType: ETHERTYPE_IPV6,
      payload: replyPkt,
    });
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
      this.neighborCache.learnFromSource(
        ipv6.sourceIP.toString(), srcLLOpt.address, inPort, false);
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

    this.v6Counters.ndOutAdverts++;
    this.v6Counters.outRequests++;
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

    this.neighborCache.learnFromAdvertisement(key, mac, inPort, {
      solicited: na.solicitedFlag,
      isRouter: na.routerFlag,
      override: na.overrideFlag,
    });

    this.inFlightNDPs.delete(key);
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
      this.neighborCache.learnFromSource(
        ipv6.sourceIP.toString(), srcLLOpt.address, inPort, false);
    }

    // `suppress all` stops the answer too; `suppress` alone only
    // silences the unsolicited advertisement.
    if (this.raConfig.get(inPort)?.suppressAll) return;

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
      this.timers.clear(existingTimer);
      this.raTimers.delete(ifName);
    }

    if (newConfig.enabled && this.enabled) {
      const token = this.timers.setInterval(() => {
        this.sendRouterAdvertisement(ifName, null);
      }, newConfig.interval);
      this.raTimers.set(ifName, token);
    }
  }

  /** An interface's advertisement config, created on demand. */
  private raConfigOf(ifName: string): RAConfig {
    const existing = this.raConfig.get(ifName);
    if (existing) return existing;
    const frais: RAConfig = {
      enabled: true, interval: 200000, curHopLimit: 64,
      managedFlag: false, otherConfigFlag: false,
      routerLifetime: 1800, prefixes: [],
    };
    this.raConfig.set(ifName, frais);
    return frais;
  }

  /**
   * Set an advertisement parameter WITHOUT arming the periodic timer.
   * `configureRA` arms a `setInterval`; using it to set the M flag would
   * start periodic advertisements on the one interface where a flag was
   * touched — a behaviour difference no command asked for.
   */
  setRaParams(ifName: string, params: Partial<RAConfig>): void {
    const config = this.raConfigOf(ifName);
    Object.assign(config, params);
    if (config.enabled === false) {
      const t = this.raTimers.get(ifName);
      if (t) { this.timers.clear(t); this.raTimers.delete(ifName); }
    }
  }

  getRaParams(ifName: string): RAConfig | undefined { return this.raConfig.get(ifName); }

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

    this.v6Counters.ndOutRouterAdverts++;
    this.v6Counters.outRequests++;
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
      this.v6Counters.inHopLimitExceeded++;
      Logger.info(this.ctx.id, 'router:hop-limit-expired',
        `${this.ctx.name}: Hop limit expired for ${ipv6.sourceIP} → ${ipv6.destinationIP}`);
      this.sendICMPv6Error(inPort, ipv6, 'time-exceeded', 0);
      return;
    }

    const route = this.lookupRoute(ipv6.destinationIP);
    if (!route) {
      this.v6Counters.inNoRoutes++;
      Logger.info(this.ctx.id, 'router:no-ipv6-route',
        `${this.ctx.name}: no route for ${ipv6.destinationIP}`);
      this.sendICMPv6Error(inPort, ipv6, 'destination-unreachable', 0);
      return;
    }

    const fwdPkt: IPv6Packet = {
      ...ipv6,
      hopLimit: newHopLimit,
    };

    // An outbound filter applies to TRANSIT traffic only: a packet this
    // router originates itself is not filtered on the way out, which is
    // why the check lives here and not in `sendEchoRequest`.
    if (this.ctx.ipv6FilterPermits?.(route.iface, 'out', fwdPkt, inPort) === false) {
      this.v6Counters.outFiltered++;
      Logger.info(this.ctx.id, 'router:ipv6-acl-deny-out',
        `${this.ctx.name}: IPv6 ACL denied outbound on ${route.iface}: `
        + `${ipv6.sourceIP} -> ${ipv6.destinationIP}`);
      return;
    }

    const nextHopIP = route.nextHop || ipv6.destinationIP;
    const outPort = this.ctx.getPorts().get(route.iface);
    if (!outPort) return;

    const cached = this.neighborCache.markUsed(nextHopIP.toString());
    if (cached) {
      this.ctx.getCounters().ipForwDatagrams++;
      this.v6Counters.outForwarded++;
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

  private sendUnicastNeighborSolicit(ip: string, entry: NeighborCacheEntry): void {
    const port = this.ctx.getPorts().get(entry.iface);
    if (!port || !port.isIPv6Enabled()) return;
    const targetIP = new IPv6Address(ip);
    const srcIP = targetIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());
    if (!srcIP) return;

    this.v6Counters.ndOutSolicits++;
    this.v6Counters.outRequests++;
    const ns = createNeighborSolicitation(targetIP, port.getMAC());
    const nsPkt = createIPv6Packet(srcIP, targetIP, IP_PROTO_ICMPV6, 255, ns, 24);
    this.ctx.sendFrame(entry.iface, {
      srcMAC: port.getMAC(),
      dstMAC: entry.mac,
      etherType: ETHERTYPE_IPV6,
      payload: nsPkt,
    });
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
    // RFC 4443 §2.2: a unicast address of the interface the packet came
    // in on. The global one when there is one — it is what a traceroute
    // prints, and a link-local hop teaches the operator nothing about
    // which network the router sits on.
    const srcIP = port.getGlobalIPv6() || port.getLinkLocalIPv6();
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

    // Routed for the same reason the echo reply is: a Hop Limit Exceeded
    // answers a source that is by definition several hops away — that is
    // what makes a traceroute work at all.
    const egress = this.resolveEgress(offendingPkt.sourceIP, srcIP.toString());
    if (!egress) return;
    this.v6Counters.icmpOutErrors++;
    this.v6Counters.outRequests++;
    this.ctx.sendFrame(egress.iface, {
      srcMAC: egress.port.getMAC(),
      dstMAC: egress.nextHopMAC,
      etherType: ETHERTYPE_IPV6,
      payload: errorPkt,
    });
  }

  sendFrameNdpAware(iface: string, pkt: IPv6Packet, nextHopIP: IPv6Address): void {
    const port = this.ctx.getPorts().get(iface);
    if (!port) return;
    const cached = this.neighborCache.markUsed(nextHopIP.toString());
    if (cached) {
      this.ctx.sendFrame(iface, {
        srcMAC: port.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6, payload: pkt,
      });
      return;
    }
    this.queueAndResolve(pkt, iface, nextHopIP, port);
  }

  // ─── NDP Resolution + Packet Queue ────────────────────────────

  private queueAndResolve(pkt: IPv6Packet, iface: string, nextHopIP: IPv6Address, port: Port): void {
    const timer = this.timers.setTimeout(() => {
      this.packetQueue = this.packetQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
      this.inFlightNDPs.delete(nextHopIP.toString());
    }, 2000);

    this.packetQueue.push({ frame: pkt, outIface: iface, nextHopIP, timer });

    const key = nextHopIP.toString();
    if (!this.inFlightNDPs.has(key)) {
      this.inFlightNDPs.add(key);

      const srcIP = port.getLinkLocalIPv6();
      if (!srcIP) return;

      this.v6Counters.ndOutSolicits++;
      this.v6Counters.outRequests++;
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
    this.inFlightNDPs.delete(resolvedIP.toString());

    for (const q of ready) {
      this.timers.clear(q.timer);
      const outPort = this.ctx.getPorts().get(q.outIface);
      if (outPort) {
        this.ctx.getCounters().ipForwDatagrams++;
        this.v6Counters.outForwarded++;
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
