/**
 * WsusRole — Windows Server Update Services minimal (PRD-Windows-Server-
 * Advanced.md §5 P19, §2.1.18). A catalog of purely fictional update
 * metadata (KB id, title, category, severity — **no binary patch content**,
 * per the PRD's explicit scope boundary) with per-deployment-group
 * approvals; clients redirected via `Set-WUSettings -WUServer` query their
 * group's approved updates over a real TCP connection on WSUS's actual
 * real-world default port (8530) — same JSON-PDU-over-TCP convention as
 * DFSR/AD replication's own pull cycles, rather than a byte-exact WSUS SOAP
 * API.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';

export const WSUS_PORT = 8530;

export type WsusSeverity = 'Critical' | 'Important' | 'Moderate' | 'Low';

export interface WsusUpdate {
  readonly kbId: string;
  readonly title: string;
  readonly category: string;
  readonly severity: WsusSeverity;
}

export type WsusApprovalAction = 'Install' | 'Decline';

export interface WsusApproval {
  readonly kbId: string;
  readonly targetGroup: string;
  readonly action: WsusApprovalAction;
}

/** Seeded at role start — this simulator's stand-in for WSUS's own initial product/update sync (metadata only, never a real Microsoft Update feed). */
export const DEFAULT_WSUS_CATALOG: readonly WsusUpdate[] = [
  { kbId: 'KB5001330', title: 'Cumulative Update for Windows Server', category: 'Security Updates', severity: 'Critical' },
  { kbId: 'KB5002100', title: '.NET Framework Update', category: 'Updates', severity: 'Important' },
  { kbId: 'KB5003200', title: 'Servicing Stack Update', category: 'Updates', severity: 'Moderate' },
  { kbId: 'KB5004400', title: 'Feature Update', category: 'Upgrades', severity: 'Low' },
] as const;

export interface WsusOpResult { ok: boolean; message: string }

/** Owned by one `WindowsServer`'s `WSUS` role install — the catalog plus every deployment group's per-update approval decision. */
export class WindowsWsusRole {
  private readonly catalog = new Map<string, WsusUpdate>();
  /** targetGroup -> kbId -> action. */
  private readonly approvals = new Map<string, Map<string, WsusApprovalAction>>();

  constructor() {
    for (const u of DEFAULT_WSUS_CATALOG) this.catalog.set(u.kbId, u);
  }

  listCatalog(): WsusUpdate[] { return [...this.catalog.values()]; }
  getUpdate(kbId: string): WsusUpdate | null { return this.catalog.get(kbId) ?? null; }

  /** `Approve-WsusUpdate -Updates <kbId> -TargetGroupName <group> -Action Install|Decline`. */
  approve(kbId: string, targetGroup: string, action: WsusApprovalAction): WsusOpResult {
    if (!this.catalog.has(kbId)) {
      return { ok: false, message: `Approve-WsusUpdate : Update "${kbId}" was not found in the WSUS catalog.` };
    }
    let group = this.approvals.get(targetGroup);
    if (!group) { group = new Map(); this.approvals.set(targetGroup, group); }
    group.set(kbId, action);
    return { ok: true, message: '' };
  }

  /** Every update approved for install for `targetGroup` — declined and not-yet-decided updates never appear. */
  getApprovedUpdatesForGroup(targetGroup: string): WsusUpdate[] {
    const group = this.approvals.get(targetGroup);
    if (!group) return [];
    const updates: WsusUpdate[] = [];
    for (const [kbId, action] of group) {
      if (action !== 'Install') continue;
      const update = this.catalog.get(kbId);
      if (update) updates.push(update);
    }
    return updates;
  }
}

interface WsusQueryRequest {
  kind: 'queryApproved';
  targetGroup: string;
}
interface WsusQueryResponse {
  kind: 'approvedUpdates';
  updates: WsusUpdate[];
}

/** Server side — answers a client's approved-update query for its configured target group. */
export class WsusServerHandler {
  constructor(private readonly role: WindowsWsusRole) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let msg: WsusQueryRequest;
      try { msg = JSON.parse(new TextDecoder().decode(data)) as WsusQueryRequest; } catch { return; }
      if (msg.kind !== 'queryApproved') return;

      const response: WsusQueryResponse = { kind: 'approvedUpdates', updates: this.role.getApprovedUpdatesForGroup(msg.targetGroup) };
      socket.send(new TextEncoder().encode(JSON.stringify(response)));
    });
  }
}

export interface WsusClientQueryResult { ok: boolean; error?: string; updates: WsusUpdate[] }

/** Client side — dials `wuServerAddress`'s TCP/8530 and asks what's approved for `targetGroup`. */
export function queryWsusApprovedUpdates(tcpStack: TcpStack, wuServerAddress: string, targetGroup: string): WsusClientQueryResult {
  const socket = tcpStack.connect(wuServerAddress, WSUS_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: 'The WSUS server could not be contacted.', updates: [] };
  }

  let response: WsusQueryResponse | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { response = JSON.parse(new TextDecoder().decode(data)) as WsusQueryResponse; } catch { /* ignore malformed */ }
  });
  const request: WsusQueryRequest = { kind: 'queryApproved', targetGroup };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();

  if (!response || (response as WsusQueryResponse).kind !== 'approvedUpdates') {
    return { ok: false, error: 'no reply from WSUS server', updates: [] };
  }
  return { ok: true, updates: (response as WsusQueryResponse).updates };
}
