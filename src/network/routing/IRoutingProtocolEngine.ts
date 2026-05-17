/**
 * IRoutingProtocolEngine — the contract every dynamic routing-protocol
 * engine (BGP, EIGRP, …) honours, on top of the generic
 * IProtocolEngine lifecycle. Kept minimal (Interface Segregation):
 * config in, neighbours + RIB contribution out, plus a reactive
 * read-model. The Router integration adapter is the only consumer.
 */
import type { IProtocolEngine } from '../core/interfaces';
import type { RoutingPeerLocator } from './RoutingPeerLocator';
import type { RoutingObservables } from './observables';
import type { ProtocolNeighborView, RibRoute } from './types';

export interface IRoutingProtocolEngine<TConfig> extends IProtocolEngine {
  /** Protocol tag used in the RIB / show output ('bgp', 'eigrp'…). */
  readonly protocol: string;

  /** Enable (idempotent) with optional partial config. */
  enable(config?: Partial<TConfig>): void;
  disable(): void;
  isEnabled(): boolean;

  /** The real configuration currently driving the engine. */
  getConfig(): TConfig;

  /** Inject the topology seam used to discover real peers. */
  setPeerLocator(locator: RoutingPeerLocator): void;

  /**
   * Recompute adjacencies + routes from the current real config and
   * the real cabled peers. Called when config or topology changes.
   */
  converge(): void;

  /** Neighbours as projected for `show … neighbors`. */
  getNeighbors(): ProtocolNeighborView[];

  /** Routes offered to the Router RIB (with AD + metric). */
  getContributedRoutes(): RibRoute[];

  /** Reactive read-models (Signals); subscribe, never poll. */
  readonly observables: RoutingObservables;
}
