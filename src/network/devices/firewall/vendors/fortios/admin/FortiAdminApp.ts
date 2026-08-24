import { createResponse, type HttpMessage } from '../../../../../http/semantics/types';
import { parseForm } from '../../../auth/AuthPortal';
import type { AdminHttpApp, AdminHttpPeer } from '../../../mgmt/AdminHttpServer';
import type { FortiConfigTree } from '../runtime/FortiConfigTree';
import type { FortiObject } from '../runtime/FortiObject';

export const CMDB_BASE = '/api/v2/cmdb/';
export const LOGIN_PATH = '/logincheck';
export const CSRF_COOKIE = 'ccsrftoken';

export interface FortiAdminAppDeps {
  tree(): FortiConfigTree;
  version(): string;
  serial(): string;
  vdom(): string;
  login(user: string, password: string, source: string): boolean;
  now(): number;
}

interface AdminSession {
  readonly user: string;
  readonly token: string;
}

export class FortiAdminApp implements AdminHttpApp {
  private readonly sessions = new Map<string, AdminSession>();
  private issued = 0;

  constructor(private readonly deps: FortiAdminAppDeps) {}

  handle(request: HttpMessage, peer: AdminHttpPeer): HttpMessage {
    const target = pathOf(request.target ?? '/');
    if (target === LOGIN_PATH) return this.logincheck(request, peer);
    if (target.startsWith(CMDB_BASE)) return this.cmdb(request, target);
    return this.page(200, 'OK', loginPage());
  }

  private logincheck(request: HttpMessage, peer: AdminHttpPeer): HttpMessage {
    const submitted = parseForm(bodyText(request));
    const user = submitted.get('username') ?? '';
    const password = submitted.get('secretkey') ?? '';
    if (!this.deps.login(user, password, peer.ip)) return this.ajax('0');

    const token = `${this.deps.now().toString(36)}${(this.issued += 1).toString(36)}`;
    this.sessions.set(token, { user, token });
    const accepted = this.ajax('1');
    accepted.headers.set('Set-Cookie', `${CSRF_COOKIE}="${token}"; Path=/`);
    return accepted;
  }

  private cmdb(request: HttpMessage, target: string): HttpMessage {
    if (this.sessionOf(request) === undefined) {
      return this.envelope(401, 'Unauthorized', [], [], 'error');
    }

    const words = target.slice(CMDB_BASE.length).split('/').filter(Boolean)
      .map(decodeURIComponent);
    if (words.length < 2) return this.envelope(404, 'Not Found', [], [], 'error');

    const path = words.slice(0, 2);
    const spec = this.deps.tree().spec(path);
    if (spec === undefined) return this.envelope(404, 'Not Found', path, [], 'error');

    const results = this.resultsOf(path, words[2]);
    if (results === null) return this.envelope(404, 'Not Found', path, [], 'error');
    return this.envelope(200, 'OK', path, results, 'success');
  }

  private resultsOf(
    path: readonly string[], mkey: string | undefined,
  ): Array<Record<string, string>> | null {
    const node = this.deps.tree().node(path);
    if (node === undefined) return null;
    if (!('all' in node)) return [attributesOf(node)];

    if (mkey === undefined) return node.all().map(attributesOf);
    const object = node.get(mkey);
    return object === undefined ? null : [attributesOf(object)];
  }

  private sessionOf(request: HttpMessage): AdminSession | undefined {
    for (const raw of request.headers.getAll('cookie')) {
      for (const pair of raw.split(';')) {
        const at = pair.indexOf('=');
        if (at < 0) continue;
        if (pair.slice(0, at).trim() !== CSRF_COOKIE) continue;
        const found = this.sessions.get(pair.slice(at + 1).trim().replace(/^"|"$/g, ''));
        if (found) return found;
      }
    }
    return undefined;
  }

  private envelope(
    status: number, reason: string, path: readonly string[],
    results: ReadonlyArray<Record<string, string>>, outcome: 'success' | 'error',
  ): HttpMessage {
    return this.json(status, reason, {
      http_method: 'GET',
      results,
      vdom: this.deps.vdom(),
      path: path[0] ?? '',
      name: path[1] ?? '',
      status: outcome,
      http_status: status,
      serial: this.deps.serial(),
      version: `v${this.deps.version()}`,
    });
  }

  private json(status: number, reason: string, payload: unknown): HttpMessage {
    const response = this.body(
      createResponse(status, reason), JSON.stringify(payload));
    response.headers.set('Content-Type', 'application/json');
    return response;
  }

  private ajax(text: string): HttpMessage {
    const response = this.body(createResponse(200, 'OK'), text);
    response.headers.set('Content-Type', 'text/plain');
    return response;
  }

  private page(status: number, reason: string, html: string): HttpMessage {
    const response = this.body(createResponse(status, reason), html);
    response.headers.set('Content-Type', 'text/html');
    return response;
  }

  private body(response: HttpMessage, text: string): HttpMessage {
    response.body = new Uint8Array([...text].map(c => c.charCodeAt(0)));
    response.headers.set('Content-Length', String(response.body.length));
    return response;
  }
}

function attributesOf(object: FortiObject): Record<string, string> {
  const out: Record<string, string> = { name: object.key };
  for (const attribute of object.attributeNames()) {
    const values = object.effective(attribute);
    if (values.length === 0) continue;
    out[attribute] = values.join(' ');
  }
  return out;
}

function pathOf(target: string): string {
  const at = target.indexOf('?');
  return at < 0 ? target : target.slice(0, at);
}

function bodyText(message: HttpMessage): string {
  if (!message.body) return '';
  return Array.from(message.body).map(byte => String.fromCharCode(byte)).join('');
}

export function loginPage(): string {
  return '<html><head><title>FortiGate</title></head>'
    + '<body><h1>FortiGate</h1>'
    + '<form method="POST" action="/logincheck">'
    + '<p>Name: <input type="text" name="username"></p>'
    + '<p>Password: <input type="password" name="secretkey"></p>'
    + '<input type="hidden" name="ajax" value="1">'
    + '<p><input type="submit" value="Login"></p>'
    + '</form></body></html>';
}
