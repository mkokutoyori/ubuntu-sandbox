import {
  ETHERTYPE_IPV4, IPAddress, IP_PROTO_OSPF, MACAddress, SubnetMask,
  createIPv4Packet,
  type EthernetFrame, type IPv4Packet, type RIPPacket,
} from '../../../core/types';
import { ipv4MulticastToMac } from '../../../core/ip';
import { OSPFEngine } from '../../../ospf/OSPFEngine';
import type { OSPFPacket } from '../../../ospf/types';
import { RIPEngine } from '../../../rip/RIPEngine';
import type { IEventBus } from '../../../../events/EventBus';
import type { TcpStack } from '../../../tcp/TcpStack';
import {
  OSPF_DEFAULTS, RIP_DEFAULTS,
  type BgpConfiguration, type OspfConfiguration, type RipConfiguration,
} from './DynamicRoutingTypes';
import { FirewallBgp } from './FirewallBgp';

export interface RoutingPortFacts {
  readonly name: string;
  readonly ip: string;
  readonly mask: string;
  readonly mac: MACAddress;
}

export interface FirewallRoutingDeps {
  readonly deviceId: string;
  readonly hostname: () => string;
  readonly bus: () => IEventBus;
  readonly ports: () => readonly RoutingPortFacts[];
  readonly sendFrame: (iface: string, frame: EthernetFrame) => void;
  readonly connectedRoutes: () => ReadonlyArray<{
    network: string; mask: string; iface: string;
  }>;
  readonly installRoute: (route: {
    network: string; mask: string; nextHop?: string; iface: string;
    distance: number; metric: number; source: RoutingSource; routeType?: string;
  }) => void;
  readonly removeRoutes: (source: RoutingSource) => void;
  readonly resolvedMac: (ip: string) => MACAddress | undefined;
  readonly tcp: () => TcpStack;
}

export type RoutingSource = 'rip' | 'ospf' | 'bgp';

const RIP_DISTANCE = 120;
const OSPF_DISTANCE = 110;

function authTypeOf(mode: string | undefined): number {
  if (mode === 'md5') return 2;
  if (mode === 'text') return 1;
  return 0;
}

export class FirewallRouting {
  private readonly bgpService: FirewallBgp;
  private rip: RIPEngine | null = null;
  private ospf: OSPFEngine | null = null;
  private ripConfig: RipConfiguration = RIP_DEFAULTS;
  private ospfConfig: OspfConfiguration = OSPF_DEFAULTS;

  constructor(private readonly deps: FirewallRoutingDeps) {
    this.bgpService = new FirewallBgp({
      deviceId: deps.deviceId,
      bus: deps.bus,
      tcp: deps.tcp,
      ports: deps.ports,
      connectedRoutes: deps.connectedRoutes,
      installRoute: (route) => { deps.installRoute({ ...route, source: 'bgp' }); },
      removeRoutes: () => { deps.removeRoutes('bgp'); },
    });
  }

  applyBgp(config: BgpConfiguration): string | undefined {
    return this.bgpService.apply(config);
  }

  getBgp(): FirewallBgp { return this.bgpService; }

  applyRip(config: RipConfiguration): string | undefined {
    this.ripConfig = config;
    if (!config.enabled) { this.rip = null; this.deps.removeRoutes('rip'); return undefined; }

    this.rip = new RIPEngine(this.deps.deviceId, this.deps.hostname(), this.ripCallbacks());
    this.rip.setEventBus?.(this.deps.bus());
    this.rip.start();
    for (const network of config.networks) {
      this.rip.advertiseNetwork(new IPAddress(network.prefix), new SubnetMask(network.mask));
    }
    return undefined;
  }

  applyOspf(config: OspfConfiguration): string | undefined {
    this.ospfConfig = config;
    if (!config.enabled) { this.ospf?.shutdown(); this.ospf = null; this.deps.removeRoutes('ospf'); return undefined; }
    if (config.routerId === '0.0.0.0') {
      return 'a router ID of 0.0.0.0 is invalid (RFC 2328 §C.1).';
    }

    const engine = new OSPFEngine(1);
    engine.setDeviceId(this.deps.deviceId);
    engine.setEventBus(this.deps.bus());
    engine.setRouterId(config.routerId.length > 0 ? config.routerId : this.derivedRouterId());
    engine.setSendCallback((iface, packet, destIP) => {
      this.emitOspf(iface, packet, destIP);
    });
    engine.routingTableSync?.onRoutes(() => { this.installOspfRoutes(); });

    for (const area of config.areas) {
      engine.setAreaType(area.id, engineAreaType(area.type));
    }
    for (const network of config.networks) {
      engine.addNetwork(network.prefix, wildcardOf(network.mask), network.area);
    }

    this.ospf = engine;
    this.activateOspfInterfaces();
    return undefined;
  }

  getRip(): RIPEngine | null { return this.rip; }

  getOspf(): OSPFEngine | null { return this.ospf; }

  receiveRip(iface: string, source: IPAddress, packet: RIPPacket): void {
    this.rip?.processPacket(iface, source, packet);
  }

  receiveOspf(iface: string, source: string, packet: OSPFPacket): void {
    this.ospf?.processPacket(iface, source, packet);
  }

  ospfNeighbors(): ReadonlyArray<{
    routerId: string; priority: number; state: string; address: string; iface: string;
  }> {
    const found: Array<{
      routerId: string; priority: number; state: string; address: string; iface: string;
    }> = [];

    for (const [name, iface] of this.ospf?.getInterfaces() ?? new Map()) {
      for (const [, neighbour] of iface.neighbors ?? new Map()) {
        found.push({
          routerId: neighbour.routerId,
          priority: neighbour.priority ?? 1,
          state: neighbour.state,
          address: neighbour.ipAddress ?? '',
          iface: name,
        });
      }
    }
    return found;
  }

  refreshInterfaces(): void {
    this.activateOspfInterfaces();
  }

  private activateOspfInterfaces(): void {
    if (!this.ospf) return;

    const declared = this.deps.ports().map(port => ({
      name: port.name, ip: port.ip, mask: port.mask,
    }));
    for (const matched of this.ospf.matchInterfaces(declared)) {
      const settings = this.ospfConfig.interfaces.find(
        entry => entry.iface === matched.name);
      const iface = this.ospf.activateInterface(
        matched.name, matched.ip, matched.mask, matched.areaId,
        settings === undefined ? undefined : {
          cost: settings.cost,
          priority: settings.priority,
          helloInterval: settings.helloIntervalSec,
          deadInterval: settings.deadIntervalSec,
        });

      iface.authType = authTypeOf(settings?.authentication);
      iface.authKey = iface.authType === 0
        ? undefined : (settings?.md5Keys[0]?.key ?? '');

      if (this.ospfConfig.passiveInterfaces.includes(matched.name)) {
        this.ospf.setPassiveInterface(matched.name);
      }
    }
  }

  private installOspfRoutes(): void {
    if (!this.ospf) return;

    this.deps.removeRoutes('ospf');
    for (const route of this.ospf.getRoutes()) {
      this.deps.installRoute({
        network: route.network,
        mask: route.mask,
        nextHop: route.nextHop,
        iface: route.iface,
        distance: OSPF_DISTANCE,
        metric: route.cost,
        source: 'ospf',
        routeType: route.routeType,
      });
    }
  }

  private emitOspf(iface: string, packet: OSPFPacket, destIP: string): void {
    const port = this.deps.ports().find(entry => entry.name === iface);
    if (!port) return;

    const ipPacket = createIPv4Packet(
      new IPAddress(port.ip), new IPAddress(destIP), IP_PROTO_OSPF, 1, packet, 64);

    this.deps.sendFrame(iface, {
      srcMAC: port.mac,
      dstMAC: multicastOrResolved(destIP, this.deps.resolvedMac(destIP)),
      etherType: ETHERTYPE_IPV4,
      payload: ipPacket,
    });
  }

  private ripCallbacks() {
    return {
      getPortIP: (name: string) => this.portOf(name)
        ? new IPAddress(this.portOf(name)!.ip) : null,
      getPortMask: (name: string) => this.portOf(name)
        ? new SubnetMask(this.portOf(name)!.mask) : null,
      getPortMAC: (name: string) => this.portOf(name)?.mac ?? MACAddress.broadcast(),
      getPortNames: () => this.deps.ports().map(port => port.name),
      sendFrame: (name: string, frame: EthernetFrame) => {
        this.deps.sendFrame(name, frame);
        return true;
      },
      getRoutingTable: () => this.deps.connectedRoutes().map(route => ({
        network: new IPAddress(route.network),
        mask: new SubnetMask(route.mask),
        iface: route.iface,
        type: 'connected',
        metric: 0,
      })),
      installRoute: (route: {
        network: IPAddress; mask: SubnetMask; nextHop?: IPAddress;
        iface: string; metric: number;
      }) => {
        this.deps.installRoute({
          network: route.network.toString(),
          mask: route.mask.toString(),
          nextHop: route.nextHop?.toString(),
          iface: route.iface,
          distance: RIP_DISTANCE,
          metric: route.metric,
          source: 'rip',
        });
      },
      removeRoute: () => { this.deps.removeRoutes('rip'); },
      updateRoute: (
        _network: IPAddress, _mask: SubnetMask,
        route: { network: IPAddress; mask: SubnetMask; nextHop?: IPAddress; iface: string; metric: number },
      ) => {
        this.deps.installRoute({
          network: route.network.toString(),
          mask: route.mask.toString(),
          nextHop: route.nextHop?.toString(),
          iface: route.iface,
          distance: RIP_DISTANCE,
          metric: route.metric,
          source: 'rip',
        });
      },
      getRipVersion: () => this.ripConfig.version,
    };
  }

  private portOf(name: string): RoutingPortFacts | undefined {
    return this.deps.ports().find(port => port.name === name);
  }

  private derivedRouterId(): string {
    const highest = [...this.deps.ports()].map(port => port.ip).sort().pop();
    return highest ?? '0.0.0.1';
  }
}

function multicastOrResolved(destIP: string, resolved?: MACAddress): MACAddress {
  if (destIP === '224.0.0.5' || destIP === '224.0.0.6') {
    return new MACAddress(ipv4MulticastToMac(destIP));
  }
  return resolved ?? MACAddress.broadcast();
}

function engineAreaType(type: string): 'normal' | 'stub' | 'nssa' {
  if (type === 'stub') return 'stub';
  if (type === 'nssa') return 'nssa';
  return 'normal';
}

function wildcardOf(mask: string): string {
  return mask.split('.')
    .map(octet => String(255 - Number.parseInt(octet, 10)))
    .join('.');
}

export function ripPacketOf(packet: IPv4Packet): RIPPacket | null {
  const payload = packet.payload as { type?: string } | undefined;
  if (payload?.type !== 'udp') return null;

  const udp = packet.payload as { destinationPort: number; payload: unknown };
  if (udp.destinationPort !== 520) return null;

  const rip = udp.payload as RIPPacket | undefined;
  return rip?.type === 'rip' ? rip : null;
}
