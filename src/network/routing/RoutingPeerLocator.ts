/**
 * RoutingPeerLocator — Dependency-Inversion seam between a routing
 * engine and the topology. The engine never imports Router/Equipment;
 * it asks the locator "who is really cabled to me?" and forms
 * adjacencies only with peers that genuinely exist and run a
 * compatible protocol. SRP: discovery only, no protocol logic.
 */
import type { RoutingPeer } from './types';

export interface RoutingPeerLocator {
  /**
   * Real peers reachable over this device's up interfaces, derived
   * from the live Port/Cable graph. Empty for a lone device — which
   * is why a single configured router shows no neighbours (true).
   */
  locatePeers(): RoutingPeer[];
}

/** A locator that finds nothing (default for an isolated engine). */
export const NULL_PEER_LOCATOR: RoutingPeerLocator = {
  locatePeers: () => [],
};
