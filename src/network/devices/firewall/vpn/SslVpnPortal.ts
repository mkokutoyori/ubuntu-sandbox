import { HttpsServerSession } from '../../../http/https/HttpsServerSession';
import { createResponse, type HttpMessage } from '../../../http/semantics/types';
import type { Http1Peer } from '../../../http/http1/Http1ServerSession';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { X509Certificate } from '../../../pki/X509Certificate';
import type { PkiPrivateKey } from '../../../pki/PkiKeyPair';
import { parseForm, type PortalCredentials, type PortalOutcome } from '../auth/AuthPortal';
import { SslVpnSessionTable } from './SslVpnSessionTable';

export const SSL_VPN_DEFAULT_PORT = 10443;

export interface SslVpnAuthenticationRule {
  readonly id: string;
  readonly groups: readonly string[];
  readonly users: readonly string[];
  readonly portal: string;
}

export interface SslVpnServerCertificate {
  readonly certificate: X509Certificate;
  readonly privateKey: PkiPrivateKey;
}

export interface SslVpnPortalDeps {
  readonly tcp: TcpStack;
  readonly authenticate: (
    address: string, credentials: PortalCredentials) => Promise<PortalOutcome>;
  readonly groupsOf: (user: string) => readonly string[];
  readonly certificate: (name: string) => SslVpnServerCertificate | undefined;
  readonly now?: () => number;
}

export interface SslVpnSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly serverCertificate: string;
  readonly sourceInterfaces: readonly string[];
  readonly rules: readonly SslVpnAuthenticationRule[];
  readonly idleTimeout?: number;
}

export const SSL_VPN_DEFAULTS: SslVpnSettings = Object.freeze({
  enabled: false,
  port: SSL_VPN_DEFAULT_PORT,
  serverCertificate: '',
  sourceInterfaces: Object.freeze([]),
  rules: Object.freeze([]),
  idleTimeout: 300,
});

export class SslVpnPortal {
  private session: HttpsServerSession | null = null;
  private settings: SslVpnSettings = SSL_VPN_DEFAULTS;
  private readonly sessions: SslVpnSessionTable;

  constructor(private readonly deps: SslVpnPortalDeps) {
    this.sessions = new SslVpnSessionTable(deps.now);
  }

  sessionTable(): SslVpnSessionTable { return this.sessions; }

  apply(settings: SslVpnSettings): string | undefined {
    this.stop();
    this.settings = settings;
    this.sessions.setIdleTimeout(settings.idleTimeout ?? 300);
    if (!settings.enabled) return undefined;

    const material = this.deps.certificate(settings.serverCertificate);
    if (!material) {
      return 'SSL-VPN needs `set servercert <local-certificate>` before it can listen.';
    }

    this.session = new HttpsServerSession(
      this.deps.tcp, settings.port,
      { serverCert: material.certificate, serverPrivateKey: material.privateKey },
      (request, peer) => this.respond(request, peer));
    try {
      this.session.start({ processName: 'sslvpnd', pid: 0 });
    } catch {
      this.session = null;
      return `SSL-VPN cannot listen on port ${settings.port}.`;
    }
    return undefined;
  }

  stop(): void {
    this.session?.stop();
    this.session = null;
  }

  isListening(): boolean { return this.session !== null; }

  port(): number { return this.settings.port; }

  rules(): readonly SslVpnAuthenticationRule[] { return this.settings.rules; }

  async authenticate(
    address: string, credentials: PortalCredentials,
  ): Promise<PortalOutcome> {
    if (!this.admittedByRule(credentials.username)) {
      return { ok: false, reason: 'no-such-user' };
    }
    return this.deps.authenticate(address, credentials);
  }

  private admittedByRule(user: string): boolean {
    if (this.settings.rules.length === 0) return false;

    const groups = this.deps.groupsOf(user);
    return this.settings.rules.some(rule =>
      rule.users.includes(user) || rule.groups.some(group => groups.includes(group)));
  }

  private respond(
    request: HttpMessage, peer?: Http1Peer,
  ): HttpMessage | Promise<HttpMessage> {
    if (request.kind !== 'request' || request.method === 'GET') {
      return page(200, 'OK', loginPage());
    }

    const submitted = parseForm(bodyText(request));
    return this.authenticate(peer?.ip ?? '0.0.0.0', {
      username: submitted.get('username') ?? '',
      password: submitted.get('password') ?? '',
    }).then((outcome) => {
      if (!outcome.ok) return page(401, 'Authorization Required', deniedPage());
      this.sessions.open({
        user: outcome.user,
        group: this.deps.groupsOf(outcome.user)[0] ?? '',
        sourceIp: peer?.ip ?? '0.0.0.0',
        mode: 'web',
      });
      return page(200, 'OK', welcomePage(outcome.user));
    });
  }
}

function bodyText(message: HttpMessage): string {
  if (!message.body) return '';
  return Array.from(message.body).map(byte => String.fromCharCode(byte)).join('');
}

function page(status: number, reason: string, html: string): HttpMessage {
  const response = createResponse(status, reason);
  response.headers.set('Content-Type', 'text/html');
  response.headers.set('Content-Length', String(html.length));
  response.body = new Uint8Array([...html].map(character => character.charCodeAt(0)));
  return response;
}

function loginPage(): string {
  return '<html><head><title>SSL-VPN Portal</title></head><body>'
    + '<h1>SSL-VPN Login</h1>'
    + '<form method="POST" action="/remote/logincheck">'
    + '<input name="username"><input name="password" type="password">'
    + '<input type="submit" value="Login"></form></body></html>';
}

function deniedPage(): string {
  return '<html><body><h1>Permission denied</h1></body></html>';
}

function welcomePage(user: string): string {
  return `<html><body><h1>SSL-VPN Portal</h1><p>Welcome, ${user}.</p></body></html>`;
}
