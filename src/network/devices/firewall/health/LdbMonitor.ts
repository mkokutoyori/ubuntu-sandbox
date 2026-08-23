export type LdbMonitorType = 'ping' | 'tcp';

export const DEFAULT_LDB_INTERVAL_SEC = 10;
export const DEFAULT_LDB_TIMEOUT_SEC = 2;
export const DEFAULT_LDB_RETRY = 3;
export const INHERIT_REAL_SERVER_PORT = 0;

export interface LdbMonitor {
  readonly name: string;
  readonly type: LdbMonitorType;
  readonly intervalSec: number;
  readonly timeoutSec: number;
  readonly retry: number;
  readonly port: number;
}

export interface MonitorTarget {
  readonly address: string;
  readonly port: number;
}

export interface MonitorProbes {
  readonly ping: (address: string) => Promise<boolean>;
  readonly tcp: (address: string, port: number) => Promise<boolean>;
}

export class LdbMonitorTable {
  private readonly monitors = new Map<string, LdbMonitor>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly probes: MonitorProbes) {}

  set(monitor: LdbMonitor): void {
    this.monitors.set(monitor.name, Object.freeze({ ...monitor }));
  }

  get(name: string): LdbMonitor | undefined {
    return this.monitors.get(name);
  }

  remove(name: string): boolean {
    return this.monitors.delete(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.monitors.keys()]);
  }

  async check(
    names: readonly string[], key: string, target: MonitorTarget,
  ): Promise<boolean> {
    const declared = names
      .map(name => this.monitors.get(name))
      .filter((monitor): monitor is LdbMonitor => monitor !== undefined);
    if (declared.length === 0) return true;

    for (const monitor of declared) {
      if (!await this.probe(monitor, target)) return this.noteFailure(key, monitor);
    }
    this.failures.delete(key);
    return true;
  }

  private async probe(monitor: LdbMonitor, target: MonitorTarget): Promise<boolean> {
    if (monitor.type === 'ping') return this.probes.ping(target.address);
    const port = monitor.port === INHERIT_REAL_SERVER_PORT ? target.port : monitor.port;
    return this.probes.tcp(target.address, port);
  }

  private noteFailure(key: string, monitor: LdbMonitor): boolean {
    const seen = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, seen);
    return seen < monitor.retry;
  }
}
