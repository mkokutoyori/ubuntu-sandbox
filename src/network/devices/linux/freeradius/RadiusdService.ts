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
import { formatCtime } from '../time/ctime';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { OperationResult } from '../LinuxServiceManager';
import type { EndHost } from '@/network/devices/EndHost';

export interface RadiusdFiles {
  read(path: string): string | null;
  append(path: string, text: string, umask?: number): void;
  list?(path: string): readonly string[] | null;
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
  | { ok: true; clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; files: readonly string[] }
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
  ) {}

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
      return {
        ok: false,
        errors: [
          'Failed binding to auth address * port 1812 bound to server default: Address already in use ',
          `${DEFAULT_SITE_FILE}[${DEFAULT_SITE_AUTH_LISTEN_LINE}]: Error binding to port for 0.0.0.0 port 1812`,
        ],
      };
    }
    const started = this.start();
    return started.ok ? { ok: true } : { ok: false, errors: [started.error ?? 'failed to start'] };
  }

  start(listen: RadiusdListenOverride = {}): OperationResult {
    if (this.running) return { ok: true };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    const authPort = listen.authPort ?? UDP_PORT_RADIUS_AUTH;
    const acctPort = listen.authPort === undefined ? UDP_PORT_RADIUS_ACCT : listen.authPort + 1;
    const owner = listen.address === undefined ? {} : { acceptsDestination: (destination: { toString(): string }) => destination.toString() === listen.address };
    const bound: number[] = [];
    const bind = (port: number, handler: (dgram: { inPort: string; sourceIP: unknown; udp: never }) => void): boolean => {
      try {
        if (this.host.udpBind(port, handler as never, PROCESS_NAME, owner as never) === false) return false;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('EADDRINUSE')) return false;
        throw error;
      }
      bound.push(port);
      return true;
    };
    const failed = (port: number, what: string): OperationResult => {
      for (const taken of bound) this.host.udpClose(taken);
      return { ok: false, error: `There appears to be another RADIUS server running on the ${what} port ${port}` };
    };
    if (!bind(authPort, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.radiusServer.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    })) return failed(authPort, 'authentication');
    if (!bind(acctPort, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.radiusServer.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    })) return failed(acctPort, 'accounting');

    this.applyConfig(loaded);
    this.radiusServer.setPorts(authPort, acctPort);
    this.radiusServer.start();
    this.radiusTcpServer.start();
    this.radiusServer.setDecisionListener((payload) => this.writeAuthLog(payload));
    this.radiusServer.setAccountingListener((record) => this.writeDetail(record));
    this.boundPorts = bound;
    this.running = true;
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    this.radiusServer.setDecisionListener(null);
    this.radiusServer.setAccountingListener(null);
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
  private readonly fileUsers = new Set<string>();
  private logConfig: RadiusdLogConfig | null = null;

  private writeAuthLog(payload: RadiusAuthDecidedPayload): void {
    const log = this.logConfig;
    if (log === null || log.destination !== 'files') return;
    const logged = payload.accepted ? log.auth || log.authAccept : log.auth || log.authReject;
    if (!logged) return;
    const withPassword = payload.accepted ? log.authGoodpass : log.authBadpass;
    const cli = payload.callingStationId === null ? '' : ` cli ${payload.callingStationId}`;
    const user = payload.username === null ? '<no User-Name attribute>' : String(payload.username);
    const line = `${formatCtime(new Date(simulationNowMs()))} : Auth: (${payload.number}) ${payload.accepted ? 'Login OK' : 'Login incorrect'}: `
      + `[${user}${withPassword ? `/${payload.password}` : ''}] (from client ${payload.clientShortname} port ${payload.nasPort}${cli})\n`;
    this.files.append(log.file, line);
  }

  private resolveUser(entries: UsersEntry[], username: string, attributes: RadiusAttribute[]): RadiusUser | undefined {
    const match = matchUsersEntries(entries, username, (name) => attributes.find((candidate) => candidate.type === name)?.value);
    if (match === null || match.rejected || match.password === null) return undefined;
    return { username, password: match.password, replyAttributes: match.reply };
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
    const clientsSource = this.files.read(clientsPath);
    if (clientsSource === null) return { ok: false, error: `open: ${clientsPath}: file not found` };
    const usersSource = this.files.read(usersPath);
    if (usersSource === null) return { ok: false, error: `open: ${usersPath}: file not found` };
    const parsed = parseClientsConf(clientsSource, clientsPath, (path) => this.files.read(path));
    if (parsed.errors.length > 0) return { ok: false, error: parsed.errors[0] };
    const users = parseUsersFile(usersSource, usersPath, (path) => this.files.read(path));
    if ('error' in users) return { ok: false, error: users.error };
    return { ok: true, clients: parsed.clients, users: users.entries, log, files: main.files };
  }

  private applyConfig(loaded: { clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig }): void {
    this.logConfig = loaded.log;
    this.radiusServer.setRejectReplyMessage(null);
    const secret = loaded.clients[0].secret;
    this.radiusServer.setSharedSecret(secret);
    this.radiusTcpServer.setSharedSecret(secret);
    this.radiusServer.clientTable.clear();
    for (const client of loaded.clients) this.radiusServer.clientTable.add(client);
    for (const stale of this.fileUsers) this.radiusTcpServer.removeUser(stale);
    this.fileUsers.clear();
    for (const entry of loaded.users) {
      if (entry.name === 'DEFAULT') continue;
      const user = this.resolveUser(loaded.users, entry.name, []);
      if (!user) continue;
      this.fileUsers.add(user.username);
      this.radiusTcpServer.addUser(user.username, user.password);
    }
    this.radiusServer.setUserResolver((username, context) => this.resolveUser(loaded.users, username, context?.attributes ?? []));
  }
}
