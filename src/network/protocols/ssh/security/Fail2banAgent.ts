/**
 * Fail2banAgent — the sshd jail of fail2ban, fed by the `auth_failure`
 * events the SSH server puts on its bus (the same lines the filter would
 * read in /var/log/auth.log).
 *
 *   1. Each failure is one `Found <ip>` line in /var/log/fail2ban.log.
 *   2. `maxretry` failures from one address inside `findtime` ban it:
 *      the jail creates its chain (`f2b-sshd`) on first use, jumps INPUT
 *      traffic for the jailed port into it, and inserts a REJECT rule for
 *      the address, so the refusal is the firewall's — nothing in sshd.
 *   3. `bantime` seconds later the rule is removed and an `Unban` line
 *      written; `forceUnban(ip)` is `fail2ban-client set sshd unbanip`.
 *   4. A jail whose service is not running sees nothing: no `Found`, no ban.
 */

import { simulationNowMs } from '@/network/core/SystemClock';

import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';

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

export interface Fail2banJail {
  readonly maxretry: number;
  readonly findtimeSeconds: number;
  readonly bantimeSeconds: number;
}

export interface Fail2banAgentOptions {
  readonly jail?: Fail2banJail;
  readonly isActive?: () => boolean;
  readonly scheduler?: IScheduler;
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
  private readonly failures = new Map<string, number[]>();
  private readonly expiryTimers = new Map<string, TimerHandle>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly journal: Fail2banJournalSink | null;
  private jail: Fail2banJail;
  private readonly isActive: () => boolean;
  private readonly scheduler: IScheduler;
  private totalFailedCount = 0;

  constructor(
    bus: ISshServerEventBus,
    private readonly iptables: Fail2banIptablesSink,
    private readonly log: Fail2banLogSink,
    opts: Fail2banAgentOptions = {},
  ) {
    this.jailName = opts.jailName ?? 'sshd';
    this.pid = opts.pid ?? 1717;
    this.clock = opts.clock ?? simulationNowMs;
    this.port = opts.port ?? 22;
    this.chainName = `${CHAIN_PREFIX}${this.jailName}`;
    this.journal = opts.journal ?? null;
    this.jail = opts.jail ?? { maxretry: 5, findtimeSeconds: 600, bantimeSeconds: 600 };
    this.isActive = opts.isActive ?? (() => true);
    this.scheduler = opts.scheduler ?? getDefaultScheduler();
    this.attach(bus);
  }

  attach(bus: ISshServerEventBus): void {
    this.unsubscribers.push(bus.on('auth_failure', (e) => this.handleFailure(e)));
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const handle of this.expiryTimers.values()) this.scheduler.clear(handle);
    this.expiryTimers.clear();
  }

  bannedIps(): readonly string[] {
    this.sweepExpired(this.clock());
    return Array.from(this.active.keys());
  }

  bans(): readonly Fail2banBan[] {
    this.sweepExpired(this.clock());
    return Array.from(this.active.values());
  }

  totalFailed(): number {
    return this.totalFailedCount;
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
    return this.jail.bantimeSeconds;
  }

  reconfigure(jail: Fail2banJail): void {
    this.jail = jail;
    this.failures.clear();
  }

  private ensureChain(): void {
    if (this.iptables.hasChain(this.chainName)) return;
    this.iptables.execute(['-N', this.chainName]);
    this.iptables.execute(['-A', this.chainName, '-j', 'RETURN']);
    this.iptables.execute(['-I', 'INPUT', '-p', 'tcp', '--dport', String(this.port), '-j', this.chainName]);
  }

  private unban(ip: string, now: number): void {
    this.iptables.execute(['-D', this.chainName, '-s', ip, '-j', 'REJECT']);
    this.active.delete(ip);
    const timer = this.expiryTimers.get(ip);
    if (timer !== undefined) this.scheduler.clear(timer);
    this.expiryTimers.delete(ip);
    this.log.appendLog(this.formatLogLine(now, `Unban ${ip}`));
    this.journal?.log(`[${this.jailName}] Unban ${ip}`);
  }

  private handleFailure(event: SshServerEvent): void {
    if (event.kind !== 'auth_failure' || event.reason === 'publickey_query') return;
    if (!this.isActive()) return;
    const now = this.clock();
    this.sweepExpired(now);
    if (this.active.has(event.ip)) return;
    this.totalFailedCount += 1;
    this.log.appendLog(this.formatLogLine(now, `Found ${event.ip}`, 'WARNING'));
    const windowMs = this.jail.findtimeSeconds * 1000;
    const recent = (this.failures.get(event.ip) ?? []).filter((at) => now - at < windowMs);
    recent.push(now);
    this.failures.set(event.ip, recent);
    if (recent.length >= this.jail.maxretry) this.ban(event.ip, now);
  }

  private ban(ip: string, now: number): void {
    const bantimeMs = this.jail.bantimeSeconds * 1000;
    this.active.set(ip, { ip, bannedAt: now, until: now + bantimeMs });
    this.failures.delete(ip);
    this.ensureChain();
    this.iptables.execute(['-I', this.chainName, '1', '-s', ip, '-j', 'REJECT']);
    this.log.appendLog(this.formatLogLine(now, `Ban ${ip}`));
    this.journal?.log(`[${this.jailName}] Ban ${ip}`);
    this.expiryTimers.set(ip, this.scheduler.setTimeout(() => this.sweepExpired(this.clock()), bantimeMs));
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
