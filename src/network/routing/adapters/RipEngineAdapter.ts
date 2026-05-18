/**
 * RipEngineAdapter — makes the frame-driven RouterRIPEngine conform to
 * the shared IRoutingProtocolEngine contract + reactive read-model,
 * WITHOUT touching its real RIPv2 packet/timer core.
 *
 * Adapter pattern: consistency is achieved at the contract +
 * observable level (so the Router treats every routing protocol
 * uniformly), not by forcing a frame-driven engine into the
 * Template-Method shape it doesn't fit (Liskov-clean). Output stays
 * the engine's REAL learned state — never fabricated.
 */
import { IPAddress, SubnetMask } from '../../core/types';
import type { RouterRIPEngine, RIPConfig } from '../../devices/router/RouterRIPEngine';
import type { IRoutingProtocolEngine } from '../IRoutingProtocolEngine';
import type { RoutingPeerLocator, RoutingDeviceContext } from '../RoutingPeerLocator';
import {
  RoutingSignalStore, makeReadonlyRoutingObservables,
  type RoutingObservables,
} from '../observables';
import type { ProtocolNeighborView, RibRoute } from '../types';

const RIP_AD = 120;

export class RipEngineAdapter implements IRoutingProtocolEngine<RIPConfig> {
  readonly protocol = 'rip';
  private readonly store = new RoutingSignalStore();
  readonly observables: RoutingObservables =
    makeReadonlyRoutingObservables(this.store);

  constructor(private readonly rip: RouterRIPEngine) {}

  // ── IProtocolEngine ──
  start(): void { this.enable(); }
  stop(): void { this.disable(); }
  isRunning(): boolean { return this.rip.isEnabled(); }

  // ── IRoutingProtocolEngine ──
  enable(config?: Partial<RIPConfig>): void {
    this.rip.enable(config);
    this.reproject();
  }
  disable(): void { this.rip.disable(); this.reproject(); }
  isEnabled(): boolean { return this.rip.isEnabled(); }
  getConfig(): RIPConfig { return this.rip.getConfig(); }

  // RIP discovers peers via real RIPv2 frames/timers — the topology
  // locator/device-context seams don't apply (no-op by design).
  setPeerLocator(_l: RoutingPeerLocator): void { /* frame-driven */ }
  setDeviceContext(_c: RoutingDeviceContext): void { /* frame-driven */ }

  /** RIP self-converges on its update timer; just re-project state. */
  converge(): void { this.reproject(); }

  getNeighbors(): ProtocolNeighborView[] {
    const seen = new Map<string, ProtocolNeighborView>();
    for (const r of this.rip.getRoutes().values()) {
      if (!r.learnedFrom || seen.has(r.learnedFrom)) continue;
      seen.set(r.learnedFrom, {
        id: r.learnedFrom, address: r.learnedFrom, iface: '',
        state: 'Up', isUp: true, uptimeSec: r.age,
      });
    }
    return [...seen.values()];
  }

  getContributedRoutes(): RibRoute[] {
    if (!this.rip.isEnabled()) return [];
    const out: RibRoute[] = [];
    for (const [key, r] of this.rip.getRoutes()) {
      const [net, cidr] = key.split('/');
      out.push({
        network: new IPAddress(net),
        mask: SubnetMask.fromCIDR(Number(cidr) || 24),
        nextHop: r.learnedFrom ? new IPAddress(r.learnedFrom) : null,
        iface: '',
        protocol: 'rip',
        adminDistance: RIP_AD,
        metric: r.metric,
      });
    }
    return out;
  }

  private reproject(): void {
    this.store.project(this.rip.isEnabled(), this.getNeighbors(),
      this.getContributedRoutes());
  }
}
