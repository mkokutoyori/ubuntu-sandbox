/**
 * SmbClient — outbound SMB dialer used by `net use` and by UNC-path
 * access from cmd (`dir \\srv\share`, `copy`, `type`) and PowerShell
 * (PRD-Windows-Server.md §5 P3).
 *
 * Unlike the outbound SSH client (which resolves the remote device
 * object directly and calls its methods), this dials the REAL per-device
 * `TcpStack` — real TCP handshake, real routing/cables/ACLs, real RST on
 * a stopped LanmanServer, real "no route" when a cable is unplugged.
 * `TcpStack.connect()` and cable delivery are synchronous in this
 * simulator (see TcpStack.ts), so the whole negotiate → session-setup →
 * tree-connect handshake below completes inline, one request at a time.
 */

import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { SmbEnumeratedShare, SmbListEntry } from './SmbTypes';

export interface SmbConnection {
  readonly shareName: string;
  /** Whether the session is still live — false once the peer closed it or the link that carried it went down. */
  isConnected(): boolean;
  read(path: string): { ok: boolean; content?: string; error?: string };
  write(path: string, content: string): { ok: boolean; error?: string };
  list(path: string): { ok: boolean; entries?: SmbListEntry[]; error?: string };
  disconnect(): void;
}

export interface SmbDialResult {
  ok: boolean;
  /** net.exe-style multi-line error message (e.g. "System error 53 has occurred…"). */
  error?: string;
  systemErrorCode?: number;
  connection?: SmbConnection;
}

/** Send one request and synchronously capture the (single) reply. */
function roundTrip(socket: TcpSocket, payload: Record<string, unknown>): Record<string, unknown> | null {
  let response: Record<string, unknown> | null = null;
  const unsubscribe = socket.onData((data) => {
    try { response = JSON.parse(String(data)) as Record<string, unknown>; } catch { /* ignore */ }
  });
  socket.write(JSON.stringify(payload));
  unsubscribe();
  return response;
}

const ERR_NETWORK_PATH_NOT_FOUND = { error: 'System error 53 has occurred.\n\nThe network path was not found.', code: 53 };
const ERR_CONNECTION_REFUSED = { error: 'System error 1225 has occurred.\n\nThe remote computer refused the network connection.', code: 1225 };
const ERR_BAD_CREDENTIALS = { error: 'System error 1326 has occurred.\n\nThe user name or password is incorrect.', code: 1326 };
const ERR_ACCESS_DENIED = { error: 'System error 5 has occurred.\n\nAccess is denied.', code: 5 };
const ERR_NAME_NOT_FOUND = { error: 'System error 67 has occurred.\n\nThe network name cannot be found.', code: 67 };

/**
 * FSCTL_DFS_GET_REFERRALS: ask a namespace server which share a
 * `\\domain\namespace[\folder]` path actually lives on. Returns the
 * targets it offers, most-preferred first, or an empty list when this
 * server hosts no such namespace.
 */
export function requestDfsReferral(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  username: string;
  password: string;
  path: string;
}): string[] {
  const socket = opts.tcpStack.connect(opts.targetIp, 445);
  if (!socket || socket.state !== 'established') return [];
  try {
    if (!roundTrip(socket, { op: 'negotiate' })?.ok) return [];
    if (!roundTrip(socket, { op: 'session_setup', username: opts.username, password: opts.password })?.ok) return [];
    const referral = roundTrip(socket, { op: 'dfs_referral', path: opts.path });
    if (!referral?.ok) return [];
    const targets = referral.targets;
    return Array.isArray(targets) ? targets.map(String) : [];
  } finally {
    roundTrip(socket, { op: 'logoff' });
    socket.close();
  }
}

/**
 * NetShareEnum: ask a server which shares it offers. `net view` reads
 * this — an enumeration is a question put to the machine opposite, never
 * a look inside it.
 */
export function requestShareEnum(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  username: string;
  password: string;
}): { ok: boolean; shares?: SmbEnumeratedShare[]; error?: string; systemErrorCode?: number } {
  const socket = opts.tcpStack.connect(opts.targetIp, 445);
  if (!socket || socket.state !== 'established') {
    const refused = socket?.connectRefused === true;
    const e = refused ? ERR_CONNECTION_REFUSED : ERR_NETWORK_PATH_NOT_FOUND;
    return { ok: false, error: e.error, systemErrorCode: e.code };
  }
  try {
    if (!roundTrip(socket, { op: 'negotiate' })?.ok) {
      return { ok: false, error: ERR_NETWORK_PATH_NOT_FOUND.error, systemErrorCode: ERR_NETWORK_PATH_NOT_FOUND.code };
    }
    if (!roundTrip(socket, { op: 'session_setup', username: opts.username, password: opts.password })?.ok) {
      return { ok: false, error: ERR_BAD_CREDENTIALS.error, systemErrorCode: ERR_BAD_CREDENTIALS.code };
    }
    const answer = roundTrip(socket, { op: 'share_enum' });
    if (!answer?.ok) {
      return { ok: false, error: ERR_ACCESS_DENIED.error, systemErrorCode: ERR_ACCESS_DENIED.code };
    }
    const shares = answer.shares;
    return { ok: true, shares: Array.isArray(shares) ? shares as SmbEnumeratedShare[] : [] };
  } finally {
    roundTrip(socket, { op: 'logoff' });
    socket.close();
  }
}

export function dialSmbShare(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  shareName: string;
  username: string;
  password: string;
}): SmbDialResult {
  const socket = opts.tcpStack.connect(opts.targetIp, 445);
  if (!socket || socket.state !== 'established') {
    const refused = socket?.connectRefused === true;
    const e = refused ? ERR_CONNECTION_REFUSED : ERR_NETWORK_PATH_NOT_FOUND;
    return { ok: false, error: e.error, systemErrorCode: e.code };
  }

  const negotiate = roundTrip(socket, { op: 'negotiate' });
  if (!negotiate?.ok) {
    socket.close();
    return { ok: false, error: ERR_NETWORK_PATH_NOT_FOUND.error, systemErrorCode: ERR_NETWORK_PATH_NOT_FOUND.code };
  }

  const setup = roundTrip(socket, { op: 'session_setup', username: opts.username, password: opts.password });
  if (!setup?.ok) {
    socket.close();
    return { ok: false, error: ERR_BAD_CREDENTIALS.error, systemErrorCode: ERR_BAD_CREDENTIALS.code };
  }

  const tree = roundTrip(socket, { op: 'tree_connect', share: opts.shareName });
  if (!tree?.ok) {
    socket.close();
    const status = (tree as { status?: string } | null)?.status;
    const e = status === 'STATUS_ACCESS_DENIED' ? ERR_ACCESS_DENIED : ERR_NAME_NOT_FOUND;
    return { ok: false, error: e.error, systemErrorCode: e.code };
  }

  const treeId = tree.treeId as number;
  let disconnected = false;
  socket.onClose?.(() => { disconnected = true; });

  /**
   * A request that draws no answer means the far end is gone — the link
   * dropped, or the server stopped. TCP itself stays `established` until
   * it times out, so the redirector learns it here, the way a real one
   * learns on the next use rather than the instant a cable is pulled.
   */
  const exchange = (payload: Record<string, unknown>): Record<string, unknown> | null => {
    const answer = roundTrip(socket, payload);
    if (answer === null) disconnected = true;
    return answer;
  };

  const connection: SmbConnection = {
    shareName: opts.shareName,
    isConnected: () => !disconnected && socket.state === 'established',
    read(path: string) {
      if (disconnected) return { ok: false, error: 'The specified network name is no longer available.' };
      const r = exchange({ op: 'read', treeId, path });
      return r?.ok ? { ok: true, content: r.content as string } : { ok: false, error: (r as { message?: string } | null)?.message ?? 'Unknown error' };
    },
    write(path: string, content: string) {
      if (disconnected) return { ok: false, error: 'The specified network name is no longer available.' };
      const r = exchange({ op: 'write', treeId, path, content });
      return r?.ok ? { ok: true } : { ok: false, error: (r as { message?: string } | null)?.message ?? 'Unknown error' };
    },
    list(path: string) {
      if (disconnected) return { ok: false, error: 'The specified network name is no longer available.' };
      const r = exchange({ op: 'list', treeId, path });
      return r?.ok ? { ok: true, entries: r.entries as SmbListEntry[] } : { ok: false, error: (r as { message?: string } | null)?.message ?? 'Unknown error' };
    },
    disconnect() {
      if (disconnected) return;
      roundTrip(socket, { op: 'tree_disconnect', treeId });
      roundTrip(socket, { op: 'logoff' });
      socket.close();
    },
  };
  return { ok: true, connection };
}
