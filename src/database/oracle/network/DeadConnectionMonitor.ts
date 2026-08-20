/**
 * DeadConnectionMonitor — server-side Dead Connection Detection (DCD),
 * driven by SQLNET.EXPIRE_TIME in sqlnet.ora (network/admin/sqlnet.ora).
 *
 * Real Oracle Net sends a keepalive probe to each client every
 * EXPIRE_TIME minutes; if the client is unreachable the server tears the
 * session down itself — rolling back any uncommitted transaction (the
 * client never asked to keep it), releasing every lock, and removing the
 * V$SESSION / V$TRANSACTION entries. A value of 0 (or the parameter
 * missing) disables DCD entirely, matching real sqlnet.ora semantics.
 */

export interface DcdSessionRef {
  readonly sid: number;
  readonly clientIp: string | null;
  readonly type: 'USER' | 'BACKGROUND';
}

export interface DeadConnectionMonitorConfig {
  /** Reads sqlnet.ora's raw text, or null when unavailable. */
  readonly readSqlnetOra: () => string | null;
  /** Enumerates currently tracked sessions (V$SESSION rows). */
  readonly listSessions: () => readonly DcdSessionRef[];
  /** True when the client is currently reachable from this host. */
  readonly isReachable: (clientIp: string) => boolean | Promise<boolean>;
  /** Invoked once per session found dead; performs the actual cleanup. */
  readonly onDeadSession: (sid: number) => void;
}

const EXPIRE_TIME_RE = /^\s*SQLNET\.EXPIRE_TIME\s*=\s*(\d+)\s*$/im;

export class DeadConnectionMonitor {
  private readonly cfg: DeadConnectionMonitorConfig;

  constructor(cfg: DeadConnectionMonitorConfig) {
    this.cfg = cfg;
  }

  /** SQLNET.EXPIRE_TIME in minutes; 0 means DCD is disabled. */
  expireTimeMinutes(): number {
    const content = this.cfg.readSqlnetOra();
    if (!content) return 0;
    const m = EXPIRE_TIME_RE.exec(content);
    if (!m) return 0;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  get enabled(): boolean {
    return this.expireTimeMinutes() > 0;
  }

  expireIntervalMs(): number {
    return this.expireTimeMinutes() * 60_000;
  }

  /**
   * Run one DCD sweep: probe every remote USER session and terminate the
   * ones whose client is unreachable. Returns the sids that were killed.
   */
  async check(): Promise<number[]> {
    if (!this.enabled) return [];
    const killed: number[] = [];
    for (const session of this.cfg.listSessions()) {
      if (session.type !== 'USER') continue;
      if (!session.clientIp) continue;
      const reachable = await this.cfg.isReachable(session.clientIp);
      if (reachable) continue;
      this.cfg.onDeadSession(session.sid);
      killed.push(session.sid);
    }
    return killed;
  }
}
