import type { SyslogAgent } from '../../../syslog/SyslogAgent';
import {
  SYSLOG_FACILITY, SYSLOG_SEVERITY,
  type SyslogFacilityName, type SyslogSeverityName,
} from '../../../syslog/types';
import {
  logLevelAtLeast, type FirewallLogLevel, type FirewallLogRecord,
} from './FirewallLogStore';

export interface SyslogCollectorSettings {
  readonly collector: string;
  readonly enabled: boolean;
  readonly server: string;
  readonly port: number;
  readonly transport: 'udp' | 'tcp';
  readonly facility: string;
  readonly format: string;
  readonly sourceInterface: string;
}

export interface SyslogFilterSettings {
  readonly collector: string;
  readonly severity: string;
  readonly forwardTraffic: boolean;
  readonly localTraffic: boolean;
  readonly multicastTraffic: boolean;
}

const DEFAULT_SEVERITY: SyslogSeverityName = 'informational';

const RECORD_SEVERITY: Readonly<Record<FirewallLogLevel, SyslogSeverityName>> = Object.freeze({
  emergency: 'emergency', alert: 'alert', critical: 'critical', error: 'error',
  warning: 'warning', notice: 'notification', information: 'informational', debug: 'debugging',
});

const FILTER_LEVEL: Readonly<Record<string, FirewallLogLevel>> = Object.freeze({
  emergency: 'emergency', alert: 'alert', critical: 'critical', error: 'error',
  warning: 'warning', notification: 'notice', information: 'information', debug: 'debug',
});

const FORTIOS_FACILITY: Readonly<Record<string, number>> = Object.freeze({
  kernel: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9,
  authpriv: 10, ftp: 11, ntp: 12, audit: 13, alert: 14, clock: 15,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23,
});

export type RecordRenderer = (format: string, facility: number) => string;

export class SyslogCollectorTable {
  private readonly settings = new Map<string, SyslogCollectorSettings>();
  private readonly filters = new Map<string, SyslogFilterSettings>();

  constructor(private readonly agent: () => SyslogAgent) {}

  applySettings(patch: SyslogCollectorSettings): void {
    this.settings.set(patch.collector, patch);
    this.project();
  }

  applyFilter(patch: SyslogFilterSettings): void {
    this.filters.set(patch.collector, patch);
    this.project();
  }

  filterOf(collector: string): SyslogFilterSettings | undefined {
    return this.filters.get(collector);
  }

  forwardRecord(record: FirewallLogRecord, render: RecordRenderer): void {
    const severity = RECORD_SEVERITY[record.level];
    for (const entry of this.active()) {
      if (!this.accepts(entry.collector, record)) continue;

      const facility = FORTIOS_FACILITY[entry.facility] ?? FORTIOS_FACILITY.local7;
      const text = render(entry.format, facility);
      const line = text.startsWith('<') ? text
        : `<${facility * 8 + SYSLOG_SEVERITY[severity]}>${text}`;
      this.agent().sendVerbatim(entry.server, severity, line);
    }
  }

  private accepts(collector: string, record: FirewallLogRecord): boolean {
    const filter = this.filters.get(collector);
    const threshold = FILTER_LEVEL[filter?.severity ?? 'information'] ?? 'information';
    if (!logLevelAtLeast(record.level, threshold)) return false;
    if (record.type !== 'traffic') return true;

    switch (record.subtype) {
      case 'local': return filter?.localTraffic === true;
      case 'multicast': return filter?.multicastTraffic !== false;
      default: return filter?.forwardTraffic !== false;
    }
  }

  active(): readonly SyslogCollectorSettings[] {
    return [...this.settings.values()]
      .filter(entry => entry.enabled && entry.server.length > 0);
  }

  private project(): void {
    const agent = this.agent();
    const wanted = this.active();

    const keep = new Set(wanted.map(entry => entry.server));
    for (const server of agent.listServers()) {
      if (!keep.has(server.ip)) agent.removeServer(server.ip);
    }

    if (wanted.length === 0) { agent.setEnabled(false); return; }

    for (const entry of wanted) {
      agent.addServer(entry.server, {
        facility: facilityOf(entry.facility),
        severityThreshold: severityOf(this.filters.get(entry.collector)?.severity),
        port: entry.port,
        transport: entry.transport,
        delimiter: true,
      });
    }

    const source = wanted.find(entry => entry.sourceInterface.length > 0);
    agent.setSourceInterface(source?.sourceInterface ?? null);
    agent.setEnabled(true);
    agent.start();
  }
}

export function severityOf(declared: string | undefined): SyslogSeverityName {
  switch (declared) {
    case 'emergency': return 'emergency';
    case 'alert': return 'alert';
    case 'critical': return 'critical';
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'notification': return 'notification';
    case 'debug': return 'debugging';
    default: return DEFAULT_SEVERITY;
  }
}

function facilityOf(declared: string): SyslogFacilityName {
  if (declared === 'kernel') return 'kern';
  return declared in SYSLOG_FACILITY ? declared as SyslogFacilityName : 'local7';
}
