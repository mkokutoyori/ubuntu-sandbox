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

export class SshSessionTable {
  private active = new Map<string, SshSession>();
  private history: SshSession[] = [];
  private nextPts = 0;

  /** Open a new SSH session — returns the entity. */
  open(init: Omit<SshSessionInit, 'tty'> & { tty?: string }): SshSession {
    const tty = init.tty ?? this.allocateTty();
    const session = new SshSession({ ...init, tty });
    this.active.set(this.key(session), session);
    return session;
  }

  /** Close (logout) a session by tty or session key. */
  close(ttyOrKey: string, reason: string = 'normal'): boolean {
    const key = ttyOrKey.includes('@') ? ttyOrKey : `${ttyOrKey}@*`;
    let removed = false;
    for (const [k, s] of this.active) {
      if (k === key || s.tty === ttyOrKey) {
        s.close(reason);
        this.history.push(s);
        this.active.delete(k);
        removed = true;
      }
    }
    return removed;
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

  private allocateTty(): string {
    return `pts/${this.nextPts++}`;
  }

  private key(s: SshSession): string {
    return `${s.tty}@${s.fromIp}`;
  }
}
