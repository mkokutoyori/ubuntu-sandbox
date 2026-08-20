/**
 * `query session`/`qwinsta` and `logoff`/`rwinsta` — the classic cmd.exe
 * Remote Desktop session utilities (PRD-Windows-Server-Advanced.md §5
 * P17): real session-table introspection/teardown, no graphical content.
 */
import type { RdpSessionTable } from './server/rdp/RdpSession';

export interface RdpCommandContext {
  sessions: RdpSessionTable;
}

/** `query session` / `qwinsta` — lists every currently-established RDP session. */
export function cmdQuerySession(ctx: RdpCommandContext): string {
  const sessions = ctx.sessions.list();
  const header = ' SESSIONNAME       USERNAME                 ID  STATE   TYPE';
  if (sessions.length === 0) return header;
  const rows = sessions.map(s =>
    ` rdp-tcp#${s.sessionId}          ${s.userName.padEnd(20)}     ${s.sessionId}  ${s.state.slice(0, 4)}    rdpwd`);
  return [header, ...rows].join('\n');
}

/** `logoff <sessionId>` / `rwinsta <sessionId>` — ends the session outright. */
export function cmdLogoff(ctx: RdpCommandContext, args: string[]): string {
  const idArg = args[0];
  const sessionId = Number(idArg);
  if (!idArg || Number.isNaN(sessionId)) return 'Usage: logoff <sessionid> [/server:servername] [/v]';
  const existed = ctx.sessions.logoff(sessionId);
  if (!existed) return `No session exists for ID ${sessionId}.`;
  return '';
}
