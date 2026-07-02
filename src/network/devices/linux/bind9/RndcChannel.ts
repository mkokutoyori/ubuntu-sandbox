import type { Bind9Service } from './Bind9Service';

const CONTROL_ENDPOINT = '127.0.0.1#953';
const BIND_VERSION = 'BIND 9.18.28-0ubuntu0.22.04.1-Ubuntu (Extended Support Version) <id:>';

export class RndcChannel {
  constructor(private readonly bind9: Bind9Service) {}

  dispatch(args: string[]): string {
    const [command, ...rest] = args;
    if (!command) {
      return 'rndc: no command specified\nUsage: rndc [-c config] command';
    }
    if (!this.bind9.isRunning()) {
      return `rndc: connect failed: ${CONTROL_ENDPOINT}: connection refused`;
    }
    switch (command) {
      case 'status':
        return this.status();
      case 'reload':
        return this.reload(rest[0]);
      case 'reconfig': {
        const result = this.bind9.reload();
        return result.ok ? '' : `rndc: 'reconfig' failed: ${result.error}`;
      }
      case 'flush':
        this.bind9.flushCache();
        return '';
      case 'freeze': {
        const result = this.bind9.freezeZone(rest[0] ?? '');
        return result.ok ? '' : `rndc: 'freeze' failed: ${result.error}`;
      }
      case 'thaw': {
        const result = this.bind9.thawZone(rest[0] ?? '');
        return result.ok
          ? 'The zone reload and thaw was successful.'
          : `rndc: 'thaw' failed: ${result.error}`;
      }
      case 'querylog':
        return this.querylog(rest[0]);
      default:
        return `rndc: unknown command '${command}'`;
    }
  }

  private status(): string {
    return [
      `version: ${BIND_VERSION}`,
      `number of zones: ${this.bind9.zoneCount()} (0 automatic)`,
      'debug level: 0',
      'xfers running: 0',
      'xfers deferred: 0',
      'soa queries in progress: 0',
      `query logging is ${this.bind9.isQueryLogEnabled() ? 'ON' : 'OFF'}`,
      'recursive clients: 0/900/1000',
      'tcp clients: 0/150',
      'server is up and running',
    ].join('\n');
  }

  private reload(zoneName: string | undefined): string {
    if (!zoneName) {
      const result = this.bind9.reload();
      return result.ok ? 'server reload successful' : `rndc: 'reload' failed: ${result.error}`;
    }
    const result = this.bind9.reloadZone(zoneName);
    if (!result.ok) return `rndc: 'reload' failed: ${result.error}`;
    return result.changed ? 'zone reload successful' : 'zone reload up-to-date';
  }

  private querylog(mode: string | undefined): string {
    if (mode === 'on') this.bind9.setQueryLog(true);
    else if (mode === 'off') this.bind9.setQueryLog(false);
    else if (mode === undefined) this.bind9.setQueryLog(!this.bind9.isQueryLogEnabled());
    else return `rndc: syntax error, unexpected '${mode}'`;
    return '';
  }
}
