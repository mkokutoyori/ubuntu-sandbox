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
import { type IEventBus } from '@/events/EventBus';
import { detachedBus } from '@/events/BusHolder';

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
  /** PRD-Repadmin.md P8: set when the responder has `DISABLE_OUTBOUND_REPL` posed — `changes` is always empty alongside this. */
  error?: string;
}
/** `repadmin /syncall ... /P` (push mode): the source DC notifies a partner to pull from it right now, instead of waiting for that partner's own schedule. */
interface ReplicationSyncNotify {
  kind: 'syncNotify';
}
interface ReplicationSyncNotifyAck {
  kind: 'syncNotifyAck';
  ok: boolean;
}
/** PRD-Repadmin.md P1: a remote `repadmin` dial asking a DC for its own replication status, so `/showrepl`/`/showconn`/`/showvector`/etc. run against a named DC report THAT DC's real state rather than the caller's. */
interface ReplicationStatusRequest {
  kind: 'statusRequest';
  /** PRD-Repadmin.md P6: `/showobjmeta <DC> <ObjectDN>` against a remote DC reuses this same PDU rather than adding a second one (§3 — "un seul point d'extension de protocole"). */
  objectDn?: string;
}
interface ReplicationStatusResponse {
  kind: 'statusResponse';
  fqdn: string;
  invocationId: string;
  log: ReplicationLogEntry[];
  outboundVector: HighWatermarkVectorWire;
  /** Set when the request carried `objectDn`: the object's replication stamp, or `null` if no such object exists on this DC. */
  objectMeta?: EntryReplMeta | null;
}
/** PRD-Repadmin.md P8: `repadmin /options <DC> +|-OPTION` where `<DC>` is a remote DC — sets the option directly on that DC's own `ntdsOptions`. */
interface ReplicationSetOptionRequest {
  kind: 'setOptionRequest';
  option: string;
  enabled: boolean;
}
interface ReplicationSetOptionAck {
  kind: 'setOptionAck';
  ok: boolean;
}
/** PRD-Repadmin.md P3: `repadmin /replicate <DestDC> <SourceDC> <NC>` where `<DestDC>` is a remote DC — tells it to pull from `sourceIp` right now (distinct from `syncNotify`, which always means "pull from whoever is notifying you"). */
interface ReplicationTriggerPull {
  kind: 'triggerPull';
  sourceIp: string;
}
interface ReplicationTriggerPullAck {
  kind: 'triggerPullAck';
  ok: boolean;
  applied: number;
  error?: string;
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
    private readonly bus: IEventBus = detachedBus(),
    private readonly ownIp?: string,
    /** `repadmin /syncall ... /P` (push mode) handling — called with the notifying partner's address so this DC can pull from it right away. Omitted, syncNotify messages are ignored (this DC doesn't support being pushed to). */
    private readonly onSyncNotify?: (partnerIp: string) => void,
    /** PRD-Repadmin.md P1: answers a remote `repadmin`'s `statusRequest` with this DC's own replication log — omitted, statusRequest messages are ignored (a remote `repadmin` targeting this DC gets `Unable to contact target`). */
    private readonly getLog?: () => readonly ReplicationLogEntry[],
    /** PRD-Repadmin.md P8: `DISABLE_OUTBOUND_REPL` — when true, a `pullRequest` from any partner is refused with the real error message rather than served. Omitted/false: unchanged behavior. */
    private readonly isOutboundReplDisabled?: () => boolean,
    /** PRD-Repadmin.md P3: `repadmin /replicate <DestDC> <SourceDC> <NC>` when this DC is `<DestDC>` — called with `sourceIp` so this DC pulls from that specific partner right now, regardless of who dialed in. Omitted, triggerPull messages are ignored. */
    private readonly onTriggerPull?: (sourceIp: string) => ReplicationPullResult,
    /** PRD-Repadmin.md P6: answers `statusRequest`'s optional `objectDn` with that object's replication stamp (`null` if it doesn't exist on this DC). Omitted, `objectDn` requests always answer `null`. */
    private readonly getObjectMeta?: (dn: string) => EntryReplMeta | null,
    /** PRD-Repadmin.md P8: applies a remote `/options <DC> +|-OPTION` directly to this DC's own option set. Omitted, setOptionRequest messages are refused. */
    private readonly onSetOption?: (option: string, enabled: boolean) => boolean,
  ) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let msg: ReplicationPullRequest | ReplicationSyncNotify | ReplicationStatusRequest | ReplicationTriggerPull | ReplicationSetOptionRequest;
      try {
        msg = JSON.parse(new TextDecoder().decode(data)) as
          ReplicationPullRequest | ReplicationSyncNotify | ReplicationStatusRequest | ReplicationTriggerPull | ReplicationSetOptionRequest;
      } catch { return; }

      if (msg.kind === 'syncNotify') {
        this.onSyncNotify?.(socket.remoteIp);
        const ack: ReplicationSyncNotifyAck = { kind: 'syncNotifyAck', ok: true };
        socket.send(new TextEncoder().encode(JSON.stringify(ack)));
        return;
      }
      if (msg.kind === 'triggerPull') {
        const result = this.onTriggerPull?.(msg.sourceIp) ?? { ok: false, error: 'this DC does not support remote-triggered replication', applied: 0 };
        const ack: ReplicationTriggerPullAck = { kind: 'triggerPullAck', ok: result.ok, applied: result.applied, error: result.error };
        socket.send(new TextEncoder().encode(JSON.stringify(ack)));
        return;
      }
      if (msg.kind === 'statusRequest') {
        const hostname = this.deviceId ?? this.store.dnsName.split('.')[0];
        const response: ReplicationStatusResponse = {
          kind: 'statusResponse',
          fqdn: `${hostname}.${this.store.dnsName}`,
          invocationId: this.store.getInvocationId(),
          log: [...(this.getLog?.() ?? [])],
          outboundVector: encodeHighWatermarkVector(this.store.getOutboundHighWatermark()),
          objectMeta: msg.objectDn !== undefined ? (this.getObjectMeta?.(msg.objectDn) ?? null) : undefined,
        };
        socket.send(new TextEncoder().encode(JSON.stringify(response)));
        return;
      }
      if (msg.kind === 'setOptionRequest') {
        const ok = this.onSetOption?.(msg.option, msg.enabled) ?? false;
        const ack: ReplicationSetOptionAck = { kind: 'setOptionAck', ok };
        socket.send(new TextEncoder().encode(JSON.stringify(ack)));
        return;
      }
      if (msg.kind !== 'pullRequest') return;

      if (this.isOutboundReplDisabled?.()) {
        const response: ReplicationPullResponse = {
          kind: 'pullResponse', responderInvocationId: this.store.getInvocationId(), changes: [],
          error: 'Replication is disabled',
        };
        socket.send(new TextEncoder().encode(JSON.stringify(response)));
        return;
      }

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
  /** PRD-Repadmin.md P2: the partner's invocationID, as returned in the pull response — lets the caller look up how caught-up it now is with that specific partner (`DirectoryStore.highestKnownUsnFor`) for `/showrepl`'s USN column. Unset on failure. */
  responderInvocationId?: string;
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
  /** PRD-Repadmin.md P2: the partner's invocationID, when this entry is an inbound pull that got a real reply — `/showrepl`'s USN column looks up `DirectoryStore.highestKnownUsnFor(remoteInvocationId)` with it. */
  readonly remoteInvocationId?: string;
}

/**
 * One replication cycle: dial `partnerIp`'s TCP/135, send this DC's
 * outbound high-watermark vector, and apply every object the partner
 * returns — advancing this DC's record of how caught-up it is with the
 * partner (and, transitively, any DC the partner had already absorbed).
 */
export function pullReplication(
  tcpStack: TcpStack, partnerIp: string, localStore: DirectoryStore,
  /** PRD-Repadmin.md P8: `DISABLE_INBOUND_REPL` posed locally — the dial and exchange still happen (a real network round trip), but the received changes are discarded rather than applied. */
  opts: { inboundReplDisabled?: boolean } = {},
): ReplicationPullResult {
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
  if (response.error) return { ok: false, error: response.error, applied: 0 };
  if (opts.inboundReplDisabled) return { ok: false, error: 'Inbound replication is disabled', applied: 0 };
  for (const change of response.changes) localStore.applyReplicatedEntry(change.dn, change.attributes, change.stamp);
  return { ok: true, applied: response.changes.length, responderInvocationId: response.responderInvocationId };
}

/**
 * PRD-Repadmin.md P1: dial `targetIp`'s TCP/135 and ask it for its own
 * replication status — the real-wire mechanism a remote `repadmin`
 * targeting a named DC uses instead of reading the caller's own local
 * state under a different label.
 */
export interface RemoteReplicationStatus {
  fqdn: string;
  invocationId: string;
  log: ReplicationLogEntry[];
  outboundVector: HighWatermarkVectorWire;
  /** Set only when the call passed `objectDn`: that object's replication stamp, or `null` if it doesn't exist on the target DC. */
  objectMeta?: EntryReplMeta | null;
}

export function queryRemoteReplicationStatus(
  tcpStack: TcpStack, targetIp: string, objectDn?: string,
): RemoteReplicationStatus | null {
  const socket = tcpStack.connect(targetIp, AD_REPLICATION_PORT);
  if (!socket || socket.state !== 'established') return null;

  let response: ReplicationStatusResponse | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { response = JSON.parse(new TextDecoder().decode(data)) as ReplicationStatusResponse; } catch { /* ignore malformed */ }
  });
  const request: ReplicationStatusRequest = { kind: 'statusRequest', objectDn };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();

  if (!response || (response as ReplicationStatusResponse).kind !== 'statusResponse') return null;
  const ok = response as ReplicationStatusResponse;
  return { fqdn: ok.fqdn, invocationId: ok.invocationId, log: ok.log, outboundVector: ok.outboundVector, objectMeta: ok.objectMeta };
}

/**
 * PRD-Repadmin.md P8: `repadmin /options <DC> +|-OPTION` where `<DC>` is a
 * remote DC — dial its TCP/135 and set the option directly there.
 */
export function setRemoteOption(tcpStack: TcpStack, targetIp: string, option: string, enabled: boolean): boolean {
  const socket = tcpStack.connect(targetIp, AD_REPLICATION_PORT);
  if (!socket || socket.state !== 'established') return false;
  let ack: ReplicationSetOptionAck | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { ack = JSON.parse(new TextDecoder().decode(data)) as ReplicationSetOptionAck; } catch { /* ignore malformed */ }
  });
  const request: ReplicationSetOptionRequest = { kind: 'setOptionRequest', option, enabled };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();
  return Boolean(ack && (ack as ReplicationSetOptionAck).kind === 'setOptionAck' && (ack as ReplicationSetOptionAck).ok);
}

/**
 * PRD-Repadmin.md P3: dial `destIp`'s TCP/135 and tell it to pull from
 * `sourceIp` right now — the remote-triggered form of `/replicate` used
 * when `<DestDC>` isn't the DC running the command.
 */
export function triggerRemotePull(tcpStack: TcpStack, destIp: string, sourceIp: string): { ok: boolean; applied: number; error?: string } {
  const socket = tcpStack.connect(destIp, AD_REPLICATION_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: "A local error occurred (Can't contact the replication partner)", applied: 0 };
  }
  let ack: ReplicationTriggerPullAck | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { ack = JSON.parse(new TextDecoder().decode(data)) as ReplicationTriggerPullAck; } catch { /* ignore malformed */ }
  });
  const request: ReplicationTriggerPull = { kind: 'triggerPull', sourceIp };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();
  if (!ack || (ack as ReplicationTriggerPullAck).kind !== 'triggerPullAck') return { ok: false, error: 'no reply from replication partner', applied: 0 };
  const result = ack as ReplicationTriggerPullAck;
  return { ok: result.ok, applied: result.applied, error: result.error };
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
