export interface SnoopingMember {
  port: string;
  reporterIp: string;
  lastReportMs: number;
}

export interface SnoopingGroup {
  vlan: number;
  groupAddress: string;
  members: Map<string, SnoopingMember>;
}

export interface SnoopingVlanState {
  vlan: number;
  enabled: boolean;
  /**
   * `ip igmp snooping querier`: with no multicast router upstream, the
   * switch originates General Queries itself so hosts keep reporting.
   */
  querierEnabled: boolean;
  /** Active multicast-router ports: dynamically learned ∪ statically configured. */
  routerPorts: Set<string>;
  /**
   * Operator-configured mrouter ports. They are mirrored into
   * `routerPorts` but never aged out by the dynamic router-port timer,
   * and survive a link flap as configuration.
   */
  staticRouterPorts: Set<string>;
  groups: Map<string, SnoopingGroup>;
  querierIp: string | null;
  lastQuerierMs: number;
  /** When this switch last originated a General Query of its own. */
  lastSelfQueryMs: number | null;
}

export interface SnoopingConfig {
  enabled: boolean;
  perVlanDefault: boolean;
  vlans: Map<number, SnoopingVlanState>;
  immediateLeave: Set<number>;
  routerPortAgeSec: number;
  groupMembershipSec: number;
  /** Global `ip igmp snooping querier` switch. */
  querierEnabled: boolean;
  /** Source address the switch stamps on its own Queries. */
  querierAddress: string | null;
  /** IOS defaults the snooping querier to 60 s, not IGMP's own 125 s. */
  querierIntervalSec: number;
  querierMaxRespTimeDs: number;
  /** How long to wait for another querier before taking the role over. */
  otherQuerierPresentSec: number;
}

export function createDefaultSnoopingConfig(): SnoopingConfig {
  return {
    enabled: true, perVlanDefault: true,
    vlans: new Map(), immediateLeave: new Set(),
    routerPortAgeSec: 260,
    groupMembershipSec: 260,
    querierEnabled: false,
    querierAddress: null,
    querierIntervalSec: 60,
    querierMaxRespTimeDs: 100,
    otherQuerierPresentSec: 255,
  };
}

export function defaultVlanState(vlan: number): SnoopingVlanState {
  return {
    vlan, enabled: true,
    querierEnabled: false,
    routerPorts: new Set(),
    staticRouterPorts: new Set(),
    groups: new Map(),
    querierIp: null, lastQuerierMs: 0,
    lastSelfQueryMs: null,
  };
}

export function groupKey(group: string): string { return group; }
