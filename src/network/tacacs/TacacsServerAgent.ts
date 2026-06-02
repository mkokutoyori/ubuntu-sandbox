import type { IEventBus } from '@/events/EventBus';
import {
  type TacacsServerAgentConfig, type TacacsPacket, type TacacsUser,
  type TacacsAuthenStatus, type TacacsAuthorStatus,
  type TacacsBody, type TacacsHeader,
  createDefaultServerConfig, defaultUser,
  PORT_TACACS,
} from './types';
import type { TcpStack } from '../tcp/TcpStack';
import { Logger } from '../core/Logger';

export interface TacacsServerHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
}

export class TacacsServerAgent {
  private config: TacacsServerAgentConfig = createDefaultServerConfig();
  private running = false;
  private listenerInstalled = false;

  constructor(
    private readonly host: TacacsServerHost,
    private readonly getBus: () => IEventBus,
    private readonly getTcpStack: () => TcpStack,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installListener();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.listenerInstalled) {
      this.getTcpStack().closeListener(this.config.port);
      this.listenerInstalled = false;
    }
  }

  getConfig(): Readonly<TacacsServerAgentConfig> { return this.config; }
  setEnabled(on: boolean): void { this.config.enabled = on; }
  setSharedSecret(secret: string): void { this.config.sharedSecret = secret; }

  addUser(username: string, password: string, privLvl = 1, permittedCommands: string[] = []): void {
    const u = defaultUser(username, password, privLvl);
    for (const c of permittedCommands) u.permittedCommands.add(c);
    this.config.users.set(username, u);
  }

  removeUser(username: string): void { this.config.users.delete(username); }

  listUsers(): TacacsUser[] { return Array.from(this.config.users.values()); }

  getAccountingLog(): ReadonlyArray<{ user: string; cmd: string; flags: string[]; ts: number }> {
    return this.config.acctLog.map((r) => ({ ...r, flags: r.flags.slice() }));
  }

  private installListener(): void {
    if (this.listenerInstalled) return;
    this.getTcpStack().listen(this.config.port, {
      onAccept: (socket) => {
        socket.onData((data) => {
          if (!this.config.enabled) { socket.close(); return; }
          const pkt = data as TacacsPacket | undefined;
          if (!pkt || pkt.type !== 'tacacs') { socket.close(); return; }
          this.getBus().publish({
            topic: 'tacacs.packet.received',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              fromIp: socket.remoteIp, sessionId: pkt.header.sessionId,
              bodyType: pkt.body.type,
            },
          });
          const reply = this.computeReply(pkt);
          if (reply) {
            this.getBus().publish({
              topic: 'tacacs.packet.sent',
              payload: {
                deviceId: this.host.id, hostname: this.host.getHostname(),
                destinationIp: socket.remoteIp,
                sessionId: reply.header.sessionId, bodyType: reply.body.type,
              },
            });
            socket.send(reply);
          }
          socket.close();
        });
      },
    });
    this.listenerInstalled = true;
  }

  private computeReply(request: TacacsPacket): TacacsPacket | null {
    if (request.body.type === 'tacacs-authen-start') {
      const username = request.body.user;
      const password = request.body.data;
      const user = this.config.users.get(username);
      const status: TacacsAuthenStatus = user && user.password === password ? 'pass' : 'fail';
      const body: TacacsBody = {
        type: 'tacacs-authen-reply',
        status, flags: 0,
        serverMsg: status === 'pass' ? 'OK' : 'Authentication failed', data: '',
      };
      Logger.info(this.host.id, 'tacacs:authen-reply',
        `${this.host.name}: ${username} → ${status}`);
      return this.wrap(request.header, 1, body);
    }
    if (request.body.type === 'tacacs-author-request') {
      const username = request.body.user;
      const cmd = this.extractCmd(request.body.args);
      const user = this.config.users.get(username);
      let status: TacacsAuthorStatus;
      if (!user) status = 'fail';
      else if (cmd === null || user.permittedCommands.size === 0 || user.permittedCommands.has(cmd)) status = 'pass-add';
      else status = 'fail';
      const body: TacacsBody = {
        type: 'tacacs-author-reply',
        status, args: [], serverMsg: status === 'fail' ? 'Command denied' : '', data: '',
      };
      return this.wrap(request.header, 2, body);
    }
    if (request.body.type === 'tacacs-acct-request') {
      const cmd = this.extractCmd(request.body.args);
      this.config.acctLog.push({
        user: request.body.user, cmd: cmd ?? '',
        flags: request.body.flags.slice(), ts: Date.now(),
      });
      const body: TacacsBody = {
        type: 'tacacs-acct-reply',
        status: 'success', serverMsg: '', data: '',
      };
      return this.wrap(request.header, 3, body);
    }
    return null;
  }

  private extractCmd(args: string[]): string | null {
    for (const a of args) {
      const m = /^cmd=(.*)$/i.exec(a);
      if (m) return m[1];
    }
    return null;
  }

  private wrap(requestHeader: TacacsHeader, type: number, body: TacacsBody): TacacsPacket {
    const header: TacacsHeader = {
      version: 0xc1, type, seqNo: requestHeader.seqNo + 1, flags: 0,
      sessionId: requestHeader.sessionId, length: 64,
    };
    return { type: 'tacacs', header, body };
  }
}

void PORT_TACACS;
