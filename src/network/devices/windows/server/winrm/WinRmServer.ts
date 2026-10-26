/**
 * WinRmServerHandler — server-side endpoint registered on TCP port 5985
 * (PRD-Windows-Server.md §5 P4). Mirrors `SshServerHandler`/`SmbServerHandler`:
 * a fresh handler per accepted connection, JSON ops over the real
 * `TcpConnection`.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { WindowsUserManager } from '../../WindowsUserManager';
import { verifyApReq, type KerberosServiceIdentity } from '@/network/kerberos/ApReqVerifier';
import { base64ToBytes } from '@/crypto/encoding';
import { JsonMessageAssembler } from '../JsonMessageAssembler';
import type { WinRmShellHost } from './WinRmShell';

export interface WinRmIdentity {
  readonly sam: string;
  readonly viaDomain: boolean;
}

export interface WinRmCommandResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly message?: string;
}

export interface WinRmServerContext {
  userMgr: WindowsUserManager;
  kerberos?: KerberosServiceIdentity;
  runCommand?: (line: string, identity: WinRmIdentity) => WinRmCommandResult;
  openShell?: (identity: WinRmIdentity) => WinRmShellHost | null;
  refreshPolicy?: (scope: 'both' | 'computer' | 'user', delayMinutes: number, identity: WinRmIdentity) => WinRmCommandResult;
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
    const assembler = new JsonMessageAssembler();
    let identity: WinRmIdentity | null = null;
    let shell: WinRmShellHost | null = null;

    conn.onClose?.(() => {
      shell?.close();
      shell = null;
    });

    const handle = (parsed: Record<string, unknown>): void => {
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
        identity = { sam: username.includes('\\') ? username.slice(username.indexOf('\\') + 1) : username.split('@')[0], viaDomain: !localOk };
        reply({ ok: true });
        return;
      }

      if (op === 'krbAuth') {
        const bytes = base64ToBytes(String(parsed.apReq ?? ''));
        const sam = this.ctx.kerberos ? verifyApReq(bytes, this.ctx.kerberos) : null;
        if (sam === null) {
          reply({ ok: false, message: 'The Kerberos authentication failed.' });
          return;
        }
        identity = { sam, viaDomain: true };
        reply({ ok: true });
        return;
      }

      if (op === 'gpupdate') {
        if (identity === null) {
          reply({ ok: false, message: 'Access is denied.' });
          return;
        }
        const scope = String(parsed.scope ?? 'both');
        if (!this.ctx.refreshPolicy || !['both', 'computer', 'user'].includes(scope)) {
          reply({ ok: false, message: 'The Group Policy client service is not available on this computer.' });
          return;
        }
        reply({ ...this.ctx.refreshPolicy(scope as 'both' | 'computer' | 'user', Number(parsed.delayMinutes ?? 0), identity) });
        return;
      }

      if (op === 'run') {
        if (identity === null) {
          reply({ ok: false, message: 'Access is denied.' });
          return;
        }
        if (!this.ctx.runCommand) {
          reply({ ok: false, message: 'The WinRM shell service is not available on this computer.' });
          return;
        }
        reply({ ...this.ctx.runCommand(String(parsed.line ?? ''), identity) });
        return;
      }

      if (op === 'shell_open') {
        if (identity === null) {
          reply({ ok: false, message: 'Access is denied.' });
          return;
        }
        if (!this.ctx.openShell) {
          reply({ ok: false, message: 'The WinRM shell service is not available on this computer.' });
          return;
        }
        shell?.close();
        shell = this.ctx.openShell(identity);
        reply(shell === null ? { ok: false, message: 'Access is denied.' } : { ok: true, prompt: shell.prompt() });
        return;
      }

      if (op === 'shell_run') {
        if (shell === null) {
          reply({ ok: false, message: 'The WinRM shell is not open.' });
          return;
        }
        shell.run(String(parsed.line ?? '')).then(
          (outcome) => reply({ ok: true, ...outcome }),
          (error: unknown) => reply({ ok: false, message: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }

      if (op === 'shell_complete') {
        if (shell === null) {
          reply({ ok: false, message: 'The WinRM shell is not open.' });
          return;
        }
        reply({ ok: true, ...shell.complete(String(parsed.line ?? '')) });
        return;
      }

      if (op === 'shell_close') {
        shell?.close();
        shell = null;
        return;
      }

      if (op === 'wecPush') {
        if (identity === null) {
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
    };

    conn.onData((data) => {
      for (const parsed of assembler.push(String(data))) handle(parsed);
    });
  }
}

