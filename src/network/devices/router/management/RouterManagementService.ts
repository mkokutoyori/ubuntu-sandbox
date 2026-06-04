export interface RawConfigEntry {
  feature: string;
  index: number;
  line: string;
  recordedAtMs: number;
}

export class RouterManagementService {
  private readonly stelnetServer = { enabled: false, port: 22, acl: undefined as string | undefined };
  private readonly telnetServer = { enabled: false, port: 23, acl: undefined as string | undefined };
  private readonly sshServer = { enabled: false, port: 22, version: 2, timeout: 60, retries: 3 };
  private readonly snmpAgent = {
    enabled: false,
    communities: new Map<string, { name: string; access: 'ro' | 'rw'; aclName?: string }>(),
    sysContact: '',
    sysLocation: '',
    sysName: '',
    trapHosts: [] as Array<{ host: string; community: string; version: string }>,
  };
  private readonly ntpService = {
    enabled: true,
    sourceInterface: '',
    authentication: false,
    authKeys: new Map<number, { algo: string; key: string }>(),
    trustedKeys: new Set<number>(),
    accessAcl: undefined as string | undefined,
    masterStratum: undefined as number | undefined,
    refclock: '',
  };
  private readonly clockCfg = {
    timezone: 'UTC',
    offsetMin: 0,
    summerTimezone: '',
    daylightStart: '',
    daylightEnd: '',
    daylightOffsetMin: 60,
  };
  private readonly infoCenter = {
    enabled: true,
    timestamp: 'date',
    sources: [] as Array<{ source: string; channel: number; severity: string }>,
    loghosts: [] as Array<{ ip: string; channel: number; facility: string }>,
  };
  private readonly sflow = {
    enabled: false,
    agentIp: '' as string,
    collectors: [] as Array<{ id: number; ip: string; port: number }>,
    samplers: [] as Array<{ iface: string; rate: number }>,
  };
  private readonly raw: RawConfigEntry[] = [];

  recordRaw(feature: string, line: string): void {
    this.raw.push({ feature, index: this.raw.length + 1, line, recordedAtMs: Date.now() });
  }
  getRawEntries(feature?: string): readonly RawConfigEntry[] {
    return feature ? this.raw.filter(r => r.feature === feature) : [...this.raw];
  }

  configureStelnet(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'server' && args[1]?.toLowerCase() === 'enable') this.stelnetServer.enabled = true;
    else if (head === 'server' && args[1]?.toLowerCase() === 'disable') this.stelnetServer.enabled = false;
    else if (head === 'server' && args[1]?.toLowerCase() === 'port' && args[2]) this.stelnetServer.port = parseInt(args[2], 10);
    else this.recordRaw('stelnet', args.join(' '));
  }
  getStelnet(): typeof this.stelnetServer { return this.stelnetServer; }

  configureTelnet(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'server' && args[1]?.toLowerCase() === 'enable') this.telnetServer.enabled = true;
    else if (head === 'server' && args[1]?.toLowerCase() === 'disable') this.telnetServer.enabled = false;
    else if (head === 'server-source' && args[1]) this.telnetServer.acl = args[1];
    else this.recordRaw('telnet', args.join(' '));
  }
  getTelnet(): typeof this.telnetServer { return this.telnetServer; }

  configureSsh(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'server' && args[1]?.toLowerCase() === 'enable') this.sshServer.enabled = true;
    else if (head === 'server' && args[1]?.toLowerCase() === 'port' && args[2]) this.sshServer.port = parseInt(args[2], 10);
    else if (head === 'server' && args[1]?.toLowerCase() === 'compatible-ssh1x') { /* ignored */ }
    else if (head === 'client' && args[1]?.toLowerCase() === 'first-time') { /* ignored */ }
    else this.recordRaw('ssh', args.join(' '));
  }
  getSsh(): typeof this.sshServer { return this.sshServer; }

  configureSnmp(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    this.snmpAgent.enabled = true;
    if (head === 'sys-info' && args[1]?.toLowerCase() === 'contact' && args[2]) {
      this.snmpAgent.sysContact = args.slice(2).join(' ');
    } else if (head === 'sys-info' && args[1]?.toLowerCase() === 'location' && args[2]) {
      this.snmpAgent.sysLocation = args.slice(2).join(' ');
    } else if (head === 'sys-info' && args[1]?.toLowerCase() === 'version') {
      /* version flags */
    } else if (head === 'community' && args[1]) {
      const access = args[2]?.toLowerCase() === 'rw' ? 'rw' : 'ro';
      this.snmpAgent.communities.set(args[1], { name: args[1], access, aclName: args[3] });
    } else if (head === 'target-host' || head === 'trap-source') {
      this.snmpAgent.trapHosts.push({
        host: args[1] ?? 'unknown', community: args[2] ?? '', version: args[3] ?? 'v2c',
      });
    } else {
      this.recordRaw('snmp', args.join(' '));
    }
  }
  getSnmp(): typeof this.snmpAgent { return this.snmpAgent; }

  configureNtp(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'unicast-server' && args[1]) {
      this.recordRaw('ntp', `unicast-server ${args.slice(1).join(' ')}`);
    } else if (head === 'source-interface' && args[1]) {
      this.ntpService.sourceInterface = args[1];
    } else if (head === 'authentication' && args[1]?.toLowerCase() === 'enable') {
      this.ntpService.authentication = true;
    } else if (head === 'authentication-keyid' && args[1] && args[2] && args[3]) {
      const id = parseInt(args[1], 10);
      if (!isNaN(id)) this.ntpService.authKeys.set(id, { algo: args[2], key: args[3] });
    } else if (head === 'reliable' && args[1]?.toLowerCase() === 'authentication-keyid' && args[2]) {
      const id = parseInt(args[2], 10);
      if (!isNaN(id)) this.ntpService.trustedKeys.add(id);
    } else if (head === 'access-acl' && args[1]) {
      this.ntpService.accessAcl = args[1];
    } else if (head === 'master' && args[1]) {
      this.ntpService.masterStratum = parseInt(args[1], 10);
    } else if (head === 'refclock-master' && args[1]) {
      this.ntpService.refclock = args[1];
    } else {
      this.recordRaw('ntp', args.join(' '));
    }
  }
  getNtp(): typeof this.ntpService { return this.ntpService; }

  configureClock(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'timezone' && args[1] && args[3]) {
      this.clockCfg.timezone = args[1];
      const m = /^([-+])(\d{1,2}):(\d{2})$/.exec(args[3]);
      if (m) {
        const sign = m[1] === '-' ? -1 : 1;
        this.clockCfg.offsetMin = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
      }
    } else if (head === 'daylight-saving-time') {
      this.clockCfg.summerTimezone = args[1] ?? '';
      this.clockCfg.daylightStart = args.slice(3, 6).join(' ');
      this.clockCfg.daylightEnd = args.slice(7, 10).join(' ');
    } else {
      this.recordRaw('clock', args.join(' '));
    }
  }
  getClock(): typeof this.clockCfg { return this.clockCfg; }

  configureInfoCenter(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'enable') this.infoCenter.enabled = true;
    else if (head === 'disable') this.infoCenter.enabled = false;
    else if (head === 'timestamp' && args[1]) this.infoCenter.timestamp = args[1];
    else if (head === 'source' && args[1]) {
      const chIdx = args.indexOf('channel');
      const sevIdx = args.indexOf('level');
      const channel = chIdx > -1 && args[chIdx + 1] ? parseInt(args[chIdx + 1], 10) : 0;
      const severity = sevIdx > -1 && args[sevIdx + 1] ? args[sevIdx + 1] : 'informational';
      this.infoCenter.sources.push({ source: args[1], channel, severity });
    } else if (head === 'loghost' && args[1]) {
      const chIdx = args.indexOf('channel');
      const facIdx = args.indexOf('facility');
      this.infoCenter.loghosts.push({
        ip: args[1],
        channel: chIdx > -1 && args[chIdx + 1] ? parseInt(args[chIdx + 1], 10) : 2,
        facility: facIdx > -1 && args[facIdx + 1] ? args[facIdx + 1] : 'local7',
      });
    } else {
      this.recordRaw('info-center', args.join(' '));
    }
  }
  getInfoCenter(): typeof this.infoCenter { return this.infoCenter; }

  configureSflow(args: string[]): void {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'agent' && args[1] === 'ip' && args[2]) {
      this.sflow.agentIp = args[2];
      this.sflow.enabled = true;
    } else if (head === 'collector' && args[1]) {
      const id = parseInt(args[1], 10);
      let ip = '', port = 6343;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === 'ip' && args[i + 1]) { ip = args[i + 1]; i++; }
        else if (args[i] === 'port' && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
      }
      if (!isNaN(id)) this.sflow.collectors.push({ id, ip, port });
      this.sflow.enabled = true;
    } else if (head === 'sampling' && args[1] === 'rate' && args[2]) {
      this.sflow.samplers.push({ iface: 'global', rate: parseInt(args[2], 10) });
    } else {
      this.recordRaw('sflow', args.join(' '));
    }
  }
  getSflow(): typeof this.sflow { return this.sflow; }
}
