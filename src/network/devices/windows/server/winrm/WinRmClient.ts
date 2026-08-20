/**
 * WinRmClient — outbound WinRM dialer used by `Invoke-Command
 * -ComputerName`, `Enter-PSSession`, `Test-WSMan` (PRD-Windows-Server.md
 * §5 P4). Real TCP/5985 dial through the device's `TcpStack` — genuine
 * routing/cables/firewalls, not a topology-wide lookup — replacing the
 * `findHostByAddress` shortcut the pre-P4 remoting provider used.
 */

import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';

export interface WinRmDialResult {
  ok: boolean;
  error?: string;
}

function roundTrip(socket: TcpSocket, payload: Record<string, unknown>): Record<string, unknown> | null {
  let response: Record<string, unknown> | null = null;
  const unsubscribe = socket.onData((data) => {
    try { response = JSON.parse(String(data)) as Record<string, unknown>; } catch { /* ignore */ }
  });
  socket.write(JSON.stringify(payload));
  unsubscribe();
  return response;
}

/** Dial WinRM on `targetIp`, negotiate, and authenticate. Always closes the probe socket. */
export function dialWinRm(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  username: string;
  password: string;
}): WinRmDialResult {
  const socket = opts.tcpStack.connect(opts.targetIp, 5985);
  if (!socket || socket.state !== 'established') {
    return {
      ok: false,
      error: 'Connecting to remote server failed: WinRM cannot complete the operation. '
        + 'Verify that the specified computer name is valid, that the computer is accessible over the network, '
        + 'and that a firewall exception for the WinRM service is enabled and allows access from this computer.',
    };
  }

  const negotiate = roundTrip(socket, { op: 'negotiate' });
  if (!negotiate?.ok) {
    socket.close();
    return { ok: false, error: 'WinRM cannot complete the operation. Verify that the WinRM service is running on the destination.' };
  }

  const auth = roundTrip(socket, { op: 'auth', username: opts.username, password: opts.password });
  socket.close();
  if (!auth?.ok) {
    return { ok: false, error: (auth as { message?: string } | null)?.message ?? 'Access is denied.' };
  }
  return { ok: true };
}

/**
 * Windows Event Forwarding push (PRD-Wecutil.md §2.1 P4) — dial + real
 * negotiate/auth (same wire path as `dialWinRm`), then a `wecPush` op
 * carrying the matching event. Authenticates as the SOURCE machine's own
 * computer account (`<hostname>$` + its domain secret) — a computer
 * account is a first-class Kerberos principal in this simulator's KDC
 * already (`KdcSession.handleAsReq`), so no new server-side credential
 * path is needed. One real dial per forwarded event (same one-shot
 * pattern as `Send-MailMessage`), not a persistent channel.
 */
export function pushForwardedEvent(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  username: string;
  password: string;
  subscriptionId: string;
  sourceMachine: string;
  event: { eventId: number; timeGenerated: string; message: string; sourceLogName: string };
}): WinRmDialResult {
  const socket = opts.tcpStack.connect(opts.targetIp, 5985);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: 'WinRM cannot complete the operation: the collector is not reachable.' };
  }

  const negotiate = roundTrip(socket, { op: 'negotiate' });
  if (!negotiate?.ok) {
    socket.close();
    return { ok: false, error: 'WinRM cannot complete the operation. Verify that the WinRM service is running on the destination.' };
  }

  const auth = roundTrip(socket, { op: 'auth', username: opts.username, password: opts.password });
  if (!auth?.ok) {
    socket.close();
    return { ok: false, error: (auth as { message?: string } | null)?.message ?? 'Access is denied.' };
  }

  const push = roundTrip(socket, {
    op: 'wecPush', subscriptionId: opts.subscriptionId, sourceMachine: opts.sourceMachine, event: opts.event,
  });
  socket.close();
  if (!push?.ok) {
    return { ok: false, error: (push as { message?: string } | null)?.message ?? 'The event could not be forwarded.' };
  }
  return { ok: true };
}
