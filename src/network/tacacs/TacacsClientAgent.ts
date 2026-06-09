import type { IEventBus } from '@/events/EventBus';
import {
  type TacacsClientConfig, type TacacsServerConfig, type TacacsPacket,
  type TacacsAuthenStatus, type TacacsAuthorStatus, type TacacsAcctStatus, type TacacsAcctFlag,
  type TacacsHeader, type TacacsBody, type TacacsEncryptedBody,
  createDefaultClientConfig, defaultServerEntry,
  PORT_TACACS,
} from './types';
import { encryptBody, decryptBody } from './encryption';
import type { TcpStack, TcpSocket } from '../tcp/TcpStack';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { Logger } from '../core/Logger';

export interface TacacsClientHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
}

export class TacacsClientAgent {
  private config: TacacsClientConfig = createDefaultClientConfig();
  private nextSessionId = 1;
  private running = false;

  constructor(
    private readonly host: TacacsClientHost,
    private readonly getBus: () => IEventBus,
    private readonly getTcpStack: () => TcpStack,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  getConfig(): Readonly<TacacsClientConfig> { return this.config; }
  setEnabled(on: boolean): void { this.config.enabled = on; }

  addServer(ip: string, sharedSecret: string, opts: { port?: number; timeoutMs?: number } = {}): void {
    const existing = this.config.servers.find((s) => s.ip === ip);
    if (existing) {
      existing.sharedSecret = sharedSecret;
      if (opts.port) existing.port = opts.port;
      if (opts.timeoutMs) existing.timeoutMs = opts.timeoutMs;
      return;
    }
    const s = defaultServerEntry(ip, sharedSecret);
    if (opts.port) s.port = opts.port;
    if (opts.timeoutMs) s.timeoutMs = opts.timeoutMs;
    this.config.servers.push(s);
  }

  removeServer(ip: string): void {
    this.config.servers = this.config.servers.filter((s) => s.ip !== ip);
  }

  setNasIdentifier(id: string | null): void { this.config.nasIdentifier = id; }
  setSourceInterface(iface: string | null): void { this.config.sourceInterface = iface; }
  listServers(): TacacsServerConfig[] { return this.config.servers.slice(); }

  authenticate(username: string, password: string, serverIp?: string): Promise<{ status: TacacsAuthenStatus | 'timeout'; privLvl: number | null }> {
    const server = this.selectServer(serverIp);
    if (!server) return Promise.resolve({ status: 'timeout', privLvl: null });
    const sessionId = this.nextSession();
    const body: TacacsBody = {
      type: 'tacacs-authen-start',
      action: 'login', privLvl: 1, authenType: 'ascii', service: 'login',
      user: username, port: 'tty0', remoteAddress: '0.0.0.0',
      data: password,
    };
    return this.exchange<{ status: TacacsAuthenStatus | 'timeout'; privLvl: number | null }>(
      server, sessionId, 1, body,
      (reply) => {
        if (reply && reply.body.type === 'tacacs-authen-reply') {
          const status = reply.body.status;
          this.getBus().publish({
            topic: 'tacacs.authen.completed',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              serverIp: server.ip, username,
              status, privLvl: status === 'pass' ? 15 : null,
            },
          });
          Logger.info(this.host.id, 'tacacs:authen',
            `${this.host.name}: ${username}@${server.ip} → ${status}`);
          return { status, privLvl: status === 'pass' ? 15 : null };
        }
        this.publishTimeout(server.ip, username, 'authen');
        return { status: 'timeout', privLvl: null };
      },
    );
  }

  authorize(username: string, command: string, serverIp?: string): Promise<TacacsAuthorStatus | 'timeout'> {
    const server = this.selectServer(serverIp);
    if (!server) return Promise.resolve('timeout');
    const sessionId = this.nextSession();
    const body: TacacsBody = {
      type: 'tacacs-author-request',
      authenMethod: 6, privLvl: 1, authenType: 'ascii', service: 'login',
      user: username, port: 'tty0', remoteAddress: '0.0.0.0',
      args: [`service=shell`, `cmd=${command}`],
    };
    return this.exchange<TacacsAuthorStatus | 'timeout'>(
      server, sessionId, 2, body,
      (reply) => {
        if (reply && reply.body.type === 'tacacs-author-reply') {
          const status = reply.body.status;
          this.getBus().publish({
            topic: 'tacacs.author.completed',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              serverIp: server.ip, username, status, command,
            },
          });
          return status;
        }
        this.publishTimeout(server.ip, username, 'author');
        return 'timeout';
      },
    );
  }

  accountCommand(username: string, command: string, flags: TacacsAcctFlag[], serverIp?: string): Promise<TacacsAcctStatus | 'timeout'> {
    const server = this.selectServer(serverIp);
    if (!server) return Promise.resolve('timeout');
    const sessionId = this.nextSession();
    const body: TacacsBody = {
      type: 'tacacs-acct-request',
      flags, authenMethod: 6, privLvl: 1, authenType: 'ascii', service: 'login',
      user: username, port: 'tty0', remoteAddress: '0.0.0.0',
      args: [`service=shell`, `cmd=${command}`],
    };
    return this.exchange<TacacsAcctStatus | 'timeout'>(
      server, sessionId, 3, body,
      (reply) => {
        if (reply && reply.body.type === 'tacacs-acct-reply') {
          const status = reply.body.status;
          this.getBus().publish({
            topic: 'tacacs.acct.completed',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              serverIp: server.ip, username, flags, status,
            },
          });
          return status;
        }
        this.publishTimeout(server.ip, username, 'acct');
        return 'timeout';
      },
    );
  }

  private exchange<T>(server: TacacsServerConfig, sessionId: number, type: number,
                      body: TacacsBody, finalize: (reply: TacacsPacket | null) => T): Promise<T> {
    if (!this.config.enabled) return Promise.resolve(finalize(null));
    const stack = this.getTcpStack();
    return new Promise<T>((resolve) => {
      let received: TacacsPacket | null = null;
      let settled = false;
      let timer: TimerHandle | null = null;
      let socketRef: TcpSocket | null = null;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.getScheduler().clear(timer);
        resolve(finalize(received));
      };
      socketRef = stack.connect(server.ip, server.port, {
        onOpen: (s) => {
          const seqNo = 1;
          const version = 0xc1;
          const header: TacacsHeader = {
            version, type, seqNo, flags: 0, sessionId, length: 64,
          };
          const encrypted: TacacsEncryptedBody = {
            type: 'tacacs-encrypted',
            cipherHex: encryptBody(JSON.stringify(body), sessionId, server.sharedSecret, version, seqNo),
            originalType: body.type,
          };
          const packet: TacacsPacket = { type: 'tacacs', header, body: encrypted };
          this.getBus().publish({
            topic: 'tacacs.packet.sent',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              destinationIp: server.ip, sessionId, bodyType: body.type,
            },
          });
          s.send(packet);
        },
        onData: (data) => {
          const pkt = data as TacacsPacket | undefined;
          if (pkt && pkt.type === 'tacacs') {
            const decrypted = decryptReplyBody(pkt, server.sharedSecret);
            if (decrypted) {
              received = { type: 'tacacs', header: pkt.header, body: decrypted };
              this.getBus().publish({
                topic: 'tacacs.packet.received',
                payload: {
                  deviceId: this.host.id, hostname: this.host.getHostname(),
                  fromIp: server.ip, sessionId: pkt.header.sessionId,
                  bodyType: decrypted.type,
                },
              });
            }
            if (socketRef) socketRef.close();
          }
        },
        onClose: () => { settle(); },
      });
      if (!socketRef) { settle(); return; }
      timer = this.getScheduler().setTimeout(() => {
        if (settled) return;
        if (socketRef) socketRef.close();
        settle();
      }, server.timeoutMs);
    });
  }

  private publishTimeout(serverIp: string, username: string, kind: 'authen' | 'author' | 'acct'): void {
    if (kind === 'authen') {
      this.getBus().publish({
        topic: 'tacacs.authen.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp, username, status: 'timeout', privLvl: null,
        },
      });
    } else if (kind === 'author') {
      this.getBus().publish({
        topic: 'tacacs.author.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp, username, status: 'timeout', command: null,
        },
      });
    } else {
      this.getBus().publish({
        topic: 'tacacs.acct.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp, username, flags: [], status: 'timeout',
        },
      });
    }
  }

  private selectServer(serverIp?: string): TacacsServerConfig | undefined {
    if (!this.config.enabled) return undefined;
    return serverIp
      ? this.config.servers.find((s) => s.ip === serverIp)
      : this.config.servers[0];
  }

  private nextSession(): number {
    const id = this.nextSessionId;
    this.nextSessionId = (this.nextSessionId + 1) & 0x7fffffff;
    return id;
  }
}

void PORT_TACACS;

function decryptReplyBody(pkt: TacacsPacket, secret: string): TacacsBody | null {
  if (pkt.body.type !== 'tacacs-encrypted') return pkt.body;
  const json = decryptBody(pkt.body.cipherHex, pkt.header.sessionId, secret, pkt.header.version, pkt.header.seqNo);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as TacacsBody;
    if (!parsed || typeof parsed.type !== 'string' || !parsed.type.startsWith('tacacs-')) return null;
    return parsed;
  } catch {
    return null;
  }
}
