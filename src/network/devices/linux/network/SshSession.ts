/**
 * SshSession — a real inbound SSH session entity, as it would appear in
 * `utmp` / `wtmp` on a real Linux box.
 *
 * Used by `w`, `who`, `last`, `loginctl` and the journal to render a
 * coherent view of who is connected (and when). The full attribute set
 * mirrors what a real Linux session leader holds: pid, tty, ssh client
 * address, login time, last activity, idle counters, what command the
 * session is running, etc. Anything unused today is wired so future
 * features (`pkill -t pts/0`, `loginctl terminate-session`, ssh
 * MaxSessions limits, session leases) can read it without churn.
 */

export type SessionTransport = 'ssh' | 'console' | 'serial' | 'rdp';

export interface SshSessionInit {
  /** Login user on the local machine (as in /etc/passwd). */
  user: string;
  /** "pts/0", "pts/1"… — TTY allocated for this session. */
  tty: string;
  /** Numeric UID of the user. */
  uid: number;
  /** PID of the per-session sshd child (the one accepting the connection). */
  sshdPid: number;
  /** PID of the user's login shell, parented to sshdPid. */
  shellPid?: number;
  /** Source IP of the connection, as in `w` and auth.log "from <ip>". */
  fromIp: string;
  /** Source hostname (resolved or numeric). */
  fromHost: string;
  /** Transport — always 'ssh' for our sshd, kept polymorphic for future. */
  transport?: SessionTransport;
  /** Auto-set to `new Date()`; expose as override for tests. */
  loginAt?: Date;
}

export class SshSession {
  user: string;
  tty: string;
  uid: number;
  sshdPid: number;
  shellPid?: number;
  fromIp: string;
  fromHost: string;
  transport: SessionTransport;
  loginAt: Date;

  // ─── runtime stats (refreshed by `w` / `loginctl`) ─────────────────
  /** Last keystroke / command time — drives the IDLE column. */
  lastActivityAt: Date;
  /** What the session is running right now (free-form WHAT in `w`). */
  currentCommand: string = '-bash';
  /** Login class (POSIX) — informational. */
  loginClass: string = 'user';
  /** systemd session/user slice ID (loginctl). */
  systemdSessionId: string;

  // ─── flags ─────────────────────────────────────────────────────────
  /** True after `loginctl terminate-session` or remote logout. */
  closed = false;
  /** Set to the disconnect reason on close (signal, EOF, killed by admin). */
  closedReason?: string;
  /** Wall time at session close. */
  closedAt?: Date;

  constructor(init: SshSessionInit) {
    this.user = init.user;
    this.tty = init.tty;
    this.uid = init.uid;
    this.sshdPid = init.sshdPid;
    this.shellPid = init.shellPid;
    this.fromIp = init.fromIp;
    this.fromHost = init.fromHost;
    this.transport = init.transport ?? 'ssh';
    this.loginAt = init.loginAt ?? new Date();
    this.lastActivityAt = this.loginAt;
    // Real Linux uses c1, c2… but ssh sessions number from 1.
    this.systemdSessionId = String(init.sshdPid);
  }

  isActive(): boolean { return !this.closed; }

  /** Mark the session as idle since `now`; backs the `w` IDLE column. */
  recordActivity(now: Date = new Date()): void {
    if (!this.closed) this.lastActivityAt = now;
  }

  /** Disconnect / logout the session, recording the reason. */
  close(reason: string = 'normal', at: Date = new Date()): void {
    this.closed = true;
    this.closedAt = at;
    this.closedReason = reason;
  }

  /** Seconds elapsed since the last keystroke — for `w` formatting. */
  idleSeconds(now: Date = new Date()): number {
    return Math.max(0, Math.round((now.getTime() - this.lastActivityAt.getTime()) / 1000));
  }

  /** Login duration in seconds. */
  durationSeconds(now: Date = new Date()): number {
    const end = this.closedAt ?? now;
    return Math.max(0, Math.round((end.getTime() - this.loginAt.getTime()) / 1000));
  }

  /** HH:MM formatting used by `w` and `last` headers. */
  loginHHMM(): string {
    const d = this.loginAt;
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }

  /** A row of `w` output (USER TTY FROM LOGIN@ IDLE WHAT). */
  toWRow(): string {
    const idle = formatIdle(this.idleSeconds());
    return [
      this.user.padEnd(9),
      this.tty.padEnd(9),
      this.fromIp.padEnd(16),
      this.loginHHMM().padEnd(8),
      idle.padEnd(7),
      '0.00s',
      '0.00s',
      this.currentCommand,
    ].join(' ');
  }

  /** A row of `last` output (USER TTY HOST LOGIN-TIME DURATION). */
  toLastRow(): string {
    const dateStr = this.loginAt.toUTCString().replace(/^... /, '').slice(0, 21);
    const dur = this.closedAt ? `(${formatIdle(this.durationSeconds())})` : 'still logged in';
    return `${this.user.padEnd(8)} ${this.tty.padEnd(12)} ${this.fromIp.padEnd(16)} ${dateStr}  ${dur}`;
  }
}

function formatIdle(secs: number): string {
  if (secs < 60)        return `${secs}.00s`;
  if (secs < 3600)      return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  if (secs < 86400)     return `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(secs / 86400)}days`;
}
