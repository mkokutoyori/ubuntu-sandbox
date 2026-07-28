/**
 * PIM Snooping data model — the L2 counterpart of `igmp-snooping/types.ts`.
 *
 * Where IGMP snooping learns "this port has a *host* that reported group
 * G", PIM snooping learns "this port has a *PIM neighbour* that joined
 * group G": a PIM Hello plays the role of the IGMP Query (router-port
 * discovery) and a PIM Join/Prune plays the role of the Report/Leave.
 */

export interface PimSnoopingMember {
  port: string;
  /** Source address of the router whose Join was observed. */
  neighborIp: string;
  lastJoinMs: number;
  /** Holdtime the observed Join carried, in ms; the entry ages on it. */
  holdtimeMs: number;
}

export interface PimSnoopingGroup {
  vlan: number;
  /** Always a (*,G) group — (S,G) is out of scope on the router side too. */
  groupAddress: string;
  members: Map<string, PimSnoopingMember>;
}

export interface PimSnoopingNeighbor {
  port: string;
  neighborIp: string;
  lastHelloMs: number;
  /** Hello holdtime in ms, taken from the observed Hello option. */
  holdtimeMs: number;
}

export interface PimSnoopingVlanState {
  vlan: number;
  enabled: boolean;
  /** Ports where a PIM Hello was seen — learned, never configured. */
  routerPorts: Set<string>;
  neighbors: Map<string, PimSnoopingNeighbor>;
  groups: Map<string, PimSnoopingGroup>;
}

export interface PimSnoopingConfig {
  enabled: boolean;
  perVlanDefault: boolean;
  vlans: Map<number, PimSnoopingVlanState>;
  /** Fallback age for a neighbour whose Hello carried no holdtime. */
  routerPortAgeSec: number;
  /** Fallback age for a Join whose body carried no holdtime. */
  groupMembershipSec: number;
}

export function createDefaultPimSnoopingConfig(): PimSnoopingConfig {
  return {
    // Unlike IGMP snooping, PIM snooping is off until configured — that
    // is how both Cisco and Huawei ship it.
    enabled: false,
    perVlanDefault: true,
    vlans: new Map(),
    routerPortAgeSec: 105,
    groupMembershipSec: 210,
  };
}

export function defaultPimSnoopingVlanState(vlan: number): PimSnoopingVlanState {
  return {
    vlan, enabled: true,
    routerPorts: new Set(),
    neighbors: new Map(),
    groups: new Map(),
  };
}

export function pimSnoopingNeighborKey(port: string, neighborIp: string): string {
  return `${port}|${neighborIp}`;
}
