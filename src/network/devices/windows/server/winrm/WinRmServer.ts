/**
 * WinRmServerHandler — server-side endpoint registered on TCP port 5985
 * (PRD-Windows-Server.md §5 P4). Mirrors `SshServerHandler`/`SmbServerHandler`:
 * a fresh handler per accepted connection, JSON ops over the real
 * `TcpConnection`.
 *
 * Scope: this validates real network reachability and authentication
 * for WinRM — the two things `Invoke-Command`/`Enter-PSSession`/
 * `Test-WSMan` need to honour cables, routing, firewalls and the
 * WinRM/service state. Once authenticated, script execution itself is
 * still dispatched via `PSInterpreter.invokeRemote()` on the target
 * device's own interpreter (as it was before this phase) — this
 * simulator runs every device in one JS process, so there is no real
 * wire representation of a `PSScriptBlock` AST to ship; only the
 * connection-establishment step is new here.
 */

import type { TcpStream as TcpConnection } from '@/network/core/TcpConnection';
import type { WindowsUserManager } from '../../WindowsUserManager';

export interface WinRmServerContext {
  userMgr: WindowsUserManager;
  /** Domain-account fallback (PRD-Windows-Server.md §5 P6) — see `SmbServerContext.domainAuth`. */
  domainAuth?: (username: string, password: string) => { ok: boolean; sam: string; groups: string[] } | null;
}

export class WinRmServerHandler {
  constructor(private readonly ctx: WinRmServerContext) {}

  register(conn: TcpConnection): void {
    const reply = (msg: Record<string, unknown>) => conn.write(JSON.stringify(msg));

    conn.onData((data) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
      const op = parsed.op as string | undefined;

      if (op === 'negotiate') {
        reply({ ok: true, protocol: 'WS-Management' });
        return;
      }

      if (op === 'auth') {
        const username = String(parsed.username ?? '');
        const password = String(parsed.password ?? '');
        const account = this.ctx.userMgr.getUser(username);
        const localOk = account?.enabled && this.ctx.userMgr.checkPassword(username, password);
        const domainOk = !localOk && this.ctx.domainAuth?.(username, password)?.ok;
        if (!localOk && !domainOk) {
          reply({ ok: false, message: 'The user name or password is incorrect.' });
          return;
        }
        reply({ ok: true });
      }
    });
  }
}
