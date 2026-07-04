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
