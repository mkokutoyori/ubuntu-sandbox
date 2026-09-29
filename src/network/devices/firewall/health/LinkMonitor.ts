export type LinkMonitorProtocol = 'ping' | 'tcp-echo' | 'udp-echo' | 'http' | 'twamp';

export const DEFAULT_LINK_MONITOR_INTERVAL_MS = 500;
export const DEFAULT_LINK_MONITOR_FAILTIME = 5;
export const DEFAULT_LINK_MONITOR_RECOVERYTIME = 5;

export interface LinkMonitorConfig {
  readonly name: string;
  readonly srcintf: string;
  readonly servers: readonly string[];
  readonly protocol: LinkMonitorProtocol;
  readonly gatewayIp: string;
  readonly sourceIp: string;
  readonly port: number;
  readonly intervalMs: number;
  readonly failtime: number;
  readonly recoverytime: number;
  readonly updateStaticRoute: boolean;
  readonly status: boolean;
}

export interface LinkMonitorServerState {
  readonly server: string;
  readonly alive: boolean;
  readonly sent: number;
  readonly received: number;
}

export interface LinkMonitorStatus {
  readonly name: string;
  readonly srcintf: string;
  readonly protocol: LinkMonitorProtocol;
  readonly sourceIp: string;
  readonly alive: boolean;
  readonly servers: readonly LinkMonitorServerState[];
}

export type LinkMonitorProbe = (server: string, srcintf: string) => boolean;

export class LinkMonitorTable {
  private readonly monitors = new Map<string, LinkMonitorConfig>();
  private readonly failures = new Map<string, number>();
  private readonly successes = new Map<string, number>();
  private readonly alive = new Map<string, boolean>();

  set(config: LinkMonitorConfig): void {
    this.monitors.set(config.name, Object.freeze({ ...config }));
    if (!this.alive.has(config.name)) this.alive.set(config.name, true);
  }

  get(name: string): LinkMonitorConfig | undefined {
    return this.monitors.get(name);
  }

  remove(name: string): boolean {
    this.failures.delete(name);
    this.successes.delete(name);
    this.alive.delete(name);
    return this.monitors.delete(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.monitors.keys()]);
  }

  evaluate(probe: LinkMonitorProbe): readonly LinkMonitorStatus[] {
    return [...this.monitors.values()].map(monitor => this.measure(monitor, probe));
  }

  private measure(monitor: LinkMonitorConfig, probe: LinkMonitorProbe): LinkMonitorStatus {
    const servers = monitor.servers.map(server => {
      const answered = monitor.protocol === 'ping' && monitor.status
        ? probe(server, monitor.srcintf) : false;
      return { server, alive: answered, sent: 1, received: answered ? 1 : 0 };
    });
    const reachable = servers.some(entry => entry.alive);
    return {
      name: monitor.name,
      srcintf: monitor.srcintf,
      protocol: monitor.protocol,
      sourceIp: monitor.sourceIp,
      alive: this.declare(monitor, reachable),
      servers,
    };
  }

  private declare(monitor: LinkMonitorConfig, reachable: boolean): boolean {
    const wasAlive = this.alive.get(monitor.name) ?? true;
    if (reachable) {
      this.failures.set(monitor.name, 0);
      const seen = (this.successes.get(monitor.name) ?? 0) + 1;
      this.successes.set(monitor.name, seen);
      if (!wasAlive && seen < monitor.recoverytime) return false;
      this.alive.set(monitor.name, true);
      return true;
    }
    this.successes.set(monitor.name, 0);
    const seen = (this.failures.get(monitor.name) ?? 0) + 1;
    this.failures.set(monitor.name, seen);
    if (wasAlive && seen < monitor.failtime) return true;
    this.alive.set(monitor.name, false);
    return false;
  }
}
