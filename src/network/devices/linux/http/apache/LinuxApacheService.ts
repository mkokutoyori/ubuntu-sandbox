import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { pemToCert, pemToPrivateKey } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import { contentTypeForPath } from '@/network/http/HttpTypes';
import type { PortSpec } from '../../../../core/ports/PortNumber';
import type { ServiceSocketServer } from '../../ports/ServiceSocketServer';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import type { NginxHost } from '../nginx/LinuxNginxService';
import {
  parseApacheConfig, apacheWarnings, selectVirtualHost,
  type ApacheConfig,
} from './ApacheConfig';
import {
  APACHE_VERSION, APACHE_PORTS_PATH, APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH,
  APACHE_ACCESS_LOG, APACHE_ERROR_LOG,
  apacheNotFoundPage, apacheForbiddenPage,
} from './ApacheFiles';

/**
 * apache2 (docs/PRD-Manquements.md §M4a) — the server that was missing.
 *
 * `systemctl start apache2` used to make the unit `active` and open
 * nothing: `ss` showed no port, `curl localhost` answered
 * `Connection refused`, and the unit still claimed to be running. It was
 * the last HTTP unit in that state after `PRD-Nginx`.
 *
 * No new HTTP engine: like nginx, this service sits on
 * `Http1ServerSession`. What is written here is the reading of Debian's
 * files and the choice of which file to serve. It shares nginx's port and
 * therefore nginx's conflict — so the "both servers want port 80" lab
 * works for real, in both directions.
 */

const APACHE_UID = 33;
const APACHE_GID = 33;

export interface ApacheControl {
  loadConfig(): string | null;
  reload(): string | null;
  stopAll(): void;
  listeningPorts(): number[];
  configWarnings(): string[];
}

function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function joinPath(root: string, rel: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return rel.startsWith('/') ? `${base}${rel}` : `${base}/${rel}`;
}

/** `[Wed Aug 05 10:00:00.000000 2026]` — error.log's timestamp. */
function formatErrorTime(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000000 `
    + `${d.getUTCFullYear()}]`;
}

/** `05/Aug/2026:10:00:00 +0000` — the combined format's timestamp. */
function formatAccessTime(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${months[d.getUTCMonth()]}/${d.getUTCFullYear()}:`
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

type ApacheSession = Http1ServerSession | HttpsServerSession;

export class LinuxApacheService implements ServiceSocketServer, ApacheControl {
  private config: ApacheConfig = { listenPorts: [], vhosts: [] };
  private loaded = false;
  private readonly sessions = new Map<number, ApacheSession>();

  constructor(private readonly host: NginxHost) {}

  loadConfig(): string | null {
    const { config, error } = parseApacheConfig(
      this.host.fs, APACHE_PORTS_PATH, APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH,
    );
    this.config = config;
    this.loaded = error === null;
    return error ? error.message : null;
  }

  configWarnings(): string[] {
    return apacheWarnings(this.config);
  }

  /**
   * The ports the configuration actually opens: the INTERSECTION of the
   * `Listen` directives and the `<VirtualHost>` blocks. A `Listen` with no
   * virtual host would have nothing to serve, a virtual host with no
   * `Listen` would never be reached — and it is that second case
   * `apachectl configtest` reports (§M4a).
   */
  configuredPorts(): number[] {
    const withVhost = new Set(this.config.vhosts.map((v) => v.port));
    return this.config.listenPorts.filter((p) => withVhost.has(p)).sort((a, b) => a - b);
  }

  portConflict(): string | null {
    for (const port of this.configuredPorts()) {
      if (this.sessions.has(port)) continue;
      if (this.host.portTaken(port)) {
        // Apache's own message, which is not nginx's — this is what the
        // operator will search their log for.
        return `(98)Address already in use: AH00072: make_sock: could not bind to address 0.0.0.0:${port}`;
      }
    }
    return null;
  }

  reportStartupFailure(message: string): void {
    this.host.appendLog(
      APACHE_ERROR_LOG,
      `${formatErrorTime(this.host.now())} [core:emerg] [pid 1] ${message}`,
    );
  }

  open(spec: PortSpec, identity?: ListenerIdentity): boolean {
    if (spec.protocol !== 'tcp') return false;
    if (!this.loaded && this.loadConfig() !== null) return false;
    if (this.config.vhosts.length === 0) return false;
    if (this.sessions.has(spec.port)) return true;

    const tls = this.tlsMaterialFor(spec.port);
    if (tls === 'error') return false;

    const session: ApacheSession = tls === null
      ? new Http1ServerSession(
        this.host.tcpStack(), spec.port, (req) => this.respond(spec.port, req),
      )
      : new HttpsServerSession(
        this.host.tcpStack(), spec.port,
        { serverCert: tls.cert, serverPrivateKey: tls.key },
        (req) => this.respond(spec.port, req),
      );
    try {
      session.start(identity);
    } catch {
      return false;
    }
    this.sessions.set(spec.port, session);
    return true;
  }

  /**
   * The certificate a port presents, `null` for plain HTTP, `'error'` when
   * a vhost asked for TLS and cannot have it.
   *
   * The third outcome is the whole reason this exists, and it is the same
   * one nginx's twin gives (`docs/PRD-Nginx.md` §P5): a `<VirtualHost
   * *:443>` whose certificate is missing must NOT fall back to serving
   * cleartext on 443. That was the shipped behaviour until this method —
   * Apache's `open()` built an `Http1ServerSession` for every port — and
   * it is the worst possible answer, since everything downstream believes
   * 443 means encrypted.
   */
  private tlsMaterialFor(port: number): { cert: X509Certificate; key: PkiPrivateKey } | null | 'error' {
    const vhost = this.config.vhosts.find((v) => v.port === port && v.sslEngine);
    if (!vhost) return null;

    const fail = (message: string): 'error' => {
      this.reportStartupFailure(message);
      return 'error';
    };
    if (!vhost.sslCertificateFile || !vhost.sslCertificateKeyFile) {
      return fail(`AH02572: Failed to configure at least one certificate and key `
        + `for ${vhost.serverName ?? '*'}:${port}`);
    }
    const certPem = this.host.fs.read(vhost.sslCertificateFile);
    if (certPem === null) {
      return fail(`AH00526: Syntax error on line 1 of ${vhost.source}: `
        + `SSLCertificateFile: file '${vhost.sslCertificateFile}' does not exist or is empty`);
    }
    const keyPem = this.host.fs.read(vhost.sslCertificateKeyFile);
    if (keyPem === null) {
      return fail(`AH00526: Syntax error on line 1 of ${vhost.source}: `
        + `SSLCertificateKeyFile: file '${vhost.sslCertificateKeyFile}' does not exist or is empty`);
    }
    const cert = pemToCert(certPem);
    const key = pemToPrivateKey(keyPem);
    if (!cert || !key) {
      return fail(`AH02561: Failed to configure certificate ${vhost.serverName ?? '*'}:${port}, `
        + 'check /etc/apache2/ssl (SSL: error:0480006C:PEM routines::no start line)');
    }
    return { cert, key };
  }

  close(spec: PortSpec): void {
    const session = this.sessions.get(spec.port);
    if (!session) return;
    session.stop();
    this.sessions.delete(spec.port);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }

  listeningPorts(): number[] {
    return [...this.sessions.keys()].sort((a, b) => a - b);
  }

  /** `apachectl graceful`: re-reads without closing the open listeners. */
  reload(): string | null {
    const error = this.loadConfig();
    if (error) return error;
    const wanted = new Set(this.configuredPorts());
    for (const port of [...this.sessions.keys()]) {
      if (!wanted.has(port)) this.close({ port, protocol: 'tcp' });
    }
    return null;
  }

  // ─── serving ──────────────────────────────────────────────────────

  private respond(port: number, req: HttpMessage): HttpMessage {
    const target = (req.target ?? '/').split('?')[0];
    const hostHeader = req.headers.get('Host') ?? '';
    const vhost = selectVirtualHost(this.config, port, hostHeader);
    if (!vhost) {
      return this.log(req, this.response(404, 'Not Found', apacheNotFoundPage(target)), null);
    }

    let path = joinPath(vhost.documentRoot, decodeURIComponent(target));
    if (this.host.fs.isDirectory(path)) {
      const index = vhost.directoryIndex
        .map((f) => joinPath(path, f))
        .find((f) => this.host.fs.exists(f) && !this.host.fs.isDirectory(f));
      if (!index) {
        // With no real `Options Indexes` here, Apache refuses — which is
        // what Debian does on a directory with no index.
        return this.log(req, this.response(403, 'Forbidden', apacheForbiddenPage(target)), vhost);
      }
      path = index;
    }

    if (!this.host.fs.exists(path)) {
      this.host.appendLog(
        APACHE_ERROR_LOG,
        `${formatErrorTime(this.host.now())} [core:error] [pid 1] (2)No such file or directory: `
        + `[client 127.0.0.1] AH00035: access to ${target} denied (filesystem path '${path}') `
        + 'because search permissions are missing, or the file does not exist',
      );
      return this.log(req, this.response(404, 'Not Found', apacheNotFoundPage(target)), vhost);
    }
    if (!this.host.fs.readableBy(path, APACHE_UID, APACHE_GID)) {
      return this.log(req, this.response(403, 'Forbidden', apacheForbiddenPage(target)), vhost);
    }

    const body = this.host.fs.read(path) ?? '';
    return this.log(req, this.response(200, 'OK', body, contentTypeForPath(path)), vhost);
  }

  private response(code: number, reason: string, body: string, type = 'text/html'): HttpMessage {
    const res = createResponse(code, reason);
    res.headers.set('Server', `Apache/${APACHE_VERSION} (Ubuntu)`);
    res.headers.set('Content-Type', type);
    res.body = bytes(body);
    return res;
  }

  /** The `combined` format, the one `CustomLog … combined` names. */
  private log(
    req: HttpMessage, res: HttpMessage, vhost: { accessLog: string | null } | null,
  ): HttpMessage {
    const file = vhost?.accessLog ?? APACHE_ACCESS_LOG;
    if (file !== 'off') {
      this.host.appendLog(
        file,
        `127.0.0.1 - - [${formatAccessTime(this.host.now())}] `
        + `"${req.method ?? 'GET'} ${req.target ?? '/'} HTTP/${req.httpVersion}" `
        + `${res.statusCode ?? 0} ${res.body?.length ?? 0} "-" `
        + `"${req.headers.get('User-Agent') ?? '-'}"`,
      );
    }
    return res;
  }
}
