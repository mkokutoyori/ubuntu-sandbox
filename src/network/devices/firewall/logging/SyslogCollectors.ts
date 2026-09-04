import type { SyslogAgent } from '../../../syslog/SyslogAgent';
import type {
  SyslogFacilityName, SyslogSeverityName,
} from '../../../syslog/types';

export interface SyslogCollectorSettings {
  readonly collector: string;
  readonly enabled: boolean;
  readonly server: string;
  readonly port: number;
  readonly transport: 'udp' | 'tcp';
  readonly facility: string;
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
  return declared === 'kernel' ? 'kern'
    : declared === 'user' ? 'user'
      : declared === 'daemon' ? 'daemon'
        : declared === 'syslog' ? 'syslog'
          : 'local7';
}
