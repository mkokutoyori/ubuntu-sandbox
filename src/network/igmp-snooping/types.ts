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
  routerPorts: Set<string>;
  groups: Map<string, SnoopingGroup>;
  querierIp: string | null;
  lastQuerierMs: number;
}

export interface SnoopingConfig {
  enabled: boolean;
  perVlanDefault: boolean;
  vlans: Map<number, SnoopingVlanState>;
  immediateLeave: Set<number>;
  routerPortAgeSec: number;
  groupMembershipSec: number;
}

export function createDefaultSnoopingConfig(): SnoopingConfig {
  return {
    enabled: true, perVlanDefault: true,
    vlans: new Map(), immediateLeave: new Set(),
    routerPortAgeSec: 260,
    groupMembershipSec: 260,
  };
}

export function defaultVlanState(vlan: number): SnoopingVlanState {
  return {
    vlan, enabled: true,
    routerPorts: new Set(),
    groups: new Map(),
    querierIp: null, lastQuerierMs: 0,
  };
}

export function groupKey(group: string): string { return group; }
