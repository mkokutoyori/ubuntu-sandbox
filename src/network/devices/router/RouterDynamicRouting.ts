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
