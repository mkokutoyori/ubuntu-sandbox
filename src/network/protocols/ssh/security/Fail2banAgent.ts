/**
 * Fail2banAgent — reactive bridge between SshAuthThrottler-emitted
 * `auth_throttled` events and the host's iptables / fail2ban log.
 *
 * Mirrors the classic Fail2ban+sshd jail (`/etc/fail2ban/jail.d/sshd.conf`
 * with `action = iptables[name=SSH, port=ssh, protocol=tcp]`) :
 *
 *   1. Each `auth_throttled` event triggers
 *        `iptables -I INPUT -s <ip> -j REJECT`
 *      (a *real* INPUT rule, so the host's data plane refuses the
 *      attacker even with the right password — exactly the contract
 *      Fail2ban enforces).
 *   2. The agent writes `/var/log/fail2ban.log` in Fail2ban's wire
 *      format: `… fail2ban.actions [PID]: NOTICE  [sshd] Ban <ip>`.
 *   3. When `sweepExpired(now)` is called and a ban's `until`
 *      timestamp has passed, the corresponding iptables rule is
 *      removed and a matching `Unban <ip>` line is appended.
 *
 * Time is injected via `clock` so tests can fast-forward
 * deterministically — production code wires it to the real
 * SshAuthThrottler clock (Date.now by default).
 */

import type { ISshServerEventBus, SshServerEvent } from '../server/SshServerEvent';

export interface Fail2banLogSink {
  /** Append one line (with trailing newline) to /var/log/fail2ban.log. */
  appendLog(line: string): void;
}

export interface Fail2banIptablesSink {
  /**
   * Run an `iptables` invocation against the host's filter table —
   * same args as the real cmd line:
   *   `['-I', 'INPUT', '-s', '10.0.0.20', '-j', 'REJECT']`
   *   `['-D', 'INPUT', '-s', '10.0.0.20', '-j', 'REJECT']`
   */
  execute(args: string[]): { exitCode: number };
}

export interface Fail2banAgentOptions {
  /** Jail name shown in fail2ban.log (default 'sshd'). */
  readonly jailName?: string;
  /** Process id shown in fail2ban.log (default 1717, like a real fail2ban-server pid). */
  readonly pid?: number;
  /** Clock for log timestamps. Default Date.now. */
  readonly clock?: () => number;
}

export interface Fail2banBan {
  readonly ip: string;
  readonly bannedAt: number;
  readonly until: number;
}

export class Fail2banAgent {
  private readonly jailName: string;
  private readonly pid: number;
  private readonly clock: () => number;
  private readonly active = new Map<string, Fail2banBan>();
  private readonly unsubscribe: () => void;

  constructor(
    bus: ISshServerEventBus,
    private readonly iptables: Fail2banIptablesSink,
    private readonly log: Fail2banLogSink,
    opts: Fail2banAgentOptions = {},
  ) {
    this.jailName = opts.jailName ?? 'sshd';
    this.pid = opts.pid ?? 1717;
    this.clock = opts.clock ?? Date.now;
    this.unsubscribe = bus.on('auth_throttled', (e) => this.handle(e));
  }

  /** Detach from the event bus. */
  dispose(): void { this.unsubscribe(); }

  /** Currently-banned IPs as far as fail2ban is concerned. */
  bannedIps(): readonly string[] {
    return Array.from(this.active.keys());
  }

  /** Snapshot of the ban entries (for `fail2ban-client status sshd`). */
  bans(): readonly Fail2banBan[] {
    return Array.from(this.active.values());
  }

  /**
   * Remove every ban whose `until` ≤ `now`, deleting the iptables
   * rule and appending an Unban line per IP. Returns the IPs that
   * were lifted.
   */
  sweepExpired(now: number): readonly string[] {
    const lifted: string[] = [];
    for (const [ip, ban] of Array.from(this.active.entries())) {
      if (now < ban.until) continue;
      this.iptables.execute(['-D', 'INPUT', '-s', ip, '-j', 'REJECT']);
      this.active.delete(ip);
      this.log.appendLog(this.formatLogLine(now, `Unban ${ip}`));
      lifted.push(ip);
    }
    return lifted;
  }

  // ─── private ─────────────────────────────────────────────────────

  private handle(event: SshServerEvent): void {
    if (event.kind !== 'auth_throttled') return;
    if (this.active.has(event.ip)) return; // already banned — be idempotent
    const now = this.clock();
    const ban: Fail2banBan = { ip: event.ip, bannedAt: now, until: event.blockUntil };
    this.active.set(event.ip, ban);
    this.iptables.execute(['-I', 'INPUT', '-s', event.ip, '-j', 'REJECT']);
    this.log.appendLog(this.formatLogLine(now, `Ban ${event.ip}`));
  }

  private formatLogLine(at: number, action: string): string {
    // Real fail2ban: `2024-06-30 12:34:56,000 fail2ban.actions
    //  [1234]: NOTICE  [sshd] Ban 10.0.0.20`
    const d = new Date(at);
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())},${pad(d.getUTCMilliseconds(), 3)}`;
    return `${ts} fail2ban.actions        [${this.pid}]: NOTICE  [${this.jailName}] ${action}`;
  }
}
