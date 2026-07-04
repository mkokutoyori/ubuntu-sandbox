/**
 * SmbTypes — shared data model for the SMB file-server layer
 * (PRD-Windows-Server.md §5 P3). PDUs ride TCP/445 as plain JSON
 * objects (the same "typed object over a real TcpConnection"
 * convention `SshServerHandler` already uses for SSH — no binary SMB2
 * wire encoding, an explicit non-goal per PRD §3.4).
 */

export type SharePermission = 'Full' | 'Change' | 'Read';

export interface SmbShare {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly special: boolean;
  /** principal ("Everyone", a user name, a group name) → granted access. */
  readonly permissions: Map<string, SharePermission>;
}

export interface SmbShareView {
  name: string;
  path: string;
  description: string;
  special: boolean;
  permissions: Array<{ principal: string; access: SharePermission }>;
}

export interface SmbSessionEntry {
  readonly id: number;
  readonly clientComputerName: string;
  readonly clientIp: string;
  readonly user: string;
  readonly shares: Set<string>;
  readonly connectedAtMs: number;
  numOpens: number;
}

export interface SmbSessionView {
  id: number;
  clientComputerName: string;
  clientIp: string;
  user: string;
  shares: string[];
  numOpens: number;
}

// ── Wire PDUs (client → server) ─────────────────────────────────────────────

export interface SmbNegotiateRequest { op: 'negotiate' }
export interface SmbSessionSetupRequest { op: 'session_setup'; username: string; password: string }
export interface SmbTreeConnectRequest { op: 'tree_connect'; share: string }
export interface SmbTreeDisconnectRequest { op: 'tree_disconnect'; treeId: number }
export interface SmbReadRequest { op: 'read'; treeId: number; path: string }
export interface SmbWriteRequest { op: 'write'; treeId: number; path: string; content: string }
export interface SmbListRequest { op: 'list'; treeId: number; path: string }
export interface SmbLogoffRequest { op: 'logoff' }

export type SmbRequest =
  | SmbNegotiateRequest | SmbSessionSetupRequest | SmbTreeConnectRequest
  | SmbTreeDisconnectRequest | SmbReadRequest | SmbWriteRequest | SmbListRequest
  | SmbLogoffRequest;

// ── Wire PDUs (server → client) ──────────────────────────────────────────────

export interface SmbListEntry { name: string; isDirectory: boolean; size: number }

export interface SmbErrorResponse {
  ok: false;
  status: 'STATUS_LOGON_FAILURE' | 'STATUS_ACCESS_DENIED' | 'STATUS_BAD_NETWORK_NAME'
    | 'STATUS_OBJECT_NAME_NOT_FOUND' | 'STATUS_NETWORK_NAME_DELETED' | 'STATUS_OBJECT_PATH_NOT_FOUND';
  message: string;
}

export type SmbResponse =
  | { ok: true; dialect: string }
  | { ok: true; sessionId: number }
  | { ok: true; treeId: number }
  | { ok: true }
  | { ok: true; content: string }
  | { ok: true; entries: SmbListEntry[] }
  | SmbErrorResponse;
