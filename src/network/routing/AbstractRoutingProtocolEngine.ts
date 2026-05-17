/**
 * AbstractRoutingProtocolEngine — Template Method base for BGP/EIGRP.
 *
 * Owns the cross-cutting concerns once (lifecycle, enable/disable,
 * peer-locator seam, neighbour table, reactive projection + optional
 * event bus). Subclasses implement ONLY the protocol-specific bits via
 * three small hooks — keeping concrete engines lightweight and
 * Single-Responsibility:
 *
 *   defaultConfig()              → the protocol's real default config
 *   computeNeighbors(peers)      → adjacency decision (config-driven)
 *   computeRoutes(peers)         → RIB contribution from real config
 *
 * Reactive: every converge() re-projects the Signal store and (if a
 * bus is wired) publishes a lifecycle event. No polling anywhere.
 */
import type { IEventBus } from '@/events/EventBus';
import type { IRoutingProtocolEngine } from './IRoutingProtocolEngine';
import {
  type RoutingPeerLocator, NULL_PEER_LOCATOR,
} from './RoutingPeerLocator';
import {
  RoutingSignalStore, makeReadonlyRoutingObservables,
  type RoutingObservables,
} from './observables';
import { RoutingNeighborTable } from './RoutingNeighborTable';
import type { ProtocolNeighborView, RibRoute, RoutingPeer } from './types';

export abstract class AbstractRoutingProtocolEngine<TConfig>
implements IRoutingProtocolEngine<TConfig> {
  abstract readonly protocol: string;

  protected config: TConfig;
  protected readonly neighbors = new RoutingNeighborTable();
  private enabled = false;
  private locator: RoutingPeerLocator = NULL_PEER_LOCATOR;
  private bus: IEventBus | null = null;
  private routes: RibRoute[] = [];

  private readonly store = new RoutingSignalStore();
  readonly observables: RoutingObservables =
    makeReadonlyRoutingObservables(this.store);

  constructor(protected readonly deviceId: string) {
    this.config = this.defaultConfig();
    // Re-project whenever the neighbour table mutates (reactive).
    this.neighbors.onChange(() => this.reproject());
  }

  // ── Template-method hooks (protocol-specific, small) ─────────────
  protected abstract defaultConfig(): TConfig;
  protected abstract computeNeighbors(peers: RoutingPeer[]): void;
  protected abstract computeRoutes(peers: RoutingPeer[]): RibRoute[];
  /** Optional: validate/normalise a partial config merge. */
  protected mergeConfig(patch: Partial<TConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  // ── IProtocolEngine ──────────────────────────────────────────────
  start(): void { this.enable(); }
  stop(): void { this.disable(); }
  isRunning(): boolean { return this.enabled; }

  // ── IRoutingProtocolEngine ───────────────────────────────────────
  enable(config?: Partial<TConfig>): void {
    if (config) this.mergeConfig(config);
    if (!this.enabled) {
      this.enabled = true;
      this.publish('started');
    }
    this.converge();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.neighbors.clear();
    this.routes = [];
    this.reproject();
    this.publish('stopped');
  }

  isEnabled(): boolean { return this.enabled; }
  getConfig(): TConfig { return this.config; }

  setPeerLocator(locator: RoutingPeerLocator): void {
    this.locator = locator;
  }

  /** Wire the reactive event bus (optional; observables work without). */
  setBus(bus: IEventBus | null): void { this.bus = bus; }

  converge(): void {
    if (!this.enabled) { this.reproject(); return; }
    const peers = this.locator.locatePeers();
    this.computeNeighbors(peers);          // mutates neighbour table
    this.routes = this.computeRoutes(peers);
    this.reproject();
  }

  getNeighbors(): ProtocolNeighborView[] { return this.neighbors.view(); }
  getContributedRoutes(): RibRoute[] {
    return this.enabled ? this.routes : [];
  }

  // ── internals ────────────────────────────────────────────────────
  private reproject(): void {
    this.store.project(this.enabled, this.neighbors.view(),
      this.enabled ? this.routes : []);
  }

  private publish(kind: 'started' | 'stopped'): void {
    // Bus is optional and protocol-specific events are added by
    // concrete engines; the base only signals lifecycle so the
    // foundation stays decoupled from the global event union.
    this.bus?.publish({
      topic: `routing:${this.protocol}:${kind}`,
      deviceId: this.deviceId,
    } as never);
  }
}
