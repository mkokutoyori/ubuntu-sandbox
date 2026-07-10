/**
 * Fail2banAgent — reactive bridge between SshAuthThrottler-emitted
 * `auth_throttled` events and the host's iptables / fail2ban log.
 *
 * Mirrors the classic Fail2ban+sshd jail (`/etc/fail2ban/jail.d/sshd.conf`
 * with `action = iptables[name=SSH, port=ssh, protocol=tcp]`) :
 *
 *   1. On first use, the jail creates its own dedicated chain
 *      (`f2b-sshd`) and jumps INPUT traffic for the jailed port into
 *      it — exactly like real fail2ban's `actionstart`, so
 *      `iptables -L f2b-sshd -n -v` shows the jail's own rule set
 *      separately from the rest of INPUT.
 *   2. Each `auth_throttled` event inserts a REJECT rule for the
 *      offending IP at the top of that chain (`actionban`).
 *   3. The agent writes `/var/log/fail2ban.log` in Fail2ban's wire
 *      format: `… fail2ban.actions [PID]: NOTICE  [sshd] Ban <ip>`.
 *   4. When `sweepExpired(now)` is called and a ban's `until`
 *      timestamp has passed, or `forceUnban(ip)` is called directly
 *      (`fail2ban-client set sshd unbanip`), the corresponding rule is
 *      removed from the chain and a matching `Unban <ip>` line is
 *      appended.
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
   *   `['-N', 'f2b-sshd']`
   *   `['-I', 'f2b-sshd', '1', '-s', '10.0.0.20', '-j', 'REJECT']`
   *   `['-D', 'f2b-sshd', '-s', '10.0.0.20', '-j', 'REJECT']`
   */
  execute(args: string[]): { exitCode: number };
  /** Whether the named chain already exists in the filter table. */
  hasChain(name: string): boolean;
}

export interface Fail2banJournalSink {
  /** Record one ban/unban action against the `fail2ban` systemd unit. */
  log(action: string): void;
}

export interface Fail2banAgentOptions {
  /** Jail name shown in fail2ban.log (default 'sshd'). */
  readonly jailName?: string;
  /** Process id shown in fail2ban.log (default 1717, like a real fail2ban-server pid). */
  readonly pid?: number;
  /** Clock for log timestamps. Default Date.now. */
  readonly clock?: () => number;
  /** Jailed TCP port (default 22 — sshd). */
  readonly port?: number;
  /**
   * Optional bridge to the device's systemd journal, so `journalctl -u
   * fail2ban` shows the same Ban/Unban actions as /var/log/fail2ban.log —
   * matching how a real fail2ban.service's actions are visible through
   * journald as well as its own log file.
   */
  readonly journal?: Fail2banJournalSink;
}

export interface Fail2banBan {
  readonly ip: string;
  readonly bannedAt: number;
  readonly until: number;
}

const CHAIN_PREFIX = 'f2b-';

export class Fail2banAgent {
  private readonly jailName: string;
  private readonly pid: number;
  private readonly clock: () => number;
  private readonly port: number;
  private readonly chainName: string;
  private readonly active = new Map<string, Fail2banBan>();
  private readonly unsubscribe: () => void;
  private readonly journal: Fail2banJournalSink | null;

  constructor(
    bus: ISshServerEventBus,
    private readonly iptables: Fail2banIptablesSink,
    private readonly log: Fail2banLogSink,
    opts: Fail2banAgentOptions = {},
  ) {
    this.jailName = opts.jailName ?? 'sshd';
    this.pid = opts.pid ?? 1717;
    this.clock = opts.clock ?? Date.now;
    this.port = opts.port ?? 22;
    this.chainName = `${CHAIN_PREFIX}${this.jailName}`;
    this.journal = opts.journal ?? null;
    const offFailure = bus.on('auth_failure', (e) => this.handleFailure(e));
    const offThrottled = bus.on('auth_throttled', (e) => this.handleThrottled(e));
    this.unsubscribe = () => { offFailure(); offThrottled(); };
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
      this.unban(ip, now);
      lifted.push(ip);
    }
    return lifted;
  }

  /**
   * `fail2ban-client set <jail> unbanip <ip>` — force-remove a ban
   * regardless of its remaining time. Returns false when the IP was
   * not actually banned.
   */
  forceUnban(ip: string): boolean {
    if (!this.active.has(ip)) return false;
    this.unban(ip, this.clock());
    return true;
  }

  /** `fail2ban-client get <jail> bantime` — configured ban duration, in seconds. */
  bantimeSeconds(): number {
    const ban = this.bans()[0];
    return ban ? Math.round((ban.until - ban.bannedAt) / 1000) : 0;
  }

  // ─── private ─────────────────────────────────────────────────────

  private ensureChain(): void {
    if (this.iptables.hasChain(this.chainName)) return;
    this.iptables.execute(['-N', this.chainName]);
    this.iptables.execute(['-A', this.chainName, '-j', 'RETURN']);
    this.iptables.execute(['-I', 'INPUT', '-p', 'tcp', '--dport', String(this.port), '-j', this.chainName]);
  }

  private unban(ip: string, now: number): void {
    this.iptables.execute(['-D', this.chainName, '-s', ip, '-j', 'REJECT']);
    this.active.delete(ip);
    this.log.appendLog(this.formatLogLine(now, `Unban ${ip}`));
    this.journal?.log(`[${this.jailName}] Unban ${ip}`);
  }

  /**
   * Every matched auth-failure line is one `Found <ip>` entry in real
   * fail2ban.log — logged before the eventual `Ban` line, regardless of
   * how many attempts it takes to cross the jail's threshold.
   */
  private handleFailure(event: SshServerEvent): void {
    if (event.kind !== 'auth_failure') return;
    if (this.active.has(event.ip)) return; // already banned — no more Found lines
    const now = this.clock();
    this.log.appendLog(this.formatLogLine(now, `Found ${event.ip}`, 'WARNING'));
  }

  private handleThrottled(event: SshServerEvent): void {
    if (event.kind !== 'auth_throttled') return;
    if (this.active.has(event.ip)) return; // already banned — be idempotent
    const now = this.clock();
    const ban: Fail2banBan = { ip: event.ip, bannedAt: now, until: event.blockUntil };
    this.active.set(event.ip, ban);
    this.ensureChain();
    this.iptables.execute(['-I', this.chainName, '1', '-s', event.ip, '-j', 'REJECT']);
    this.log.appendLog(this.formatLogLine(now, `Ban ${event.ip}`));
    this.journal?.log(`[${this.jailName}] Ban ${event.ip}`);
  }

  private formatLogLine(at: number, action: string, level: 'NOTICE' | 'WARNING' = 'NOTICE'): string {
    // Real fail2ban: `2024-06-30 12:34:56,000 fail2ban.actions
    //  [1234]: NOTICE  [sshd] Ban 10.0.0.20`
    const d = new Date(at);
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())},${pad(d.getUTCMilliseconds(), 3)}`;
    return `${ts} fail2ban.actions        [${this.pid}]: ${level}  [${this.jailName}] ${action}`;
  }
}
