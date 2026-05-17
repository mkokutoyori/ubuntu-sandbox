/**
 * Shared value types for every dynamic routing-protocol engine.
 *
 * Kept deliberately small and protocol-neutral so BGP / EIGRP / (and
 * later OSPF/RIP, if refactored) all speak the same vocabulary to the
 * Router RIB and the reactive read-models. Single Responsibility: this
 * file only declares data shapes — no behaviour.
 */
import type { IPAddress, SubnetMask } from '../core/types';

/**
 * A route an engine contributes to the Router RIB. The Router compares
 * `adminDistance` then `metric` to arbitrate between protocols.
 */
export interface RibRoute {
  readonly network: IPAddress;
  readonly mask: SubnetMask;
  readonly nextHop: IPAddress | null;
  readonly iface: string;
  /** Protocol tag for `show ip route` (e.g. 'bgp', 'eigrp'). */
  readonly protocol: string;
  readonly adminDistance: number;
  readonly metric: number;
}

/** Generic neighbour/peer FSM state (superset across protocols). */
export type NeighborFsmState =
  | 'Idle' | 'Down' | 'Connect' | 'Active' | 'Pending'
  | 'OpenSent' | 'OpenConfirm' | 'Established' | 'Up';

/** Read-model of one protocol neighbour (for `show … neighbors`). */
export interface ProtocolNeighborView {
  /** Stable identity (peer IP, or router-id). */
  readonly id: string;
  readonly address: string;
  readonly iface: string;
  readonly state: NeighborFsmState;
  readonly isUp: boolean;
  readonly uptimeSec: number;
  readonly remoteId?: string;
}

/**
 * A real, cabled peer discovered from the topology. The engine decides
 * whether an adjacency forms by checking the peer's same-protocol
 * engine + config compatibility — this is what makes adjacency
 * genuinely config-driven rather than fabricated.
 */
export interface RoutingPeer {
  readonly deviceId: string;
  readonly hostname: string;
  readonly localIface: string;
  readonly localIp: IPAddress | null;
  readonly remoteIface: string;
  readonly remoteIp: IPAddress | null;
  /** The peer device's engine for `protocol`, if it runs one. */
  peerEngineFor(protocol: string): unknown | null;
}
