/**
 * freeradius-equivalent service wrapper (PRD-RADIUS §2.2 "L'implémentation
 * freeradius sur Linux") — owns `clients.conf`/`users` parsing and applies
 * them to the already-built, already-tested `RadiusServerAgent`/
 * `RadiusTcpServer` engine. Mirrors `Bind9Service`'s shape: a config
 * loader/applier plus start/stop/restart/reload, wired into
 * `LinuxServiceManager` the same way `named` is.
 *
 * Scoped to the RADIUS engine's own single-shared-secret model: freeradius
 * itself supports a distinct secret per client, but `RadiusServerAgent`
 * doesn't — the first configured `client { }` block's secret becomes the
 * effective shared secret (documented simplification). `clients.conf`
 * doesn't drive `RadiusServerAgent.authorizeClient()`'s IP allow-list
 * either — that's a separate, pre-existing feature this PRD item doesn't
 * touch.
 */
import { knownGoodPassword } from '@/network/radius/KnownGoodPassword';
import { IPAddress } from '@/network/core/types';
import type { RadiusServerAgent } from '@/network/radius/RadiusServerAgent';
import type { RadiusTcpServer } from '@/network/radius/RadiusTcpTransport';
import { UDP_PORT_RADIUS_AUTH, UDP_PORT_RADIUS_ACCT } from '@/network/radius/types';
import { parseClientsConf } from './ClientsConfParser';
import type { RadiusClientEntry } from '@/network/radius/ClientTable';
import { parseUsersFile, matchUsersEntries, type UsersEntry } from './UsersFileParser';
import type { RadiusUser, RadiusAttribute, RadiusPacket } from '@/network/radius/types';
import { detailPath, detailEntry, type DetailRecord } from './DetailModule';
import type { RadiusAuthDecidedPayload } from '@/network/radius/events';
import { parseFreeradiusConf, type ConfFileReader } from './FreeradiusConf';
import { readRadiusdLogConfig, DEFAULT_RADIUS_LOG_FILE, type RadiusdLogConfig } from './RadiusdLogConfig';
import { readRadiusdSecurityConfig, type RadiusdSecurityConfig } from './RadiusdSecurityConfig';
import { readSiteConfig, describeListener, type ListenerSpec, type SiteConfig } from './RadiusdSiteConfig';
import { RadiusClientTable } from '@/network/radius/ClientTable';
import { formatCtime } from '../time/ctime';
import { formatLocalTime } from '../system/SystemInfo';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { OperationResult } from '../LinuxServiceManager';
import type { EndHost } from '@/network/devices/EndHost';

export interface RadiusdFiles {
  read(path: string): string | null;
  append(path: string, text: string, umask?: number): void;
  list?(path: string): readonly string[] | null;
}

export interface RadiusdWallClock {
  zone(): string | undefined;
  nowMs(): number;
}

export interface RadutmpEntry {
  login: string;
  nasPort: number;
  sessionId: string;
  nasAddress: string;
  framedAddress: string | null;
  protocol: 'P' | 'S' | 'T';
  portType: string;
  callerId: string;
  timeMs: number;
}

export interface RadiusdCheckReport {
  ok: boolean;
  logFile: string | null;
  errors: string[];
  mainFile: string;
  files: readonly string[];
}

export interface RadiusdListenOverride {
  authPort?: number;
  address?: string;
  debug?: boolean;
}

export interface RadiusdConfigPaths {
  main: string;
  clients: string;
  users: string;
}

const DEFAULT_SITE_FILE = '/etc/freeradius/3.0/sites-enabled/default';
const DEFAULT_SITE_AUTH_LISTEN_LINE = 59;

export const CLIENTS_CONF_PATH = '/etc/freeradius/3.0/clients.conf';
export const USERS_FILE_PATH = '/etc/freeradius/3.0/users';
export const RADIUSD_CONF_PATH = '/etc/freeradius/3.0/radiusd.conf';
const PROCESS_NAME = 'freeradius';

type ConfigLoadResult =
  | { ok: true; clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; security: RadiusdSecurityConfig; site: SiteConfig; files: readonly string[] }
  | { ok: false; error: string };

export class RadiusdService {
  private running = false;

  constructor(
    private readonly host: EndHost,
    private readonly radiusServer: RadiusServerAgent,
    private readonly radiusTcpServer: RadiusTcpServer,
    private readonly files: RadiusdFiles,
    private readonly clientsConfPath: string = CLIENTS_CONF_PATH,
    private readonly usersFilePath: string = USERS_FILE_PATH,
    private readonly wallClock: RadiusdWallClock = { zone: () => undefined, nowMs: () => simulationNowMs() },
  ) {}

  utmpEntries(): RadutmpEntry[] {
    return this.radiusServer.utmpSessions().map((record) => ({
      login: record.username.slice(0, 32),
      nasPort: record.utmp!.nasPort,
      sessionId: record.sessionId.slice(-8),
      nasAddress: record.nasIp,
      framedAddress: record.utmp!.framedAddress,
      protocol: record.utmp!.protocol,
      portType: record.utmp!.portType,
      callerId: record.utmp!.callerId,
      timeMs: record.utmp!.startedAtMs,
    }));
  }

  isRunning(): boolean {
    return this.running;
  }

  checkConfig(): OperationResult {
    const loaded = this.loadConfig();
    return loaded.ok ? { ok: true } : loaded;
  }

  checkConfigReport(paths?: RadiusdConfigPaths): RadiusdCheckReport {
    const main = paths?.main ?? RADIUSD_CONF_PATH;
    const loaded = this.loadConfig(paths);
    if (loaded.ok) return { ok: true, logFile: loaded.log.destination === 'files' ? loaded.log.file : null, errors: [], mainFile: main, files: loaded.files };
    const error = 'error' in loaded ? loaded.error : 'failed to start';
    const inMain = error.startsWith(main) || error.includes(`'${main}'`) || error.startsWith('radiusd: Error:');
    return {
      ok: false,
      logFile: inMain ? null : this.logConfig?.file ?? DEFAULT_RADIUS_LOG_FILE,
      errors: inMain ? [error, `Errors reading or parsing ${main}`] : [error],
      mainFile: main,
      files: [main],
    };
  }

  startFromCommandLine(listen: RadiusdListenOverride = {}): { ok: true } | { ok: false; errors: string[] } {
    if (listen.authPort !== undefined) {
      if (this.running) {
        return {
          ok: false,
          errors: listen.authPort === UDP_PORT_RADIUS_AUTH
            ? [`There appears to be another RADIUS server running on the authentication port ${listen.authPort}`]
            : ['A second daemon instance beside the running unit is not modelled in this simulator: stop it first with systemctl stop freeradius.'],
        };
      }
      const started = this.start(listen);
      return started.ok ? { ok: true } : { ok: false, errors: [started.error ?? 'failed to start'] };
    }
    if (this.running) {
      const first = this.activeListeners.find((spec) => spec.type === 'auth' || spec.type === 'auth+acct') ?? this.activeListeners[0];
      return {
        ok: false,
        errors: [
          `Failed binding to ${describeListener(first)}: Address already in use `,
          `${first.file === '' ? DEFAULT_SITE_FILE : first.file}[${first.file === '' ? DEFAULT_SITE_AUTH_LISTEN_LINE : first.line}]: Error binding to port for ${first.address ?? '0.0.0.0'} port ${first.port}`,
        ],
      };
    }
    const started = this.start({ debug: listen.debug });
    return started.ok ? { ok: true } : { ok: false, errors: [started.error ?? 'failed to start'] };
  }

  start(listen: RadiusdListenOverride = {}): OperationResult {
    if (this.running) return { ok: true };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    const specs: ListenerSpec[] = listen.authPort === undefined ? loaded.site.listeners : [
      { type: 'auth', address: listen.address ?? null, port: listen.authPort, server: 'default', file: '', line: 0 },
      { type: 'acct', address: listen.address ?? null, port: listen.authPort + 1, server: 'default', file: '', line: 0 },
    ];
    const bound: number[] = [];
    const tables = this.serverClientTables(loaded.site);
    const handlerOf = (spec: ListenerSpec) => (dgram: { inPort: string; sourceIP: unknown; udp: never }): void => {
      if (!(dgram.sourceIP instanceof IPAddress)) return;
      const udp = dgram.udp as { payload?: { code?: string } };
      if (spec.type === 'auth') this.radiusServer.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
      else if (spec.type === 'acct') this.radiusServer.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
      else if (spec.type === 'status') this.radiusServer.handleStatusUdp(dgram.inPort, dgram.sourceIP, dgram.udp, tables.get(spec.server) ?? this.radiusServer.clientTable);
      else if (udp.payload?.code === 'accounting-request') this.radiusServer.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
      else this.radiusServer.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    };
    for (const spec of specs) {
      const owner = spec.address === null ? {} : { acceptsDestination: (destination: { toString(): string }) => destination.toString() === spec.address };
      let bindFailed = false;
      try {
        bindFailed = this.host.udpBind(spec.port, handlerOf(spec) as never, PROCESS_NAME, owner as never) === false;
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith('EADDRINUSE'))) throw error;
        bindFailed = true;
      }
      if (bindFailed) {
        for (const taken of bound) this.host.udpClose(taken);
        const what = spec.type === 'acct' ? 'accounting' : spec.type === 'status' ? 'status' : 'authentication';
        return { ok: false, error: `There appears to be another RADIUS server running on the ${what} port ${spec.port}` };
      }
      bound.push(spec.port);
    }
    const authPort = specs.find((spec) => spec.type === 'auth' || spec.type === 'auth+acct')?.port ?? UDP_PORT_RADIUS_AUTH;
    const acctPort = specs.find((spec) => spec.type === 'acct')?.port ?? authPort;
    this.activeListeners = specs;
    this.radiusServer.setAnyPort(true);

    this.applyConfig(loaded);
    this.radiusServer.setPorts(authPort, acctPort);
    this.radiusServer.start();
    this.radiusTcpServer.start();
    this.radiusServer.setDecisionListener((payload) => this.writeAuthLog(payload));
    this.radiusServer.setAccountingListener((record) => this.writeDetail(record));
    this.radiusServer.setWarningListener((message) => this.writeLogLine('Warning', message));
    this.radiusServer.setUnknownClientListener((event) => this.writeLogLine('Error',
      `Ignoring request to ${this.listenerNamed(event.kind, event.port)} from unknown client ${event.clientIp} port ${event.clientPort} proto udp`));
    this.boundPorts = bound;
    this.running = true;
    this.debugMode = listen.debug === true;
    if (!this.debugMode) this.writeLogLine('Info', 'Ready to process requests');
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    if (!this.debugMode) {
      this.writeLogLine('Info', 'Signalled to terminate');
      this.writeLogLine('Info', 'Exiting normally');
    }
    this.radiusServer.setDecisionListener(null);
    this.radiusServer.setAccountingListener(null);
    this.radiusServer.setWarningListener(null);
    this.radiusServer.setUnknownClientListener(null);
    for (const port of this.boundPorts) this.host.udpClose(port);
    this.boundPorts = [];
    this.radiusServer.stop();
    this.radiusTcpServer.stop();
    this.running = false;
  }

  restart(): OperationResult {
    this.stop();
    return this.start();
  }

  reload(): OperationResult {
    if (!this.running) return { ok: false, error: 'freeradius is not running' };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    this.applyConfig(loaded);
    return { ok: true };
  }

  appendLog(path: string, text: string): void { this.files.append(path, text); }

  private writeDetail(record: DetailRecord): void {
    const settings = this.logConfig?.detail ?? null;
    if (settings === null) return;
    this.files.append(detailPath(settings, record), detailEntry(settings, record), ~settings.permissions & 0o777);
  }

  private boundPorts: number[] = [];
  private activeListeners: ListenerSpec[] = [];

  listeners(): readonly ListenerSpec[] { return this.activeListeners; }

  private listenerNamed(kind: 'auth' | 'acct', port: number): string {
    const spec = this.activeListeners.find((candidate) => candidate.port === port && (candidate.type === kind || candidate.type === 'auth+acct'))
      ?? { type: kind, address: null, port, server: 'default' } as ListenerSpec;
    return describeListener(spec);
  }

  private serverClientTables(site: SiteConfig): Map<string, RadiusClientTable> {
    const tables = new Map<string, RadiusClientTable>();
    for (const [name, entries] of site.serverClients) {
      const table = new RadiusClientTable();
      for (const entry of entries) table.add(entry);
      tables.set(name, table);
    }
    return tables;
  }
  private debugMode = false;
  private logConfig: RadiusdLogConfig | null = null;

  private writeAuthLog(payload: RadiusAuthDecidedPayload): void {
    const log = this.logConfig;
    if (log === null || log.destination !== 'files') return;
    const logged = payload.accepted ? log.auth || log.authAccept : log.auth || log.authReject;
    if (!logged) return;
    const cli = payload.callingStationId === null ? '' : ` cli ${payload.callingStationId}`;
    const user = payload.username === null ? '<no User-Name attribute>' : String(payload.username);
    const line = (message: string, withPassword: boolean): void => this.writeLogLine('Auth', `(${payload.number}) ${message}: `
      + `[${user}${withPassword ? `/${payload.password}` : ''}] (from client ${payload.clientShortname} port ${payload.nasPort}${cli})`);
    if (payload.precedingMessage !== undefined) line(payload.precedingMessage, log.authGoodpass);
    line(payload.accepted ? 'Login OK' : 'Login incorrect', payload.accepted ? log.authGoodpass : log.authBadpass);
  }

  private writeLogLine(level: string, message: string): void {
    const log = this.logConfig;
    if (log === null || log.destination !== 'files') return;
    this.files.append(log.file, `${formatCtime(new Date(simulationNowMs()))} : ${level}: ${message}\n`);
  }

  private resolveUser(entries: UsersEntry[], username: string, attributes: RadiusAttribute[]): RadiusUser | undefined {
    const match = matchUsersEntries(entries, username, (name) => attributes.find((candidate) => candidate.type === name)?.value);
    if (match === null || match.rejected) return undefined;
    const known = knownGoodPassword(match.knownGood);
    if (known === null && !match.acceptAny) return undefined;
    return {
      username, password: known?.cleartext ?? match.password ?? '', verify: known?.verify,
      acceptAny: match.acceptAny, replyAttributes: match.reply, ...(match.loginTime === null ? {} : { loginTime: match.loginTime }),
      ...(match.simultaneousUse === null ? {} : { simultaneousUse: match.simultaneousUse }),
    };
  }

  private confReader(): ConfFileReader {
    const read = ((path: string) => this.files.read(path)) as ConfFileReader;
    read.list = (path) => this.files.list?.(path) ?? null;
    return read;
  }

  private loadConfig(paths?: RadiusdConfigPaths): ConfigLoadResult {
    const mainPath = paths?.main ?? RADIUSD_CONF_PATH;
    const clientsPath = paths?.clients ?? this.clientsConfPath;
    const usersPath = paths?.users ?? this.usersFilePath;
    const mainSource = this.files.read(mainPath);
    if (mainSource === null) return { ok: false, error: `Unable to open file '${mainPath}': No such file or directory` };
    const main = parseFreeradiusConf(mainSource, mainPath, this.confReader());
    if ('error' in main) return { ok: false, error: main.error };
    const log = readRadiusdLogConfig(main.root);
    if ('error' in log) return { ok: false, error: log.error };
    const security = readRadiusdSecurityConfig(main.root);
    if ('error' in security) return { ok: false, error: security.error };
    const site = readSiteConfig(main.root);
    if ('error' in site) return { ok: false, error: site.error };
    const clientsSource = this.files.read(clientsPath);
    if (clientsSource === null) return { ok: false, error: `open: ${clientsPath}: file not found` };
    const usersSource = this.files.read(usersPath);
    if (usersSource === null) return { ok: false, error: `open: ${usersPath}: file not found` };
    const parsed = parseClientsConf(clientsSource, clientsPath, (path) => this.files.read(path));
    if (parsed.errors.length > 0) return { ok: false, error: parsed.errors[0] };
    const users = parseUsersFile(usersSource, usersPath, (path) => this.files.read(path));
    if ('error' in users) return { ok: false, error: users.error };
    return { ok: true, clients: parsed.clients, users: users.entries, log, security, site, files: main.files };
  }

  private applyConfig(loaded: { clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; security: RadiusdSecurityConfig }): void {
    this.logConfig = loaded.log;
    this.radiusServer.setStatusServer(loaded.security.statusServer);
    this.radiusServer.setDeniedMessage(loaded.log.msgDenied);
    this.radiusServer.setWallClock(() => this.wallClock.nowMs(), (epochMs) => {
      const [day, hour, minute] = formatLocalTime('%w %H %M', epochMs, this.wallClock.zone()).split(' ').map(Number);
      return day * 1440 + hour * 60 + minute;
    });
    this.radiusServer.setRejectReplyMessage(null);
    const secret = loaded.clients[0].secret;
    this.radiusServer.setSharedSecret(secret);
    this.radiusServer.clientTable.clear();
    for (const client of loaded.clients) this.radiusServer.clientTable.add(client);
    this.radiusServer.setUserResolver((username, context) => this.resolveUser(loaded.users, username, context?.attributes ?? []));
  }
}
