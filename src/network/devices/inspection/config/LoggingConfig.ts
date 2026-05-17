/**
 * LoggingConfig — config-driven syslog/logging state (Lot C).
 *
 * `logging …` commands mutate this real Repository instead of being
 * swallowed as no-ops; `show logging` projects it. Defaults match IOS.
 */
const SEVERITIES = [
  'emergencies', 'alerts', 'critical', 'errors', 'warnings',
  'notifications', 'informational', 'debugging',
] as const;
type Severity = typeof SEVERITIES[number];

function normSeverity(tok: string): Severity | null {
  const t = tok.toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(t)) return t as Severity;
  const n = parseInt(t, 10);
  return Number.isNaN(n) || n < 0 || n > 7 ? null : SEVERITIES[n];
}

export class LoggingConfig {
  enabled = true;                       // `logging on` (IOS default on)
  buffered = false;
  bufferedSize = 4096;
  bufferedSeverity: Severity = 'debugging';
  consoleSeverity: Severity = 'debugging';
  monitorSeverity: Severity = 'debugging';
  trapSeverity: Severity = 'informational';
  facility = 'local7';
  sourceInterface: string | null = null;
  sequenceNumbers = false;
  timestamps = false;
  readonly hosts: string[] = [];

  /** Apply `logging …` (negate=false) or `no logging …` (negate=true). */
  apply(args: string[], negate: boolean): void {
    const head = (args[0] ?? '').toLowerCase();
    switch (head) {
      case '':
      case 'on':
        this.enabled = !negate;
        return;
      case 'buffered': {
        this.buffered = !negate;
        for (const a of args.slice(1)) {
          if (/^\d+$/.test(a)) this.bufferedSize = parseInt(a, 10);
          else { const s = normSeverity(a); if (s) this.bufferedSeverity = s; }
        }
        return;
      }
      case 'console': {
        const s = normSeverity(args[1] ?? '');
        if (s) this.consoleSeverity = s;
        return;
      }
      case 'monitor': {
        const s = normSeverity(args[1] ?? '');
        if (s) this.monitorSeverity = s;
        return;
      }
      case 'trap': {
        const s = normSeverity(args[1] ?? '');
        if (s) this.trapSeverity = s;
        return;
      }
      case 'facility':
        if (args[1]) this.facility = args[1];
        return;
      case 'source-interface':
        this.sourceInterface = negate ? null : (args[1] ?? null);
        return;
      case 'host': {
        const ip = args[1];
        if (!ip) return;
        if (negate) {
          const i = this.hosts.indexOf(ip);
          if (i >= 0) this.hosts.splice(i, 1);
        } else if (!this.hosts.includes(ip)) {
          this.hosts.push(ip);
        }
        return;
      }
      default:
        // `logging <ip>` — bare host form.
        if (/^\d+\.\d+\.\d+\.\d+$/.test(head)) {
          if (negate) {
            const i = this.hosts.indexOf(head);
            if (i >= 0) this.hosts.splice(i, 1);
          } else if (!this.hosts.includes(head)) {
            this.hosts.push(head);
          }
        }
        // Other knobs (rate-limit, queue-limit, count…) are accepted
        // and intentionally not modelled as state.
    }
  }

  /** `show logging` projection of the real configured state. */
  render(): string {
    const lvl = (s: Severity) => `level ${s}`;
    const lines = [
      `Syslog logging: ${this.enabled ? 'enabled' : 'disabled'}` +
        ' (0 messages dropped, 0 flushes, 0 overruns)',
      `    Console logging: ${lvl(this.consoleSeverity)}`,
      `    Monitor logging: ${lvl(this.monitorSeverity)}`,
      `    Buffer logging: ${this.buffered
        ? `${lvl(this.bufferedSeverity)}, ${this.bufferedSize} bytes`
        : 'disabled'}`,
      `    Trap logging: ${lvl(this.trapSeverity)}`,
      `    Facility: ${this.facility}`,
      `    Timestamp${this.timestamps ? 's' : ''} logging: ` +
        `${this.timestamps ? 'enabled' : 'disabled'}`,
      `    Sequence numbers: ${this.sequenceNumbers ? 'enabled' : 'disabled'}`,
    ];
    if (this.sourceInterface) {
      lines.push(`    Source interface: ${this.sourceInterface}`);
    }
    if (this.hosts.length) {
      for (const h of this.hosts) lines.push(`    Logging to ${h}`);
    } else {
      lines.push('    No active syslog hosts');
    }
    return lines.join('\n');
  }

  reset(): void {
    this.enabled = true;
    this.buffered = false;
    this.hosts.length = 0;
    this.sourceInterface = null;
    this.sequenceNumbers = false;
    this.timestamps = false;
  }
}
