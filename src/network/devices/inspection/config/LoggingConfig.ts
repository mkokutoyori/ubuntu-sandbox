import { getDefaultEventBus } from '@/events/EventBus';

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
  private readonly messages: Array<{ ts: number; severity: Severity; tag: string; text: string }> = [];
  private nextSeq = 0;
  private readonly SEVERITY_ORDER: Record<Severity, number> = {
    emergencies: 0, alerts: 1, critical: 2, errors: 3,
    warnings: 4, notifications: 5, informational: 6, debugging: 7,
  };

  /** Append a log message into the buffered/console projection. */
  append(severity: Severity, tag: string, text: string): void {
    if (!this.enabled) return;
    if (this.SEVERITY_ORDER[severity] > this.SEVERITY_ORDER[this.bufferedSeverity]) return;
    this.messages.push({ ts: Date.now(), severity, tag, text });
    const cap = Math.max(16, Math.floor(this.bufferedSize / 80));
    while (this.messages.length > cap) this.messages.shift();
    this.nextSeq++;
  }

  attachToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): () => void {
    const isOurs = (e: { deviceId?: string }) => e.deviceId === deviceId;
    this.buffered = true;
    const unsubs = [
      bus.subscribeWhere('tcp.connection.opened', isOurs, (e) => {
        const p = e.payload;
        if (!p.passive) return;
        const tag = p.localPort === 22 ? 'ssh' : 'sec_login';
        const msg = p.localPort === 22
          ? `AUTHENTICATION: SSH connection from ${p.remoteIp}:${p.remotePort} accepted on port 22 (stelnet)`
          : `Login accepted: connection from ${p.remoteIp}:${p.remotePort} accepted on port ${p.localPort}`;
        this.append('notifications', tag, msg);
      }),
      bus.subscribeWhere('tcp.connection.closed', isOurs, (e) => {
        const p = e.payload;
        this.append('informational', 'sys',
          `Connection from ${p.remoteIp}:${p.remotePort} closed (${p.reason})`);
      }),
      bus.subscribeWhere('tcp.segment.dropped', isOurs, (e) => {
        const p = e.payload;
        this.append('warnings', 'tcp',
          `Segment dropped (${p.reason}) from ${p.sourceIp}:${p.sourcePort} to ${p.destinationIp}:${p.destinationPort}`);
      }),
      bus.subscribeWhere('tcp.listener.changed', isOurs, (e) => {
        const p = e.payload;
        this.append('notifications', 'sys',
          p.added
            ? `TCP listener bound to ${p.localIp}:${p.localPort}`
            : `TCP listener closed on ${p.localIp}:${p.localPort}`);
      }),
      bus.subscribeWhere('port.link.up', isOurs, (e) => {
        const p = e.payload;
        this.append('errors', 'link',
          `Interface ${p.portName}, changed state to up`);
      }),
      bus.subscribeWhere('port.link.down', isOurs, (e) => {
        const p = e.payload;
        this.append('errors', 'link',
          `Interface ${p.portName}, changed state to down`);
      }),
      bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('notifications', 'ospf',
          `Process ${p.processId}, Nbr ${p.neighborId} on ${p.iface} from ${p.oldState} to ${p.newState}, ${p.event}`);
      }),
      bus.subscribeWhere('hsrp.active.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; group?: number; oldState?: string; newState?: string };
        this.append('informational', 'hsrp',
          `${p.iface ?? 'iface'} Grp ${p.group ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('port.security.violation', isOurs, (e) => {
        const p = e.payload;
        this.append('critical', 'port_security',
          `Security violation occurred, caused by MAC address ${p.mac} on port ${p.portName}.`);
      }),
      bus.subscribeWhere('port.security.errdisable.set', isOurs, (e) => {
        const p = e.payload;
        this.append('critical', 'pm',
          `Interface ${p.portName} is err-disabled: psecure-violation`);
      }),
      bus.subscribeWhere('bfd.session.changed', isOurs, (e) => {
        const p = e.payload as { neighbor?: string; iface?: string; oldState?: string; newState?: string };
        this.append('notifications', 'bfd',
          `Session to neighbor ${p.neighbor ?? '?'} on ${p.iface ?? '?'} changed state from ${p.oldState ?? '?'} to ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('arp.violation', isOurs, (e) => {
        const p = e.payload as { iface?: string; senderIp?: string; senderMac?: string; reason?: string };
        this.append('warnings', 'dai',
          `DAI: ${p.iface ?? '?'}: Invalid ARP ${p.reason ?? ''} from ${p.senderMac ?? '?'}/${p.senderIp ?? '?'}`);
      }),
      bus.subscribeWhere('nat.translation.applied', isOurs, (e) => {
        const p = e.payload as { protocol?: string; insideLocal?: string; insideGlobal?: string };
        this.append('debugging', 'nat',
          `Translation: ${p.protocol ?? 'ip'} ${p.insideLocal ?? '?'} -> ${p.insideGlobal ?? '?'}`);
      }),
    ];
    const logHandler = (e: { payload: unknown }): void => {
      const p = e.payload as { source: string; level: string; event: string; message: string };
      if (p.source !== deviceId) return;
      if (p.event.startsWith('router:acl-deny')) {
        this.append('warnings', 'sec', p.message);
      }
    };
    unsubs.push(bus.subscribe('log', logHandler));
    const defaultBus = getDefaultEventBus();
    if (defaultBus !== bus) unsubs.push(defaultBus.subscribe('log', logHandler));
    return () => { for (const u of unsubs) u(); };
  }

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
    if (this.buffered && this.messages.length > 0) {
      lines.push('');
      lines.push('Log Buffer (' + this.bufferedSize + ' bytes):');
      lines.push('');
      for (const m of this.messages) {
        const sevNum = this.SEVERITY_ORDER[m.severity];
        const date = new Date(m.ts);
        const stamp = `${date.toISOString().slice(5, 19).replace('T', ' ')}`;
        lines.push(`${stamp}: %${m.tag.toUpperCase()}-${sevNum}-${m.severity.toUpperCase()}: ${m.text}`);
      }
    }
    return lines.join('\n');
  }

  renderHuawei(): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const lines = [
      `Logging buffer configuration and contents: ${this.enabled ? 'enabled' : 'disabled'}`,
      `Allowed max buffer size : ${this.bufferedSize}`,
      `Actual buffer size : ${this.bufferedSize}`,
      'Channel number : 4 , Channel name : logbuffer',
      'Dropped messages : 0',
      'Overwritten messages : 0',
      `Current messages : ${this.messages.length}`,
    ];
    for (const m of this.messages) {
      const d = new Date(m.ts);
      const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      const sevNum = this.SEVERITY_ORDER[m.severity];
      const tag = m.tag.toUpperCase();
      lines.push(`${stamp} %01${tag}/${sevNum}/${m.severity.toUpperCase()}: ${m.text}`);
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
