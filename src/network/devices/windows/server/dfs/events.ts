/**
 * DFSR — reactive event taxonomy (PRD-Windows-Server-Advanced.md §5 P23),
 * transverse to §5 P16: each `Sync-DfsReplicationGroup` pull cycle
 * publishes through this topic, mirroring `replication.pull.completed/
 * failed`'s own shape (§5 P12) — DFSR reuses AD replication's USN/high-
 * watermark patron, and now its observability convention too.
 */

export interface DfsReplicationSyncedPayload {
  deviceId: string;
  groupName: string;
  filesApplied: number;
}
export interface DfsReplicationFailedPayload {
  deviceId: string;
  groupName: string;
  error: string;
}

export type DfsDomainEvent =
  | { topic: 'dfs.replication.synced'; payload: DfsReplicationSyncedPayload }
  | { topic: 'dfs.replication.failed'; payload: DfsReplicationFailedPayload };
