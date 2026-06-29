/**
 * SshSessionTable — per-host active SSH session registry.
 *
 * Backs `w`, `who`, `last`, `loginctl list-sessions`. Sessions are added
 * when sshd accepts a login (LinuxSshClient.recordSshLogin path on
 * success) and removed (or marked closed) on disconnect.
 *
 * Storage is per-machine. We expose this from LinuxMachine so commands
 * issued on the same device can query the same table.
 */

import { SshSession, type SshSessionInit } from './SshSession';
import type { UtmpSync } from './UtmpSync';

export class SshSessionTable {
  private active = new Map<string, SshSession>();
  private history: SshSession[] = [];
  private nextPts = 0;
  private sync: UtmpSync | null = null;

  attachUtmp(sync: UtmpSync): void { this.sync = sync; }

  private toRecord(s: SshSession): { user: string; tty: string; fromIp: string; fromHost?: string; loginAt: number; closedAt?: number | null; shellPid?: number; uid?: number } {
    return {
      user: s.user, tty: s.tty, fromIp: s.fromIp, fromHost: s.fromHost,
      loginAt: s.loginAt.getTime(),
      closedAt: (s as unknown as { closedAt?: Date | null }).closedAt?.getTime() ?? null,
      shellPid: s.shellPid, uid: s.uid,
    };
  }

  open(init: Omit<SshSessionInit, 'tty'> & { tty?: string }): SshSession {
    const tty = init.tty ?? this.allocateTty();
    const session = new SshSession({ ...init, tty });
    this.active.set(this.key(session), session);
    this.sync?.openSession(this.toRecord(session));
    return session;
  }

  close(ttyOrKey: string, reason: string = 'normal'): boolean {
    const key = ttyOrKey.includes('@') ? ttyOrKey : `${ttyOrKey}@*`;
    let removed = false;
    for (const [k, s] of this.active) {
      if (k === key || s.tty === ttyOrKey) {
        s.close(reason);
        this.history.push(s);
        this.active.delete(k);
        this.sync?.closeSession(s.tty, new Date());
        removed = true;
      }
    }
    return removed;
  }

  recordFailedLogin(user: string, fromIp: string): void {
    this.sync?.appendFailure({ user, tty: 'ssh:notty', fromIp, at: Date.now() });
  }

  /** Sessions currently open. */
  list(): SshSession[] {
    return Array.from(this.active.values()).sort((a, b) => a.loginAt.getTime() - b.loginAt.getTime());
  }

  /** All sessions, active + historical, most recent first. */
  recent(limit: number = 10): SshSession[] {
    const all = [...this.history, ...this.active.values()];
    return all.sort((a, b) => b.loginAt.getTime() - a.loginAt.getTime()).slice(0, limit);
  }

  /** Total count (active + historical) — used by `last`. */
  size(): number { return this.active.size + this.history.length; }

  /**
   * Seed the local tty1 console session if absent — `who`/`w`/`last` show
   * the interactively logged-in user even before any SSH login happens.
   */
  ensureConsoleSession(user: string, uid: number): void {
    if (this.list().some(s => s.tty === 'tty1')) return;
    this.open({
      user, uid, sshdPid: 0, tty: 'tty1',
      fromIp: ':0', fromHost: '', transport: 'console',
    });
  }

  // ─── Command renderers (who / w / last all read this table) ──────────

  /** Render `who` — one line per active session. */
  renderWho(): string {
    return this.list().map(s =>
      `${s.user.padEnd(8)} ${s.tty.padEnd(8)} ` +
      `${s.loginAt.toISOString().slice(0, 16).replace('T', ' ')} (${s.fromIp})`,
    ).join('\n');
  }

  /** Render `w` — uptime/header line followed by one row per session. */
  renderW(): string {
    const header = ' ' + new Date().toUTCString().slice(5, 21) + '  up 0 min,  ' +
      `${this.list().length} users,  load average: 0.00, 0.00, 0.00\n` +
      'USER     TTY       FROM             LOGIN@   IDLE   JCPU   PCPU WHAT';
    return [header, ...this.list().map(s => s.toWRow())].join('\n');
  }

  /** Render `last` — most recent `limit` sessions, newest first. */
  renderLast(limit = 10): string {
    return this.recent(limit).map(s => s.toLastRow()).join('\n');
  }

  private allocateTty(): string {
    return `pts/${this.nextPts++}`;
  }

  private key(s: SshSession): string {
    return `${s.tty}@${s.fromIp}`;
  }
}
