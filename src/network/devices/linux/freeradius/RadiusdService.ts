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
import type { RadiusUser, RadiusAttribute } from '@/network/radius/types';
import type { RadiusAuthDecidedPayload } from '@/network/radius/events';
import { parseFreeradiusConf } from './FreeradiusConf';
import { readRadiusdLogConfig, type RadiusdLogConfig } from './RadiusdLogConfig';
import { formatCtime } from '../time/ctime';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { OperationResult } from '../LinuxServiceManager';
import type { EndHost } from '@/network/devices/EndHost';

export interface RadiusdFiles {
  read(path: string): string | null;
  append(path: string, text: string): void;
}

export const CLIENTS_CONF_PATH = '/etc/freeradius/3.0/clients.conf';
export const USERS_FILE_PATH = '/etc/freeradius/3.0/users';
export const RADIUSD_CONF_PATH = '/etc/freeradius/3.0/radiusd.conf';
const PROCESS_NAME = 'freeradius';

type ConfigLoadResult =
  | { ok: true; clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig }
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

  start(): OperationResult {
    if (this.running) return { ok: true };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    this.applyConfig(loaded);

    this.radiusServer.start();
    this.radiusTcpServer.start();
    this.host.udpBind(UDP_PORT_RADIUS_AUTH, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.radiusServer.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, PROCESS_NAME);
    this.host.udpBind(UDP_PORT_RADIUS_ACCT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.radiusServer.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, PROCESS_NAME);
    this.radiusServer.setDecisionListener((payload) => this.writeAuthLog(payload));
    this.running = true;
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    this.radiusServer.setDecisionListener(null);
    this.host.udpClose(UDP_PORT_RADIUS_AUTH);
    this.host.udpClose(UDP_PORT_RADIUS_ACCT);
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

  private loadConfig(): ConfigLoadResult {
    const mainSource = this.files.read(RADIUSD_CONF_PATH);
    if (mainSource === null) return { ok: false, error: `Unable to open file '${RADIUSD_CONF_PATH}': No such file or directory` };
    const main = parseFreeradiusConf(mainSource, RADIUSD_CONF_PATH, (path) => this.files.read(path));
    if ('error' in main) return { ok: false, error: main.error };
    const log = readRadiusdLogConfig(main.root);
    if ('error' in log) return { ok: false, error: log.error };
    const clientsSource = this.files.read(this.clientsConfPath);
    if (clientsSource === null) return { ok: false, error: `open: ${this.clientsConfPath}: file not found` };
    const usersSource = this.files.read(this.usersFilePath);
    if (usersSource === null) return { ok: false, error: `open: ${this.usersFilePath}: file not found` };
    const parsed = parseClientsConf(clientsSource, this.clientsConfPath, (path) => this.files.read(path));
    if (parsed.errors.length > 0) return { ok: false, error: parsed.errors[0] };
    const users = parseUsersFile(usersSource, this.usersFilePath, (path) => this.files.read(path));
    if ('error' in users) return { ok: false, error: users.error };
    return { ok: true, clients: parsed.clients, users: users.entries, log };
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
