import type { Bind9Service } from './Bind9Service';
import { bindStatusVersion } from './BindVersion';

const CONTROL_ENDPOINT = '127.0.0.1#953';

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
      case 'flushname':
      case 'flushtree': {
        if (rest[0] === undefined) return `rndc: '${command}' failed: unexpected end of input`;
        if (command === 'flushname') this.bind9.flushName(rest[0]);
        else this.bind9.flushTree(rest[0]);
        return '';
      }
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
      case 'sync': {
        const zoneName = rest.find((word) => !word.startsWith('-')) ?? '';
        const result = this.bind9.syncZone(zoneName);
        return result.ok ? '' : `rndc: 'sync' failed: ${result.error}`;
      }
      case 'querylog':
        return this.querylog(rest[0]);
      case 'retransfer': {
        const result = this.bind9.retransferZone(rest[0] ?? '');
        return result.ok ? '' : `rndc: 'retransfer' failed: ${result.error}`;
      }
      case 'stop':
      case 'halt':
        this.bind9.stop();
        return '';
      case 'dumpdb': {
        const result = this.bind9.dumpDatabase(rest);
        return result.ok ? '' : `rndc: 'dumpdb' failed: ${result.error}`;
      }
      case 'secroots': {
        const result = this.bind9.secureRootsReport();
        return result.ok ? '' : `rndc: 'secroots' failed: ${result.error}`;
      }
      case 'validation':
        return this.validation(rest[0]);
      default:
        return `rndc: unknown command '${command}'`;
    }
  }

  private status(): string {
    return [
      `version: ${bindStatusVersion()}`,
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
    if (!result.ok) {
      return result.error === 'not found'
        ? `rndc: 'reload' failed: not found\nno matching zone '${zoneName}' in any view`
        : `rndc: 'reload' failed: ${result.error}`;
    }
    return result.changed ? 'zone reload queued' : 'zone reload up-to-date';
  }

  private querylog(mode: string | undefined): string {
    if (mode === 'on') this.bind9.setQueryLog(true);
    else if (mode === 'off') this.bind9.setQueryLog(false);
    else if (mode === undefined) this.bind9.setQueryLog(!this.bind9.isQueryLogEnabled());
    else return `rndc: syntax error, unexpected '${mode}'`;
    return '';
  }

  private validation(mode: string | undefined): string {
    if (mode === 'on') {
      this.bind9.setDnssecValidation(true);
      return '';
    }
    if (mode === 'off') {
      this.bind9.setDnssecValidation(false);
      return '';
    }
    if (mode === 'status' || mode === undefined) {
      return `DNSSEC validation is ${this.bind9.isDnssecValidationEnabled() ? 'enabled' : 'disabled'}.`;
    }
    return `rndc: syntax error, unexpected '${mode}'`;
  }
}
