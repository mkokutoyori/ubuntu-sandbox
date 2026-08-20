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
import { parseClientsConf, type ParsedClient } from './ClientsConfParser';
import { parseUsersFile, type ParsedUsersEntry } from './UsersFileParser';
import type { OperationResult } from '../LinuxServiceManager';
import type { EndHost } from '@/network/devices/EndHost';

export interface RadiusdFiles {
  read(path: string): string | null;
}

export const CLIENTS_CONF_PATH = '/etc/freeradius/3.0/clients.conf';
export const USERS_FILE_PATH = '/etc/freeradius/3.0/users';
const PROCESS_NAME = 'freeradius';

type ConfigLoadResult =
  | { ok: true; clients: ParsedClient[]; users: ParsedUsersEntry[] }
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
    this.running = true;
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
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

  private loadConfig(): ConfigLoadResult {
    const clientsSource = this.files.read(this.clientsConfPath);
    if (clientsSource === null) return { ok: false, error: `open: ${this.clientsConfPath}: file not found` };
    const usersSource = this.files.read(this.usersFilePath);
    if (usersSource === null) return { ok: false, error: `open: ${this.usersFilePath}: file not found` };
    const clients = parseClientsConf(clientsSource);
    if (clients.length === 0) {
      return { ok: false, error: `${this.clientsConfPath}: no client { } block with a secret found` };
    }
    return { ok: true, clients, users: parseUsersFile(usersSource) };
  }

  private applyConfig(loaded: { clients: ParsedClient[]; users: ParsedUsersEntry[] }): void {
    const secret = loaded.clients[0].secret;
    this.radiusServer.setSharedSecret(secret);
    this.radiusTcpServer.setSharedSecret(secret);
    for (const user of loaded.users) {
      this.radiusServer.addUser(user.username, user.password);
      this.radiusTcpServer.addUser(user.username, user.password);
    }
  }
}
