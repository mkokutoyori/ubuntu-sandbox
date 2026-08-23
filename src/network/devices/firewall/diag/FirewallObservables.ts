import {
  HostSignalStore, makeReadonlyHostObservables, projectArpTable, projectHostRoutes,
  type HostObservables,
} from '../../host/observables';
import type { ArpService } from '../l3/ArpService';
import type { RouteTable } from '../l3/RouteTable';
import type { TcpStack } from '../../../tcp/TcpStack';

export interface FirewallStateSources {
  arp(): ArpService;
  routes(): RouteTable;
  tcp(): TcpStack;
}

export class FirewallObservables {
  private readonly store = new HostSignalStore();

  private echosSent = 0;
  private echosReceived = 0;

  constructor(private readonly sources: FirewallStateSources) {}

  readonly published: HostObservables = makeReadonlyHostObservables(this.store);

  countEchoSent(): void { this.echosSent++; this.refresh(); }

  countEchoReceived(): void { this.echosReceived++; this.refresh(); }

  refresh(): void {
    const arp = projectArpTable(this.sources.arp().getCache());
    const routes = projectHostRoutes(this.sources.routes().all().map(route => ({
      network: route.network,
      mask: route.mask,
      nextHop: route.nextHop === undefined || route.nextHop.length === 0
        ? null : route.nextHop,
      iface: route.iface,
      metric: route.metric,
      type: route.kind,
    })));
    const listeners = this.sources.tcp().listListeners()
      .map(entry => ({ ip: entry.localIp, port: entry.localPort }));
    const sockets = this.sources.tcp().listSockets().map(socket => ({
      localIp: socket.localIp, localPort: socket.localPort,
      remoteIp: socket.remoteIp, remotePort: socket.remotePort,
      side: socket.passive ? 'server' as const : 'client' as const,
    }));

    this.store.arp.set(arp);
    this.store.routes.set(routes);
    this.store.tcpListeners.set(listeners);
    this.store.tcpConnections.set(sockets);
    this.store.stats.set({
      arpCacheSize: arp.length,
      ndpCacheSize: 0,
      routeCount: routes.length,
      tcpListeners: listeners.length,
      tcpConnections: sockets.length,
      icmpEchosSent: this.echosSent,
      icmpEchosReceived: this.echosReceived,
      icmpTimeouts: 0,
      arpRequestsSent: 0,
    });
  }
}
