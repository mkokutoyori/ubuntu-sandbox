import { InfoCenterConfig, type InfoCenterError } from './InfoCenterConfig';
import { vrpDatetimeToEpochMs } from '../../shells/huawei/huaweiClockDatetime';
import { parseVrpDaylightSaving } from '../../shells/huawei/huaweiDaylightSaving';
import { DeviceClockStore, type DeviceClockConfig } from '../../../core/time/DeviceClock';
import { PortNumber, PORT_ANY } from '../../../core/ports/PortNumber';

export interface RawConfigEntry {
  feature: string;
  index: number;
  line: string;
  recordedAtMs: number;
}

export const SSH_DEFAULT_PORT = 22;

/**
 * VRP : « The default listening port number of the SSH server is 22. A
 * private port number ranges from 1025 to 65535. » Le 22 reste admis en
 * plus de la plage privee, et rien d'autre en dessous de 1025.
 */
export function sshListenPortIsValid(port: number): boolean {
  if (!Number.isInteger(port)) return false;
  return port === SSH_DEFAULT_PORT || (port >= 1025 && port <= 65535);
}

export const SSH_DEFAULT_TIMEOUT_SEC = 60;
export const SSH_DEFAULT_AUTH_RETRIES = 3;

function positiveInteger(text: string | undefined): number | null {
  return /^\d+$/.test(text ?? '') && Number(text) > 0 ? Number(text) : null;
}

export const TELNET_DEFAULT_PORT = 23;

export function telnetListenPortIsValid(port: number): boolean {
  return PortNumber.isValid(port) && port !== PORT_ANY;
}

export function telnetServerAclIsValid(acl: string): boolean {
  if (/^\d+$/.test(acl)) {
    const n = Number(acl);
    return n >= 2000 && n <= 3999;
  }
  return /^[A-Za-z][\w-]*$/.test(acl);
}

export class RouterManagementService {
  domainName: string = '';
  ipDomainLookupEnabled: boolean = true;
  nameServers: string[] = [];
  private readonly telnetServer = {
    enabled: false,
    port: TELNET_DEFAULT_PORT,
    acl: undefined as string | undefined,
    source: undefined as string | undefined,
    ipv6Enabled: false,
  };
  /**
   * Le serveur SSH, cote GESTIONNAIRE : ce qu'il porte seul, c'est-a-dire
   * l'etat d'ecoute et le port. Le reste de la configuration `ip ssh`
   * (version, delai, tentatives, algorithmes) vit dans
   * `CiscoSecurityConfig.ssh`, le magasin que la CLI ecrit -- il y en
   * avait deux, avec des defauts qui se contredisaient.
   */
  private readonly sshServer = {
    enabled: false,
    port: SSH_DEFAULT_PORT,
    version: 2,
    timeout: SSH_DEFAULT_TIMEOUT_SEC,
    retries: SSH_DEFAULT_AUTH_RETRIES,
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
  constructor(private readonly clockStore: DeviceClockStore = new DeviceClockStore()) {}

  getClockStore(): DeviceClockStore { return this.clockStore; }
  private readonly infoCenter = new InfoCenterConfig();
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

  configureStelnet(args: string[], negated = false): string | null {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'server' && args[1]?.toLowerCase() === 'enable') this.sshServer.enabled = !negated;
    else if (head === 'server' && args[1]?.toLowerCase() === 'disable') this.sshServer.enabled = false;
    else if (head === 'server') return args[1] ?? head;
    else this.recordRaw('stelnet', args.join(' '));
    return null;
  }

  configureTelnet(args: string[], negated = false): string | null {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'server' && args[1]?.toLowerCase() === 'enable') this.telnetServer.enabled = !negated;
    else if (head === 'server' && args[1]?.toLowerCase() === 'disable') this.telnetServer.enabled = false;
    else if (head === 'server' && args[1]?.toLowerCase() === 'port') {
      if (negated) { this.telnetServer.port = TELNET_DEFAULT_PORT; return null; }
      const port = PortNumber.tryParse(args[2] ?? '');
      if (!port || !telnetListenPortIsValid(port.value)) return args[2] ?? '';
      this.telnetServer.port = port.value;
    }
    else if (head === 'server' && args[1]?.toLowerCase() === 'acl') {
      if (negated) { this.telnetServer.acl = undefined; return null; }
      const acl = args[2] ?? '';
      if (!telnetServerAclIsValid(acl)) return acl;
      this.telnetServer.acl = acl;
    }
    else if (head === 'ipv6' && args[1]?.toLowerCase() === 'server' && args[2]?.toLowerCase() === 'enable') {
      this.telnetServer.ipv6Enabled = !negated;
    }
    else if (head === 'server' || head === 'ipv6') return args[1] ?? head;
    else if (head === 'server-source') {
      if (negated) { this.telnetServer.source = undefined; return null; }
      if (args[1]?.toLowerCase() !== '-i' || !args[2]) return args[1] ?? '';
      this.telnetServer.source = args.slice(2).join('');
    }
    else this.recordRaw('telnet', args.join(' '));
    return null;
  }
  getTelnet(): typeof this.telnetServer { return this.telnetServer; }

  configureSsh(args: string[], negated = false): string | null {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'server' && args[1]?.toLowerCase() === 'enable') this.sshServer.enabled = !negated;
    else if (head === 'server' && args[1]?.toLowerCase() === 'port') {
      if (negated) { this.sshServer.port = SSH_DEFAULT_PORT; return null; }
      const port = Number.parseInt(args[2] ?? '', 10);
      if (!sshListenPortIsValid(port)) return args[2] ?? '';
      this.sshServer.port = port;
    }
    else if (head === 'server' && args[1]?.toLowerCase() === 'timeout') {
      if (negated) { this.sshServer.timeout = SSH_DEFAULT_TIMEOUT_SEC; return null; }
      const seconds = positiveInteger(args[2]);
      if (seconds === null) return args[2] ?? '';
      this.sshServer.timeout = seconds;
    }
    else if (head === 'server' && args[1]?.toLowerCase() === 'authentication-retries') {
      if (negated) { this.sshServer.retries = SSH_DEFAULT_AUTH_RETRIES; return null; }
      const retries = positiveInteger(args[2]);
      if (retries === null) return args[2] ?? '';
      this.sshServer.retries = retries;
    }
    else if (head === 'server') return args[1] ?? head;
    else if (head === 'client' && args[1]?.toLowerCase() === 'first-time') { /* ignored */ }
    else this.recordRaw('ssh', args.join(' '));
    return null;
  }
  getSsh(): typeof this.sshServer { return this.sshServer; }

  sshServerLimits(): { maxAuthTries: number; loginGraceTime: number } {
    return { maxAuthTries: this.sshServer.retries, loginGraceTime: this.sshServer.timeout };
  }

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

  configureClock(args: string[]): number | string | null {
    const head = (args[0] ?? '').toLowerCase();
    if (head === 'datetime') return vrpDatetimeToEpochMs(args.slice(1));
    if (head === 'daylight-saving-time') {
      const verdict = parseVrpDaylightSaving(args.slice(1));
      if (!verdict.rule) return verdict.badToken ?? '';
      this.clockStore.setSummer(verdict.rule);
    } else {
      this.recordRaw('clock', args.join(' '));
    }
    return null;
  }
  getClock(): DeviceClockConfig { return this.clockStore.get(); }

  /**
   * `info-center …` / `undo info-center …`.
   *
   * L'analyse vit dans `InfoCenterConfig` : ce qui tenait ici était un
   * `if/else` qui ne validait rien, empilait les collecteurs et rangeait
   * la ligne brute quand il ne comprenait pas. Il rend maintenant la
   * faute, que la coquille traduit dans les mots de VRP.
   */
  configureInfoCenter(args: string[], undo = false): InfoCenterError | null {
    return this.infoCenter.apply(args, undo);
  }

  getInfoCenter(): InfoCenterConfig { return this.infoCenter; }

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
