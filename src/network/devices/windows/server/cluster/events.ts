/**
 * WSFC cluster — reactive event taxonomy (PRD-Windows-Server-Advanced.md
 * §5 P23), transverse to §5 P18: node liveness transitions (detected from
 * real UDP heartbeat traffic) and resource-group ownership changes
 * (manual `Move-ClusterGroup` or automatic failover) publish through this
 * topic — mirrors the established `kerberos.*`/`replication.*` convention
 * (§5 P12).
 */

export interface ClusterNodeStateChangedPayload {
  deviceId: string;
  clusterName: string;
  nodeName: string;
}
export interface ClusterGroupMovedPayload {
  deviceId: string;
  clusterName: string;
  groupName: string;
  fromNode: string | null;
  toNode: string;
}

export type ClusterDomainEvent =
  | { topic: 'cluster.node.up'; payload: ClusterNodeStateChangedPayload }
  | { topic: 'cluster.node.down'; payload: ClusterNodeStateChangedPayload }
  | { topic: 'cluster.group.moved'; payload: ClusterGroupMovedPayload };
