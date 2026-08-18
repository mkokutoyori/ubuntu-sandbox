import { Http1ServerSession, type Http1Peer } from '../../../http/http1/Http1ServerSession';
import { createResponse, type HttpMessage } from '../../../http/semantics/types';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { IdentityTable, IdentitySource } from '../identity/IdentityTable';
import { DEFAULT_AUTH_TIMEOUT_SEC } from '../identity/IdentityTable';
import type { UserDirectory } from '../identity/UserDirectory';

export const AUTH_PORTAL_PORT = 1000;
export const AUTH_PORTAL_HTTPS_PORT = 1003;

export interface RemoteAuthOutcome {
  readonly accepted: boolean;
  readonly server?: string;
  readonly source?: IdentitySource;
}

export interface AuthPortalDeps {
  readonly tcp: TcpStack;
  readonly now: () => number;
  readonly directory: (vdom?: string) => UserDirectory;
  readonly identities: (vdom?: string) => IdentityTable;
  readonly vdomOfAddress: (address: string) => string;
  readonly remoteAuthenticate: (
    server: string, user: string, password: string,
  ) => Promise<RemoteAuthOutcome>;
  readonly onEvent?: (message: string) => void;
}

export interface PortalCredentials {
  readonly username: string;
  readonly password: string;
}

export type PortalOutcome =
  | { readonly ok: true; readonly user: string; readonly groups: readonly string[] }
  | { readonly ok: false; readonly reason: 'no-such-user' | 'bad-password' | 'no-server' };

export class AuthPortal {
  private session: Http1ServerSession | null = null;
  private timeoutSec = DEFAULT_AUTH_TIMEOUT_SEC;

  constructor(private readonly deps: AuthPortalDeps) {}

  start(port: number = AUTH_PORTAL_PORT): boolean {
    if (this.session) return true;

    this.session = new Http1ServerSession(
      this.deps.tcp, port, (request, peer) => this.respond(request, peer));
    try {
      this.session.start({ processName: 'httpsd', pid: 0 });
    } catch {
      this.session = null;
      return false;
    }
    return true;
  }

  stop(): void {
    this.session?.stop();
    this.session = null;
  }

  isListening(): boolean { return this.session !== null; }

  setTimeoutSeconds(seconds: number): void { this.timeoutSec = seconds; }

  getTimeoutSeconds(): number { return this.timeoutSec; }

  async authenticate(
    address: string, credentials: PortalCredentials, policyId?: string,
  ): Promise<PortalOutcome> {
    const vdom = this.deps.vdomOfAddress(address);
    const directory = this.deps.directory(vdom);
    const route = directory.authenticationRouteOf(credentials.username);
    if (!route) return { ok: false, reason: 'no-such-user' };

    if (route.source === 'local') {
      if (!directory.authenticateLocal(credentials.username, credentials.password)) {
        this.report(`user ${credentials.username} failed local authentication`);
        return { ok: false, reason: 'bad-password' };
      }
      return this.admit(address, credentials.username, 'local', undefined, policyId);
    }

    if (route.server === undefined) return { ok: false, reason: 'no-server' };

    const outcome = await this.deps.remoteAuthenticate(
      route.server, credentials.username, credentials.password);
    if (!outcome.accepted) {
      this.report(`user ${credentials.username} rejected by ${route.server}`);
      return { ok: false, reason: 'bad-password' };
    }

    return this.admit(
      address, credentials.username, route.source, route.server, policyId);
  }

  private admit(
    address: string, user: string, source: IdentitySource,
    server: string | undefined, policyId?: string,
  ): PortalOutcome {
    const vdom = this.deps.vdomOfAddress(address);
    const directory = this.deps.directory(vdom);
    const groups = directory.groupsOf(user);
    const timeout = directory.authTimeoutSecondsFor(groups, this.timeoutSec);

    this.deps.identities(vdom).bind({
      address, user, source, server, groups,
      groupIds: directory.groupIdsOf(groups),
      policyId,
      timeoutSec: timeout,
    });

    this.report(`user ${user} authenticated from ${address}`);
    return { ok: true, user, groups };
  }

  private report(message: string): void {
    this.deps.onEvent?.(message);
  }

  private async respond(request: HttpMessage, peer?: Http1Peer): Promise<HttpMessage> {
    const address = peer?.ip ?? '0.0.0.0';

    if (request.kind !== 'request' || request.method === 'GET') {
      return page(200, 'OK', loginPage());
    }

    const submitted = parseForm(bodyText(request));
    const username = submitted.get('username') ?? '';
    const password = submitted.get('password') ?? '';
    const outcome = await this.authenticate(address, { username, password });

    if (!outcome.ok) return page(401, 'Authorization Required', deniedPage());
    return page(200, 'OK', welcomePage(outcome.user));
  }
}

function bodyText(message: HttpMessage): string {
  if (!message.body) return '';
  return Array.from(message.body).map(byte => String.fromCharCode(byte)).join('');
}

export function parseForm(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of body.split('&')) {
    if (pair.length === 0) continue;
    const at = pair.indexOf('=');
    if (at < 0) continue;
    out.set(decodeURIComponent(pair.slice(0, at)), decodeURIComponent(pair.slice(at + 1)));
  }
  return out;
}

function page(status: number, reason: string, html: string): HttpMessage {
  const response = createResponse(status, reason);
  response.headers.set('Content-Type', 'text/html');
  response.headers.set('Content-Length', String(html.length));
  response.body = new Uint8Array([...html].map(character => character.charCodeAt(0)));
  return response;
}

export function loginPage(): string {
  return '<html><head><title>Firewall Authentication</title></head>'
    + '<body><h1>Firewall Authentication</h1>'
    + '<form method="POST" action="/">'
    + '<p>Username: <input type="text" name="username"></p>'
    + '<p>Password: <input type="password" name="password"></p>'
    + '<p><input type="submit" value="Continue"></p>'
    + '</form></body></html>';
}

export function welcomePage(user: string): string {
  return '<html><head><title>Firewall Authentication</title></head>'
    + `<body><h1>Authentication successful</h1><p>Welcome, ${user}.</p>`
    + '</body></html>';
}

export function deniedPage(): string {
  return '<html><head><title>Firewall Authentication</title></head>'
    + '<body><h1>Authentication failed</h1>'
    + '<p>Firewall authentication failed. Please try again.</p>'
    + '</body></html>';
}

export interface AuthPortalBuild {
  readonly tcp: TcpStack;
  readonly now: () => number;
  readonly vdom: (name?: string) => {
    users: UserDirectory;
    identities: IdentityTable;
    logs: { append(draft: unknown): unknown };
  };
  readonly remoteAuthenticate: (
    server: string, user: string, password: string,
  ) => Promise<RemoteAuthOutcome>;
}

export function buildAuthPortal(build: AuthPortalBuild): AuthPortal {
  return new AuthPortal({
    tcp: build.tcp,
    now: build.now,
    directory: (vdom) => build.vdom(vdom).users,
    identities: (vdom) => build.vdom(vdom).identities,
    vdomOfAddress: () => 'root',
    remoteAuthenticate: build.remoteAuthenticate,
    onEvent: (message) => build.vdom().logs.append({
      at: build.now(), type: 'event', subtype: 'user', level: 'notice',
      id: '0102043008', fields: { action: 'authentication', msg: message },
    }),
  });
}
