/**
 * ReplicationSession — multi-DC AD replication (PRD-Windows-Server-
 * Advanced.md §5 P4, inspired by MS-DRSR — a Microsoft-proprietary RPC
 * spec this simulator doesn't reproduce byte-for-byte, so the wire
 * payload is a JSON PDU over a real TCP/135 connection, the same
 * convention `SmbServerHandler`/`WinRmServerHandler` use for their own
 * JSON-over-TCP protocols, rather than a byte-exact DRSUAPI encoding).
 *
 * Pull model: a DC dials a partner, sends its own high-watermark vector,
 * and the partner returns every entry it hasn't seen yet — a "cycle of
 * replication", triggered manually or on an interval by the caller (no
 * KCC/automatic topology computation modeled, per PRD §2.2 scope).
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { DirectoryStore } from '../DirectoryStore';
import { type EntryReplMetaWire, encodeEntryReplMeta, decodeEntryReplMeta } from '../ldap/DirectoryTree';
import { formatDN } from '../ldap/LdapDN';
import {
  type HighWatermarkVectorWire, encodeHighWatermarkVector, decodeHighWatermarkVector,
} from './HighWatermarkVector';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';

export const AD_REPLICATION_PORT = 135;

interface ReplicationPullRequest {
  kind: 'pullRequest';
  requesterVector: HighWatermarkVectorWire;
}
interface ReplicatedObject {
  dn: string;
  attributes: Record<string, string[]>;
  stamp: EntryReplMetaWire;
}
interface ReplicationPullResponse {
  kind: 'pullResponse';
  responderInvocationId: string;
  changes: ReplicatedObject[];
}
interface RidPoolRequestMsg { kind: 'ridPoolRequest'; poolSize: number }
interface RidPoolResponseMsg { kind: 'ridPoolResponse'; ok: boolean; startRid?: number; count?: number; message?: string }

export class ReplicationServerHandler {
  /**
   * `deviceId`/`bus` (PRD-Windows-Server-Advanced.md §5 P12) are optional —
   * omitted keeps behavior identical to before this phase. This handler
   * only publishes `replication.served`; a `ReplicationSignalRefreshActor`
   * subscribing elsewhere is what feeds a `ReplicationSignalStore`.
   */
  constructor(
    private readonly store: DirectoryStore,
    private readonly deviceId?: string,
    private readonly bus: IEventBus = getDefaultEventBus(),
  ) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let msg: ReplicationPullRequest | RidPoolRequestMsg;
      try { msg = JSON.parse(new TextDecoder().decode(data)) as ReplicationPullRequest | RidPoolRequestMsg; } catch { return; }

      if (msg.kind === 'ridPoolRequest') {
        this.handleRidPoolRequest(socket, msg);
        return;
      }
      if (msg.kind !== 'pullRequest') return;

      const requesterVector = decodeHighWatermarkVector(msg.requesterVector);
      const changes: ReplicatedObject[] = this.store.changesSince(requesterVector).map((entry) => ({
        dn: formatDN(entry.dn),
        attributes: Object.fromEntries(entry.attributes),
        stamp: encodeEntryReplMeta(entry.replMeta!),
      }));
      const response: ReplicationPullResponse = {
        kind: 'pullResponse', responderInvocationId: this.store.getInvocationId(), changes,
      };
      socket.send(new TextEncoder().encode(JSON.stringify(response)));

      this.bus.publish({
        topic: 'replication.served',
        payload: { deviceId: this.deviceId ?? this.store.dnsName, invocationId: this.store.getInvocationId(), changesSent: changes.length },
      });
    });
  }

  /** `IDL_DRSAllocateRIDs`-lite — refuses unless this DC currently holds the RID Master role. */
  private handleRidPoolRequest(socket: TcpSocket, msg: RidPoolRequestMsg): void {
    const isRidMaster = this.deviceId !== undefined && this.store.getFsmoRoleOwner('RidMaster') === this.deviceId;
    if (!isRidMaster) {
      const response: RidPoolResponseMsg = { kind: 'ridPoolResponse', ok: false, message: 'this DC does not hold the RID Master role' };
      socket.send(new TextEncoder().encode(JSON.stringify(response)));
      return;
    }
    const { startRid, count } = this.store.grantRidPoolBlock(msg.poolSize);
    const response: RidPoolResponseMsg = { kind: 'ridPoolResponse', ok: true, startRid, count };
    socket.send(new TextEncoder().encode(JSON.stringify(response)));
  }
}

export interface ReplicationPullResult {
  ok: boolean;
  error?: string;
  /** Number of objects the partner sent and this DC applied. */
  applied: number;
}

/** PRD-Windows-Server-Advanced.md §5 P6 — one past replication cycle, annotated by site (a minimal stand-in for a real replication event log; full observability arrives at §5 P12). */
export interface ReplicationLogEntry {
  readonly timestamp: number;
  readonly partnerAddress: string;
  readonly applied: number;
  readonly ok: boolean;
  readonly siteRelation: 'intra-site' | 'inter-site';
}

/**
 * One replication cycle: dial `partnerIp`'s TCP/135, send this DC's
 * outbound high-watermark vector, and apply every object the partner
 * returns — advancing this DC's record of how caught-up it is with the
 * partner (and, transitively, any DC the partner had already absorbed).
 */
export function pullReplication(tcpStack: TcpStack, partnerIp: string, localStore: DirectoryStore): ReplicationPullResult {
  const socket = tcpStack.connect(partnerIp, AD_REPLICATION_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: "A local error occurred (Can't contact the replication partner)", applied: 0 };
  }

  let response: ReplicationPullResponse | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { response = JSON.parse(new TextDecoder().decode(data)) as ReplicationPullResponse; } catch { /* ignore malformed */ }
  });
  const request: ReplicationPullRequest = { kind: 'pullRequest', requesterVector: encodeHighWatermarkVector(localStore.getOutboundHighWatermark()) };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();

  if (!response || response.kind !== 'pullResponse') return { ok: false, error: 'no reply from replication partner', applied: 0 };
  for (const change of response.changes) localStore.applyReplicatedEntry(change.dn, change.attributes, decodeEntryReplMeta(change.stamp));
  return { ok: true, applied: response.changes.length };
}
