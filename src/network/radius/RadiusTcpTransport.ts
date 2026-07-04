/**
 * RFC 6613 — RADIUS over TCP. Same wire packets and same crypto
 * (Response Authenticator, RFC 2865 §3) as the UDP path in
 * `RadiusClientAgent`/`RadiusServerAgent` — only the transport differs:
 * a TCP connection instead of a UDP datagram, so the RADIUS layer itself
 * doesn't retransmit (RFC 6613 §2.4, TCP already guarantees delivery).
 *
 * Scoped to PAP authentication only, one request per connection (open,
 * send, wait for the reply, close) — deliberately not folded into the
 * UDP agents' CHAP/EAP/challenge/accounting machinery, mirroring how
 * `TacacsClientAgent`/`TacacsServerAgent` already use the same `TcpStack`
 * for a TCP-native AAA protocol. RadSec (RFC 6614, TLS over this same
 * transport) stays out of scope — see PRD-RADIUS §2.2.
 */
import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type RadiusPacket, type RadiusUser,
  attr, getAttr, encryptUserPassword, decryptUserPassword, isPrintablePassword,
  UDP_PORT_RADIUS_AUTH,
} from './types';
import {
  randomRequestAuthenticator, withResponseAuthenticator, verifyResponseAuthenticator,
} from './authenticators';
import type { TcpStack, TcpSocket } from '../tcp/TcpStack';
import { Logger } from '../core/Logger';

export interface RadiusTcpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
}

export interface RadiusTcpServerConfig {
  ip: string;
  port: number;
  sharedSecret: string;
  timeoutMs: number;
}

function defaultServerEntry(ip: string, sharedSecret: string): RadiusTcpServerConfig {
  return { ip, port: UDP_PORT_RADIUS_AUTH, sharedSecret, timeoutMs: 5000 };
}

// ─── Client (NAS) side ────────────────────────────────────────────────

export class RadiusTcpClient {
  private servers: RadiusTcpServerConfig[] = [];
  private enabled = true;
  private running = false;

  constructor(
    private readonly host: RadiusTcpHost,
    private readonly getBus: () => IEventBus,
    private readonly getTcpStack: () => TcpStack,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }
  setEnabled(on: boolean): void { this.enabled = on; }
  listServers(): RadiusTcpServerConfig[] { return this.servers.slice(); }

  addServer(ip: string, sharedSecret: string, opts: { port?: number; timeoutMs?: number } = {}): void {
    const existing = this.servers.find((s) => s.ip === ip);
    if (existing) {
      existing.sharedSecret = sharedSecret;
      if (opts.port) existing.port = opts.port;
      if (opts.timeoutMs) existing.timeoutMs = opts.timeoutMs;
      return;
    }
    const s = defaultServerEntry(ip, sharedSecret);
    if (opts.port) s.port = opts.port;
    if (opts.timeoutMs) s.timeoutMs = opts.timeoutMs;
    this.servers.push(s);
  }

  removeServer(ip: string): void {
    this.servers = this.servers.filter((s) => s.ip !== ip);
  }

  /** PAP authentication over a dedicated TCP connection (RFC 6613). */
  authenticate(username: string, password: string, serverIp?: string): Promise<'accept' | 'reject' | 'timeout'> {
    const server = serverIp ? this.servers.find((s) => s.ip === serverIp) : this.servers[0];
    if (!this.enabled || !server) return Promise.resolve('timeout');

    return new Promise((resolve) => {
      let settled = false;
      let timer: TimerHandle | null = null;
      let socketRef: TcpSocket | null = null;
      const requestAuthenticator = randomRequestAuthenticator();
      const identifier = Math.floor(Math.random() * 256);

      const settle = (result: 'accept' | 'reject' | 'timeout'): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.getScheduler().clear(timer);
        this.getBus().publish({
          topic: 'radius.tcp.completed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            serverIp: server.ip, username, result,
          },
        });
        resolve(result);
      };

      socketRef = this.getTcpStack().connect(server.ip, server.port, {
        onOpen: (s) => {
          const request: RadiusPacket = {
            type: 'radius', code: 'access-request', identifier,
            authenticator: requestAuthenticator,
            attributes: [
              attr('user-name', username),
              attr('user-password', encryptUserPassword(password, server.sharedSecret, requestAuthenticator)),
            ],
          };
          Logger.info(this.host.id, 'radius:tcp',
            `${this.host.name}: Access-Request (TCP) for ${username} → ${server.ip}:${server.port}`);
          s.send(request);
        },
        onData: (data) => {
          const response = data as RadiusPacket | undefined;
          if (!response || response.type !== 'radius') return;
          if (response.identifier !== identifier) return;
          if (!verifyResponseAuthenticator(response, requestAuthenticator, server.sharedSecret)) return;
          if (response.code === 'access-accept') settle('accept');
          else if (response.code === 'access-reject') settle('reject');
          if (socketRef) socketRef.close();
        },
        onClose: () => settle('timeout'),
      });
      if (!socketRef) { settle('timeout'); return; }
      timer = this.getScheduler().setTimeout(() => {
        if (settled) return;
        socketRef?.close();
        settle('timeout');
      }, server.timeoutMs);
    });
  }
}

// ─── Server side ────────────────────────────────────────────────────

export interface RadiusTcpServerAgentConfig {
  enabled: boolean;
  port: number;
  sharedSecret: string;
  users: Map<string, RadiusUser>;
}

export class RadiusTcpServer {
  private config: RadiusTcpServerAgentConfig = {
    enabled: true, port: UDP_PORT_RADIUS_AUTH, sharedSecret: 'shared', users: new Map(),
  };
  private running = false;
  private listenerInstalled = false;

  constructor(
    private readonly host: RadiusTcpHost,
    private readonly getBus: () => IEventBus,
    private readonly getTcpStack: () => TcpStack,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.config.enabled) this.installListener();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.listenerInstalled) {
      this.getTcpStack().closeListener(this.config.port);
      this.listenerInstalled = false;
    }
  }

  getConfig(): Readonly<RadiusTcpServerAgentConfig> { return this.config; }

  setEnabled(on: boolean): void {
    this.config.enabled = on;
    if (!this.running) return;
    if (on) this.installListener();
    else if (this.listenerInstalled) {
      this.getTcpStack().closeListener(this.config.port);
      this.listenerInstalled = false;
    }
  }

  setSharedSecret(secret: string): void { this.config.sharedSecret = secret; }

  addUser(username: string, password: string): void {
    this.config.users.set(username, { username, password });
  }

  removeUser(username: string): void { this.config.users.delete(username); }

  private installListener(): void {
    if (this.listenerInstalled) return;
    this.getTcpStack().listen(this.config.port, {
      onAccept: (socket) => {
        socket.onData((data) => {
          if (!this.config.enabled) { socket.close(); return; }
          const request = data as RadiusPacket | undefined;
          if (!request || request.type !== 'radius' || request.code !== 'access-request') {
            socket.close();
            return;
          }
          const usernameAttr = getAttr(request, 'user-name');
          const passwordAttr = getAttr(request, 'user-password');
          const username = usernameAttr ? String(usernameAttr.value) : '';
          const user = this.config.users.get(username);

          let accepted = false;
          if (passwordAttr) {
            const decrypted = decryptUserPassword(String(passwordAttr.value), this.config.sharedSecret, request.authenticator);
            accepted = isPrintablePassword(decrypted) && !!user && user.password === decrypted;
          }

          let response: RadiusPacket = {
            type: 'radius', code: accepted ? 'access-accept' : 'access-reject',
            identifier: request.identifier, authenticator: '00'.repeat(16),
            attributes: accepted ? [] : [attr('reply-message', 'Authentication failed')],
          };
          response = withResponseAuthenticator(response, request.authenticator, this.config.sharedSecret);
          this.getBus().publish({
            topic: 'radius.tcp.completed',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              serverIp: socket.remoteIp, username, result: accepted ? 'accept' : 'reject',
            },
          });
          Logger.info(this.host.id, 'radius:tcp',
            `${this.host.name}: ${response.code} (TCP) for ${username || '(unknown)'}`);
          socket.send(response);
          socket.close();
        });
      },
    });
    this.listenerInstalled = true;
  }
}
