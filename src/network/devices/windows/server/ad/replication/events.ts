/**
 * AD replication — reactive event taxonomy (PRD-Windows-Server-Advanced.md
 * §5 P12), transverse to the USN/high-watermark pull model built in §5
 * P4/P6: one event per `replicateFrom` pull cycle (the puller's side) and
 * one per served pull request (the responder's side), mirroring the
 * established `dhcp.*`/`kerberos.*` `events.ts` convention.
 */

export interface ReplicationDcRef {
  /** Device id of the DC this event is about. */
  deviceId: string;
  invocationId: string;
}

export interface ReplicationPullCompletedPayload extends ReplicationDcRef {
  partnerAddress: string;
  applied: number;
  siteRelation: 'intra-site' | 'inter-site';
}

export interface ReplicationPullFailedPayload extends ReplicationDcRef {
  partnerAddress: string;
  error: string;
  siteRelation: 'intra-site' | 'inter-site';
}

export interface ReplicationServedPayload extends ReplicationDcRef {
  changesSent: number;
  partnerAddress: string;
  siteRelation: 'intra-site' | 'inter-site';
}

export type ReplicationDomainEvent =
  | { topic: 'replication.pull.completed'; payload: ReplicationPullCompletedPayload }
  | { topic: 'replication.pull.failed'; payload: ReplicationPullFailedPayload }
  | { topic: 'replication.served'; payload: ReplicationServedPayload };
