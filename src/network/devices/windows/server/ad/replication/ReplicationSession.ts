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
import type { EntryReplMeta } from '../ldap/DirectoryTree';
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
  stamp: EntryReplMeta;
}
interface ReplicationPullResponse {
  kind: 'pullResponse';
  responderInvocationId: string;
  changes: ReplicatedObject[];
}
/** `repadmin /syncall ... /P` (push mode): the source DC notifies a partner to pull from it right now, instead of waiting for that partner's own schedule. */
interface ReplicationSyncNotify {
  kind: 'syncNotify';
}
interface ReplicationSyncNotifyAck {
  kind: 'syncNotifyAck';
  ok: boolean;
}

export class ReplicationServerHandler {
  /**
   * `deviceId`/`bus` (PRD-Windows-Server-Advanced.md §5 P12) are optional —
   * omitted keeps behavior identical to before this phase. This handler
   * only publishes `replication.served`; a `ReplicationSignalRefreshActor`
   * subscribing elsewhere is what feeds a `ReplicationSignalStore`.
   * `ownIp` lets it annotate the served entry's site relation the same way
   * `replicateFrom` does on the puller side — omitted, it just skips that
   * (defaults to intra-site).
   */
  constructor(
    private readonly store: DirectoryStore,
    private readonly deviceId?: string,
    private readonly bus: IEventBus = getDefaultEventBus(),
    private readonly ownIp?: string,
    /** `repadmin /syncall ... /P` (push mode) handling — called with the notifying partner's address so this DC can pull from it right away. Omitted, syncNotify messages are ignored (this DC doesn't support being pushed to). */
    private readonly onSyncNotify?: (partnerIp: string) => void,
  ) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let msg: ReplicationPullRequest | ReplicationSyncNotify;
      try { msg = JSON.parse(new TextDecoder().decode(data)) as ReplicationPullRequest | ReplicationSyncNotify; } catch { return; }

      if (msg.kind === 'syncNotify') {
        this.onSyncNotify?.(socket.remoteIp);
        const ack: ReplicationSyncNotifyAck = { kind: 'syncNotifyAck', ok: true };
        socket.send(new TextEncoder().encode(JSON.stringify(ack)));
        return;
      }
      if (msg.kind !== 'pullRequest') return;

      const requesterVector = decodeHighWatermarkVector(msg.requesterVector);
      const changes: ReplicatedObject[] = this.store.changesSince(requesterVector).map((entry) => ({
        dn: formatDN(entry.dn),
        attributes: Object.fromEntries(entry.attributes),
        stamp: entry.replMeta!,
      }));
      const response: ReplicationPullResponse = {
        kind: 'pullResponse', responderInvocationId: this.store.getInvocationId(), changes,
      };
      socket.send(new TextEncoder().encode(JSON.stringify(response)));

      const partnerAddress = socket.remoteIp;
      const partnerSite = this.store.siteForIp(partnerAddress);
      const ownSite = this.ownIp ? this.store.siteForIp(this.ownIp) : null;
      const siteRelation: 'intra-site' | 'inter-site' =
        ownSite !== null && partnerSite !== null && ownSite !== partnerSite ? 'inter-site' : 'intra-site';

      this.bus.publish({
        topic: 'replication.served',
        payload: {
          deviceId: this.deviceId ?? this.store.dnsName, invocationId: this.store.getInvocationId(),
          changesSent: changes.length, partnerAddress, siteRelation,
        },
      });
    });
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
  /** 'inbound': this DC pulled from partnerAddress. 'outbound': this DC served a pull request from partnerAddress. Optional for callers predating this field (defaults to 'inbound', the only direction until §5 P12's served-side tracking). */
  readonly direction?: 'inbound' | 'outbound';
  /** Set when `ok` is false — the reason the pull failed (`Get-ADReplicationFailure`'s LastError). */
  readonly error?: string;
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
  for (const change of response.changes) localStore.applyReplicatedEntry(change.dn, change.attributes, change.stamp);
  return { ok: true, applied: response.changes.length };
}

/**
 * `repadmin /syncall ... /P` (push mode): dial `partnerIp`'s TCP/135 and
 * tell it to pull from us right now, instead of pulling changes ourselves.
 * The partner's `ReplicationServerHandler.onSyncNotify` hook is what
 * actually performs that pull.
 */
export function notifySyncNow(tcpStack: TcpStack, partnerIp: string): { ok: boolean; error?: string } {
  const socket = tcpStack.connect(partnerIp, AD_REPLICATION_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: "A local error occurred (Can't contact the replication partner)" };
  }
  let ack: ReplicationSyncNotifyAck | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { ack = JSON.parse(new TextDecoder().decode(data)) as ReplicationSyncNotifyAck; } catch { /* ignore malformed */ }
  });
  const notify: ReplicationSyncNotify = { kind: 'syncNotify' };
  socket.send(new TextEncoder().encode(JSON.stringify(notify)));
  unsubscribe();
  if (!ack || (ack as ReplicationSyncNotifyAck).kind !== 'syncNotifyAck') return { ok: false, error: 'no reply from replication partner' };
  return { ok: true };
}
