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

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { WindowsUserManager } from '../../WindowsUserManager';

export interface WinRmServerContext {
  userMgr: WindowsUserManager;
  /** Domain-account fallback (PRD-Windows-Server.md §5 P6) — see `SmbServerContext.domainAuth`. */
  domainAuth?: (username: string, password: string) => { ok: boolean; sam: string; groups: string[] } | null;
  /** Windows Event Collector (PRD-Wecutil.md §2.1 P4) — absent on a
   *  machine that isn't acting as a collector, so `wecPush` answers an
   *  honest error rather than a silent fake success. */
  wec?: {
    receiveForwardedEvent(subscriptionId: string, sourceMachine: string, event: {
      eventId: number; timeGenerated: string; message: string; sourceLogName: string;
    }): { ok: boolean; message: string };
  };
}

export class WinRmServerHandler {
  constructor(private readonly ctx: WinRmServerContext) {}

  register(conn: TcpConnection): void {
    const reply = (msg: Record<string, unknown>) => conn.write(JSON.stringify(msg));
    let authenticated = false;

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
        authenticated = Boolean(localOk || domainOk);
        if (!authenticated) {
          reply({ ok: false, message: 'The user name or password is incorrect.' });
          return;
        }
        reply({ ok: true });
        return;
      }

      if (op === 'wecPush') {
        if (!authenticated) {
          reply({ ok: false, message: 'Access is denied.' });
          return;
        }
        if (!this.ctx.wec) {
          reply({ ok: false, message: 'The Windows Event Collector service is not available on this computer.' });
          return;
        }
        const subscriptionId = String(parsed.subscriptionId ?? '');
        const sourceMachine = String(parsed.sourceMachine ?? '');
        const event = parsed.event as { eventId: number; timeGenerated: string; message: string; sourceLogName: string };
        const res = this.ctx.wec.receiveForwardedEvent(subscriptionId, sourceMachine, event);
        reply(res);
      }
    });
  }
}
