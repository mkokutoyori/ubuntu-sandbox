/**
 * OspfEngineAdapter — makes the frame-driven OSPF engine conform to
 * the shared IRoutingProtocolEngine contract + reactive read-model,
 * WITHOUT touching its real Hello/LSA/SPF core. Adapter pattern; the
 * projected state is the engine's REAL adjacency/SPF result.
 */
import { IPAddress, SubnetMask } from '../../core/types';
import type { RouterOSPFIntegration } from '../../devices/router/RouterOSPFIntegration';
import type { OSPFConfig } from '../../ospf/types';
import type { IRoutingProtocolEngine } from '../IRoutingProtocolEngine';
import type { RoutingPeerLocator, RoutingDeviceContext } from '../RoutingPeerLocator';
import {
  RoutingSignalStore, makeReadonlyRoutingObservables,
  type RoutingObservables,
} from '../observables';
import type {
  NeighborFsmState, ProtocolNeighborView, RibRoute,
} from '../types';

const OSPF_AD = 110;

function mapState(s: string): { state: NeighborFsmState; isUp: boolean } {
  if (s === 'Full') return { state: 'Established', isUp: true };
  if (s === '2-Way') return { state: 'Up', isUp: false };
  if (s === 'Down' || s === 'Attempt' || s === 'Init') {
    return { state: 'Down', isUp: false };
  }
  return { state: 'Connect', isUp: false };  // ExStart/Exchange/Loading
}

export class OspfEngineAdapter implements IRoutingProtocolEngine<OSPFConfig> {
  readonly protocol = 'ospf';
  private readonly store = new RoutingSignalStore();
  readonly observables: RoutingObservables =
    makeReadonlyRoutingObservables(this.store);
  private subscribed = false;

  constructor(private readonly ospf: () => RouterOSPFIntegration) {}

  // ── IProtocolEngine ──
  start(): void { this.enable(); }
  stop(): void { this.disable(); }
  isRunning(): boolean { return this.ospf().isOSPFEnabled(); }

  // ── IRoutingProtocolEngine ──
  enable(): void {
    this.ospf().enableOSPF();
    this.bindReactive();
    this.reproject();
  }
  disable(): void { this.ospf().disableOSPF(); this.reproject(); }
  isEnabled(): boolean { return this.ospf().isOSPFEnabled(); }
  getConfig(): OSPFConfig {
    return this.ospf().getOSPFEngine()?.getConfig() ?? ({} as OSPFConfig);
  }

  // OSPF discovers peers via real Hello packets — locator/device
  // seams don't apply (no-op by design).
  setPeerLocator(_l: RoutingPeerLocator): void { /* frame-driven */ }
  setDeviceContext(_c: RoutingDeviceContext): void { /* frame-driven */ }

  converge(): void { this.ospf().autoConverge(); this.reproject(); }

  getNeighbors(): ProtocolNeighborView[] {
    const eng = this.ospf().getOSPFEngine();
    if (!eng) return [];
    return eng.getNeighbors().map((n) => {
      const m = mapState(n.state);
      return {
        id: n.routerId, address: n.ipAddress, iface: n.iface,
        state: m.state, isUp: m.isUp, uptimeSec: 0, remoteId: n.routerId,
      };
    });
  }

  getContributedRoutes(): RibRoute[] {
    const eng = this.ospf().getOSPFEngine();
    if (!eng) return [];
    return eng.getRoutes().map((r) => ({
      network: new IPAddress(r.network),
      mask: new SubnetMask(r.mask),
      nextHop: r.nextHop ? new IPAddress(r.nextHop) : null,
      iface: r.iface,
      protocol: 'ospf',
      adminDistance: OSPF_AD,
      metric: r.metric,
    }));
  }

  /** Subscribe once to the engine's own Signals → fully reactive. */
  private bindReactive(): void {
    if (this.subscribed) return;
    const eng = this.ospf().getOSPFEngine();
    if (!eng) return;
    eng.observables.neighbors.subscribe(() => this.reproject());
    eng.observables.routes.subscribe(() => this.reproject());
    this.subscribed = true;
  }

  private reproject(): void {
    this.store.project(this.isEnabled(), this.getNeighbors(),
      this.getContributedRoutes());
  }
}
