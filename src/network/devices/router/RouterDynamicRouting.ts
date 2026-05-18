/**
 * RouterDynamicRouting — integration adapter binding the real
 * EIGRP/BGP engines to a Router (mirrors the RIP/OSPF integration).
 *
 * SRP: it only wires the topology seams (RoutingPeerLocator /
 * RoutingDeviceContext) and reflects each engine's contributed routes
 * into the Router RIB. All protocol logic lives in the engines; all
 * adjacency remains REAL config-driven (a peer is only seen if it is
 * genuinely cabled and runs the same protocol).
 */
import { Equipment } from '../../equipment/Equipment';
import type { Port } from '../../hardware/Port';
import { IPAddress, SubnetMask } from '../../core/types';
import { EIGRPEngine } from '../../eigrp/EIGRPEngine';
import { BGPEngine } from '../../bgp/BGPEngine';
import type {
  RoutingPeer, RibRoute,
} from '../../routing/types';
import type {
  ConnectedNetwork,
} from '../../routing/RoutingPeerLocator';
import type { RouteEntry } from '../Router';

export interface DynamicRoutingCtx {
  readonly id: string;
  getPorts(): Map<string, Port>;
  getRoutingTable(): RouteEntry[];
  setRoutingTable(t: RouteEntry[]): void;
}

function networkOf(ip: IPAddress, mask: SubnetMask): IPAddress {
  const o = ip.toString().split('.').map(Number);
  const m = mask.getOctets();
  return new IPAddress(o.map((v, i) => v & m[i]).join('.'));
}

export class RouterDynamicRouting {
  readonly eigrp: EIGRPEngine;
  readonly bgp: BGPEngine;

  constructor(private readonly ctx: DynamicRoutingCtx) {
    this.eigrp = new EIGRPEngine(ctx.id);
    this.bgp = new BGPEngine(ctx.id);
    const deviceContext = { connectedNetworks: () => this.connected() };
    const peerLocator = { locatePeers: () => this.peers() };
    for (const e of [this.eigrp, this.bgp]) {
      e.setDeviceContext(deviceContext);
      e.setPeerLocator(peerLocator);
    }
  }

  /** Engine accessor used by a peer's locator (duck-typed reach). */
  engineFor(protocol: string): EIGRPEngine | BGPEngine | null {
    if (protocol === 'eigrp') return this.eigrp;
    if (protocol === 'bgp') return this.bgp;
    return null;
  }

  private connected(): ConnectedNetwork[] {
    const out: ConnectedNetwork[] = [];
    for (const [name, port] of this.ctx.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask || !port.getIsUp()) continue;
      out.push({ network: networkOf(ip, mask), mask, iface: name, localIp: ip });
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
        peerEngineFor: (proto) => peerDR.engineFor(proto),
      });
    }
    return out;
  }

  /** Recompute both engines and reflect their routes into the RIB. */
  converge(): void {
    this.eigrp.converge();
    this.bgp.converge();
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
