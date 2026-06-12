/**
 * RouterDynamicRouting — integration adapter binding the real
 * EIGRP/BGP engines to a Router (mirrors the RIP/OSPF integration).
 *
 * SRP: it only wires the topology seams (RoutingPeerLocator /
 * RoutingDeviceContext / EigrpWire) and reflects each engine's
 * contributed routes into the Router RIB. All protocol logic lives in
 * the engines. EIGRP converses in REAL IPv4 protocol-88 frames
 * (multicast 224.0.0.10) leaving through the router's ports; BGP still
 * resolves its peers through the locator (object-level — its
 * TCP/179 migration is a separate, documented work item).
 */
import { Equipment } from '../../equipment/Equipment';
import type { Port } from '../../hardware/Port';
import {
  EthernetFrame, IPv4Packet, MACAddress, IPAddress, SubnetMask,
  ETHERTYPE_IPV4, IP_PROTO_EIGRP, createIPv4Packet,
} from '../../core/types';
import { ipv4MulticastToMac, isMulticastIpv4 } from '../../core/ip';
import { EIGRPEngine } from '../../eigrp/EIGRPEngine';
import {
  EIGRP_MULTICAST_IP, isEigrpPacket, type EigrpPacket,
} from '../../eigrp/packets';
import { BGPEngine } from '../../bgp/BGPEngine';
import type {
  RoutingPeer, RibRoute,
} from '../../routing/types';
import type {
  ConnectedNetwork,
} from '../../routing/RoutingPeerLocator';
import type { IRoutingProtocolEngine } from '../../routing/IRoutingProtocolEngine';
import { RipEngineAdapter } from '../../routing/adapters/RipEngineAdapter';
import { OspfEngineAdapter } from '../../routing/adapters/OspfEngineAdapter';
import type { RouterRIPEngine } from './RouterRIPEngine';
import type { RouterOSPFIntegration } from './RouterOSPFIntegration';
import type { RouteEntry } from '../Router';

export interface DynamicRoutingCtx {
  readonly id: string;
  getPorts(): Map<string, Port>;
  getRoutingTable(): RouteEntry[];
  setRoutingTable(t: RouteEntry[]): void;
  /** Egress for protocol frames (Port → Cable → peer handleFrame). */
  sendFrame(iface: string, frame: EthernetFrame): void;
  getArpEntry(ip: string): { mac: MACAddress; iface: string } | undefined;
  /** Existing frame-driven engines, exposed through the unified contract. */
  getRipEngine(): RouterRIPEngine;
  getOspfIntegration(): RouterOSPFIntegration;
}

function networkOf(ip: IPAddress, mask: SubnetMask): IPAddress {
  const o = ip.toString().split('.').map(Number);
  const m = mask.getOctets();
  return new IPAddress(o.map((v, i) => v & m[i]).join('.'));
}

export class RouterDynamicRouting {
  readonly eigrp: EIGRPEngine;
  readonly bgp: BGPEngine;
  /** RIP/OSPF exposed through the SAME contract (Adapter). */
  readonly rip: RipEngineAdapter;
  readonly ospf: OspfEngineAdapter;

  constructor(private readonly ctx: DynamicRoutingCtx) {
    this.eigrp = new EIGRPEngine(ctx.id);
    this.bgp = new BGPEngine(ctx.id);
    this.rip = new RipEngineAdapter(ctx.getRipEngine());
    this.ospf = new OspfEngineAdapter(() => ctx.getOspfIntegration());
    const deviceContext = {
      connectedNetworks: () => this.connected(),
      ribRoutes: () => this.ctx.getRoutingTable().map((r) => ({
        network: r.network, mask: r.mask, type: r.type,
      })),
    };
    const peerLocator = { locatePeers: () => this.peers() };
    for (const e of [this.eigrp, this.bgp]) {
      e.setDeviceContext(deviceContext);
      e.setPeerLocator(peerLocator);
    }
    this.eigrp.setWire({
      send: (iface, destIp, packet) =>
        this.sendEigrpFrame(iface, destIp, packet),
    });
  }

  /** Every routing protocol, uniformly (full consistency). */
  allEngines(): IRoutingProtocolEngine<unknown>[] {
    return [this.rip, this.ospf, this.eigrp, this.bgp] as
      IRoutingProtocolEngine<unknown>[];
  }

  /** Engine accessor used by a peer's locator + uniform lookup. */
  engineFor(protocol: string):
    EIGRPEngine | BGPEngine | RipEngineAdapter | OspfEngineAdapter | null {
    if (protocol === 'eigrp') return this.eigrp;
    if (protocol === 'bgp') return this.bgp;
    if (protocol === 'rip') return this.rip;
    if (protocol === 'ospf') return this.ospf;
    return null;
  }

  // ── EIGRP wire transport ──────────────────────────────────────────

  /**
   * Encapsulate an EIGRP packet in IPv4 protocol 88, TTL 1 (RFC 7868
   * §4.2), and send the real frame out the port. Multicast maps to
   * its RFC 1112 MAC; unicast resolves through the ARP cache.
   */
  private sendEigrpFrame(iface: string, destIp: string,
    packet: EigrpPacket): void {
    const port = this.ctx.getPorts().get(iface);
    if (!port || !port.getIsUp()) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;
    const ipPkt = createIPv4Packet(
      myIP, new IPAddress(destIp), IP_PROTO_EIGRP, 1, packet, 64);
    const dstMAC = isMulticastIpv4(destIp)
      ? new MACAddress(ipv4MulticastToMac(destIp))
      : (this.ctx.getArpEntry(destIp)?.mac ?? MACAddress.broadcast());
    this.ctx.sendFrame(iface, {
      srcMAC: port.getMAC(), dstMAC,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });
  }

  /** EIGRP packets from the wire (proto 88) — the only path in. */
  receiveEigrpPacket(inPort: string, ipPkt: IPv4Packet): void {
    const payload = ipPkt.payload;
    if (!isEigrpPacket(payload)) return;
    this.eigrp.processPacket(
      inPort, ipPkt.sourceIP.toString(), payload,
      ipPkt.destinationIP.toString() === EIGRP_MULTICAST_IP);
  }

  private connected(): ConnectedNetwork[] {
    const out: ConnectedNetwork[] = [];
    for (const [name, port] of this.ctx.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask || !port.getIsUp()) continue;
      out.push({
        network: networkOf(ip, mask), mask, iface: name, localIp: ip,
        bandwidthKbps: port.getEffectiveBandwidthKbps(),
        delayUsec: port.getDelayUs(),
      });
    }
    return out;
  }

  private peers(): RoutingPeer[] {
    const out: RoutingPeer[] = [];
    for (const [name, port] of this.ctx.getPorts()) {
      if (!port.getIsUp()) continue;
      const cable = port.getCable();
      if (!cable) continue;
      const a = cable.getPortA();
      const b = cable.getPortB();
      const peerPort = a === port ? b : a;
      if (!peerPort) continue;
      const dev = Equipment.getById(peerPort.getEquipmentId()) as unknown as {
        getDynamicRouting?(): RouterDynamicRouting;
      } | undefined;
      const peerDR = dev?.getDynamicRouting?.();
      if (!peerDR) continue;
      out.push({
        deviceId: peerPort.getEquipmentId(),
        hostname: (Equipment.getById(peerPort.getEquipmentId())
          ?.getHostname()) ?? peerPort.getEquipmentId(),
        localIface: name,
        localIp: port.getIPAddress(),
        remoteIface: peerPort.getName(),
        remoteIp: peerPort.getIPAddress(),
        linkBandwidthKbps: port.getEffectiveBandwidthKbps(),
        linkDelayUsec: port.getDelayUs(),
        peerEngineFor: (proto) => peerDR.engineFor(proto),
      });
    }
    return out;
  }

  /** True if any dynamic engine is enabled (cheap forwarding guard). */
  hasActive(): boolean {
    return this.eigrp.isEnabled() || this.bgp.isEnabled();
  }

  /** Recompute both engines and reflect their routes into the RIB. */
  converge(): void {
    this.eigrp.converge();
    this.bgp.converge();
    this.reflectRib();
  }

  /**
   * Data-path variant (called before every forwarding decision):
   * reflect routes already learned from the wire WITHOUT pumping new
   * EIGRP frames — a real router does not hello on every packet it
   * forwards. Real rounds happen at config/show time (triggered
   * updates) via {@link converge}.
   */
  refresh(): void {
    this.eigrp.refreshFromCache();
    this.bgp.converge();
    this.reflectRib();
  }

  private reflectRib(): void {
    const kept = this.ctx.getRoutingTable()
      .filter((r) => r.type !== 'eigrp' && r.type !== 'bgp');
    const add = (rr: RibRoute): RouteEntry => ({
      network: rr.network,
      mask: rr.mask,
      nextHop: rr.nextHop,
      iface: rr.iface,
      type: rr.protocol as 'eigrp' | 'bgp',
      ad: rr.adminDistance,
      metric: rr.metric,
    });
    for (const rr of this.eigrp.getContributedRoutes()) kept.push(add(rr));
    for (const rr of this.bgp.getContributedRoutes()) kept.push(add(rr));
    this.ctx.setRoutingTable(kept);
  }
}
