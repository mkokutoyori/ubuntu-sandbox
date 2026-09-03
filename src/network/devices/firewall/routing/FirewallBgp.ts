import { IPAddress, SubnetMask } from '../../../core/types';
import { ipToUint32, tryIpToUint32, prefixLengthToMaskUint32 } from '../../../core/ip';
import { BGPEngine, type BgpPeerLink } from '../../../bgp/BGPEngine';
import { BGP_PORT } from '../../../bgp/messages';
import { bgpTransport } from '../../../bgp/bgpTransport';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { IEventBus } from '../../../../events/EventBus';
import type { ProtocolNeighborView } from '../../../routing/types';
import type { ConnectedNetwork } from '../../../routing/RoutingPeerLocator';
import {
  BGP_DEFAULTS, type BgpConfiguration, type BgpSummaryFacts,
} from './DynamicRoutingTypes';
import type { RoutingPortFacts } from './FirewallRouting';

export interface FirewallBgpDeps {
  readonly deviceId: string;
  readonly bus: () => IEventBus;
  readonly tcp: () => TcpStack;
  readonly ports: () => readonly RoutingPortFacts[];
  readonly connectedRoutes: () => ReadonlyArray<{
    network: string; mask: string; iface: string;
  }>;
  readonly installRoute: (route: {
    network: string; mask: string; nextHop?: string; iface: string;
    distance: number; metric: number;
  }) => void;
  readonly removeRoutes: () => void;
}

export const AS_NUMBER_MAX = 4294967295;

export interface BgpClearScope {
  readonly kind: 'all' | 'ip' | 'as' | 'external';
  readonly value?: string;
}

export class FirewallBgp {
  private engine: BGPEngine | null = null;
  private config: BgpConfiguration = BGP_DEFAULTS;
  private listening = false;

  constructor(private readonly deps: FirewallBgpDeps) {}

  apply(config: BgpConfiguration): string | undefined {
    this.config = config;
    if (!config.enabled) {
      this.engine?.shutdownTimers();
      this.engine = null;
      this.deps.removeRoutes();
      return undefined;
    }

    const engine = new BGPEngine(this.deps.deviceId);
    engine.setBus(this.deps.bus());
    engine.setDeviceContext({
      connectedNetworks: () => this.connectedNetworks(),
    });
    engine.setWire({ connect: (ip) => this.dial(ip) });
    engine.setOnRibChange(() => { this.installRoutes(); });

    this.engine = engine;
    this.listen();
    engine.enable({
      asn: config.asn,
      routerId: config.routerId.length > 0 ? config.routerId : this.derivedRouterId(),
      networks: config.networks.map(network => ({
        network: network.prefix, mask: network.mask,
      })),
      neighbors: new Map(config.neighbours.map(peer => [peer.ip, {
        ip: peer.ip, remoteAs: peer.remoteAs, activated: true, weight: peer.weight,
      }])),
    });
    this.installRoutes();
    return undefined;
  }

  getEngine(): BGPEngine | null { return this.engine; }

  clearSessions(scope: BgpClearScope): readonly string[] {
    const engine = this.engine;
    if (!engine) return [];
    return engine.resetPeers((ip, cfg) => {
      if (scope.kind === 'all') return true;
      if (scope.kind === 'ip') return ip === scope.value;
      if (scope.kind === 'as') return cfg.remoteAs === Number(scope.value);
      return cfg.remoteAs !== this.config.asn;
    });
  }

  getConfig(): BgpConfiguration { return this.config; }

  neighbours(): readonly ProtocolNeighborView[] {
    return this.engine?.getNeighbors() ?? [];
  }

  summaryFacts(): BgpSummaryFacts {
    const live = new Map(this.neighbours().map(peer => [peer.address, peer]));
    return {
      routerId: this.config.routerId.length > 0 ? this.config.routerId : '0.0.0.0',
      localAs: this.config.asn,
      neighbours: this.config.neighbours.map(peer => {
        const seen = live.get(peer.ip);
        return {
          address: peer.ip,
          remoteAs: peer.remoteAs,
          state: seen?.isUp ? 'Established' : (seen?.state ?? 'Idle'),
          isUp: seen?.isUp === true,
          uptimeSec: seen?.uptimeSec ?? 0,
          prefixesReceived: 0,
        };
      }),
    };
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.deps.tcp().listen(BGP_PORT, {
      onAccept: (socket) => {
        const egress = this.egressToward(socket.remoteIp);
        this.engine?.acceptInbound({
          neighborIp: socket.remoteIp,
          localIp: egress?.localIp ?? socket.localIp,
          localIface: egress?.localIface ?? '',
          transport: bgpTransport(socket),
        });
        this.installRoutes();
      },
    });
  }

  private dial(neighborIp: string): BgpPeerLink | null {
    const egress = this.egressToward(neighborIp);
    if (!egress) return null;

    const socket = this.deps.tcp().connect(neighborIp, BGP_PORT);
    if (!socket || socket.state !== 'established') { socket?.close(); return null; }

    return {
      neighborIp,
      localIp: egress.localIp,
      localIface: egress.localIface,
      transport: bgpTransport(socket),
    };
  }

  private connectedNetworks(): ConnectedNetwork[] {
    const ports = this.deps.ports();
    const found: ConnectedNetwork[] = [];
    for (const route of this.deps.connectedRoutes()) {
      const port = ports.find(entry => entry.name === route.iface);
      if (!port) continue;
      found.push({
        network: new IPAddress(route.network),
        mask: new SubnetMask(route.mask),
        iface: route.iface,
        localIp: new IPAddress(port.ip),
      });
    }
    return found;
  }

  private egressToward(ip: string): { localIp: string; localIface: string } | null {
    const target = tryIpToUint32(ip);
    if (target === null) return null;

    for (const port of this.deps.ports()) {
      const local = tryIpToUint32(port.ip);
      if (local === null) continue;
      const mask = prefixLengthToMaskUint32(new SubnetMask(port.mask).toCIDR());
      if (((local & mask) >>> 0) === ((target & mask) >>> 0)) {
        return { localIp: port.ip, localIface: port.name };
      }
    }
    return null;
  }

  private installRoutes(): void {
    this.deps.removeRoutes();
    for (const route of this.engine?.getContributedRoutes() ?? []) {
      this.deps.installRoute({
        network: route.network.toString(),
        mask: route.mask.toString(),
        nextHop: route.nextHop?.toString(),
        iface: route.iface,
        distance: route.adminDistance,
        metric: route.metric,
      });
    }
  }

  private derivedRouterId(): string {
    let best = 0;
    let chosen = '0.0.0.1';
    for (const port of this.deps.ports()) {
      const value = ipToUint32(port.ip);
      if (value > best) { best = value; chosen = port.ip; }
    }
    return chosen;
  }
}
