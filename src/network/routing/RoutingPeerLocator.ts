/**
 * RoutingPeerLocator — Dependency-Inversion seam between a routing
 * engine and the topology. The engine never imports Router/Equipment;
 * it asks the locator "who is really cabled to me?" and forms
 * adjacencies only with peers that genuinely exist and run a
 * compatible protocol. SRP: discovery only, no protocol logic.
 */
import type { IPAddress, SubnetMask } from '../core/types';
import type { RoutingPeer } from './types';

/** One directly-connected (configured) network on this device. */
export interface ConnectedNetwork {
  readonly network: IPAddress;
  readonly mask: SubnetMask;
  readonly iface: string;
  /** The interface's own IP (used as next-hop by a learning peer). */
  readonly localIp: IPAddress;
}

/**
 * Device-side DI seam (mirrors RIPCallbacks): lets an engine read its
 * own real connected networks without importing Router. SRP: data
 * only.
 */
export interface RoutingDeviceContext {
  connectedNetworks(): ConnectedNetwork[];
}

/** Device context that exposes nothing (isolated engine default). */
export const NULL_DEVICE_CONTEXT: RoutingDeviceContext = {
  connectedNetworks: () => [],
};

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
