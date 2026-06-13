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
import {
  ipv4MulticastToMac, isMulticastIpv4,
  tryIpToUint32, ipToUint32, prefixLengthToMaskUint32,
} from '../../core/ip';
import { EIGRPEngine } from '../../eigrp/EIGRPEngine';
import {
  EIGRP_MULTICAST_IP, isEigrpPacket, type EigrpPacket,
} from '../../eigrp/packets';
import { BGPEngine, type BgpPeerLink } from '../../bgp/BGPEngine';
import type { BgpTransport } from '../../bgp/BgpSession';
import { BGP_PORT, isBgpMessage, type BgpMessage } from '../../bgp/messages';
import type { TcpStack, TcpSocket } from '../../tcp/TcpStack';
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
  /** The router's TCP stack — BGP peers over real TCP/179 sessions. */
  getTcpStack(): TcpStack;
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
    // BGP converses over real TCP/179 sessions on the cable (no god-mode):
    // outbound via connect(), inbound via the listener wired lazily once
    // the TCP stack exists (see ensureBgpListener).
    this.bgp.setWire({ connect: (ip) => this.bgpConnect(ip) });
    // An UPDATE that lands on a peer's converge must still reach our RIB.
    this.bgp.setOnRibChange(() => this.reflectRib());
  }

  // ── BGP wire transport (TCP/179) ───────────────────────────────────

  private bgpListenerSet = false;

  /** Install the TCP/179 listener once BGP is enabled (passive opens). */
  private ensureBgpListener(): void {
    if (this.bgpListenerSet) return;
    this.bgpListenerSet = true;
    this.ctx.getTcpStack().listen(BGP_PORT, {
      onAccept: (socket) => {
        const neighborIp = socket.remoteIp;
        const egress = this.egressToward(neighborIp);
        this.bgp.acceptInbound({
          neighborIp,
          localIp: egress?.localIp ?? socket.localIp,
          localIface: egress?.localIface ?? '',
          transport: bgpTransport(socket),
        });
      },
    });
  }

  /** Open an outbound TCP/179 session to a configured neighbour. */
  private bgpConnect(neighborIp: string): BgpPeerLink | null {
    const egress = this.egressToward(neighborIp);
    if (!egress) return null;                 // not a cabled, same-subnet peer
    const socket = this.ctx.getTcpStack().connect(neighborIp, BGP_PORT);
    // No listener yet (peer not running BGP) ⇒ RST during the synchronous
    // handshake. Don't hand back a dead socket — stay Idle and retry later.
    if (!socket || socket.state !== 'established') { socket?.close(); return null; }
    return {
      neighborIp,
      localIp: egress.localIp, localIface: egress.localIface,
      transport: bgpTransport(socket),
    };
  }

  /** The local IP/interface on the same subnet as a neighbour, if any. */
  private egressToward(ip: string): { localIp: string; localIface: string } | null {
    const target = tryIpToUint32(ip);
    if (target === null) return null;
    for (const [name, port] of this.ctx.getPorts()) {
      const pip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!pip || !mask || !port.getIsUp()) continue;
      const m = prefixLengthToMaskUint32(mask.toCIDR());
      if ((ipToUint32(pip.toString()) & m) === (target & m)) {
        return { localIp: pip.toString(), localIface: name };
      }
    }
    return null;
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
    if (this.bgp.isEnabled()) this.ensureBgpListener();
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
    if (this.bgp.isEnabled()) this.ensureBgpListener();
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

/**
 * Adapt a TCP socket to the BGP transport seam: BGP messages ride the real
 * byte stream, and only well-formed BGP payloads are surfaced to the FSM.
 */
function bgpTransport(socket: TcpSocket): BgpTransport {
  return {
    send: (msg: BgpMessage) => socket.send(msg),
    close: () => socket.close(),
    onMessage: (h) => { socket.onData((d) => { if (isBgpMessage(d)) h(d); }); },
    onClose: (h) => { socket.onClose(() => h()); },
  };
}
