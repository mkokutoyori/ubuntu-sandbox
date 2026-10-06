import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { TlsServerCredential } from '@/network/tls/TlsServerSession';
import type { HttpsServerConfig } from '@/network/http/https/HttpsServerSession';
import { credentialFor, resumptionConfig } from '@/network/http/https/ServerTlsToolkit';
import type { Http1Peer } from '@/network/http/http1/Http1ServerSession';
import { loadVhostTls, isApacheTlsProblem, vhostIdentifier, type ApacheVhostTls, type ApacheTlsProblem } from './ApacheTls';
import { DEFAULT_ECDH_GROUPS } from '../nginx/NginxTls';
import { sslCompatible } from './ApacheTls';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import { contentTypeForPath } from '@/network/http/HttpTypes';
import type { PortSpec } from '../../../../core/ports/PortNumber';
import type { ServiceSocketServer } from '../../ports/ServiceSocketServer';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import type { NginxHost } from '../nginx/LinuxNginxService';
import {
  parseApacheConfig, apacheWarnings, selectVirtualHost, loadedApacheModules,
  type ApacheConfig, type ApacheVirtualHost,
} from './ApacheConfig';
import {
  APACHE_VERSION, APACHE_PORTS_PATH, APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH,
  APACHE_ACCESS_LOG, APACHE_ERROR_LOG, APACHE_MODS_ENABLED, APACHE_CONF_PATH, APACHE_CONF_ENABLED,
  apacheNotFoundPage, apacheForbiddenPage, apacheBadRequestPage, apacheMisdirectedPage,
} from './ApacheFiles';
import { APACHE_LISTEN_BACKLOG } from '../../ports/ListenBacklogs';

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
  /** First certificate a declared TLS port cannot present, if any. */
  tlsProblem(): string | null;
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

interface PortTls {
  readonly vhosts: readonly { readonly vhost: ApacheVirtualHost; readonly tls: ApacheVhostTls }[];
  readonly defaultTls: ApacheVhostTls;
  readonly nameBased: boolean;
  readonly fingerprint: string;
}

const APACHE_LAYOUT = { mainConf: APACHE_CONF_PATH, modsEnabled: APACHE_MODS_ENABLED, confEnabled: APACHE_CONF_ENABLED };

export class LinuxApacheService implements ServiceSocketServer, ApacheControl {
  private config: ApacheConfig = { listenPorts: [], vhosts: [] };
  private loaded = false;
  private readonly sessions = new Map<number, ApacheSession>();
  private readonly tlsInUse = new Map<number, string>();
  private readonly portTls = new Map<number, PortTls>();

  constructor(private readonly host: NginxHost) {}

  loadConfig(): string | null {
    const { config, error } = parseApacheConfig(
      this.host.fs, APACHE_PORTS_PATH, APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH,
      this.modules(), APACHE_LAYOUT,
    );
    this.config = config;
    this.loaded = error === null;
    return error ? error.message : null;
  }

  /**
   * Les modules chargés, relus à CHAQUE fois : `a2enmod` pose un lien et
   * ne prévient personne, donc les garder en cache ferait juger la
   * configuration sur un état périmé.
   */
  private modules(): ReadonlySet<string> {
    return loadedApacheModules(this.host.fs, APACHE_MODS_ENABLED);
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
    if (isApacheTlsProblem(tls)) { this.reportStartupFailure(tls.error); return false; }
    if (tls !== null) {
      for (const entry of tls.vhosts) {
        for (const warning of entry.tls.warnings) {
          this.host.appendLog(APACHE_ERROR_LOG, `${formatErrorTime(this.host.now())} [ssl:error] [pid 1] ${warning}`);
        }
      }
    }

    const session: ApacheSession = tls === null
      ? new Http1ServerSession(
        this.host.tcpStack(), spec.port, (req) => this.respond(spec.port, req),
      )
      : new HttpsServerSession(
        this.host.tcpStack(), spec.port, this.engineConfig(tls),
        (req, peer) => this.respond(spec.port, req, peer),
      );
    try {
      session.start(identity, APACHE_LISTEN_BACKLOG);
    } catch {
      return false;
    }
    this.sessions.set(spec.port, session);
    if (tls !== null) {
      this.tlsInUse.set(spec.port, tls.fingerprint);
      this.portTls.set(spec.port, tls);
    }
    return true;
  }

  /**
   * The certificate a port presents, `null` for plain HTTP, a problem when
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
  private tlsMaterialFor(port: number): PortTls | null | ApacheTlsProblem {
    const onPort = this.config.vhosts.filter((v) => v.port === port && v.ssl.engine);
    if (onPort.length === 0) return null;
    return this.loadPortTls(this.config.vhosts.filter((v) => v.port === port), onPort);
  }

  private loadPortTls(
    all: readonly ApacheVirtualHost[], onPort: readonly ApacheVirtualHost[],
  ): PortTls | ApacheTlsProblem {
    const loaded: { vhost: ApacheVirtualHost; tls: ApacheVhostTls }[] = [];
    for (const vhost of onPort) {
      const tls = loadVhostTls(vhost, this.host.fs, vhost.protocolSet, {
        tcpStack: () => this.host.tcpStack(), resolve: (name) => this.host.resolve?.(name) ?? null,
        now: () => this.host.now().getTime(),
      });
      if (isApacheTlsProblem(tls)) return tls;
      loaded.push({ vhost, tls });
    }
    return {
      vhosts: loaded, defaultTls: loaded[0].tls, nameBased: all.length > 1,
      fingerprint: loaded.map((e) => `${e.vhost.serverName ?? '*'}#${e.tls.fingerprint}`).join('||'),
    };
  }

  private engineConfig(port: PortTls): HttpsServerConfig {
    const base = port.defaultTls;
    const settings = base.settings;
    const identity = base.identity;
    const credentials: TlsServerCredential[] = port.vhosts.map((entry) => credentialFor(
      entry.tls.identity,
      (name) => selectVirtualHost(this.config, entry.vhost.port, name, port.vhosts.map((e) => e.vhost)) === entry.vhost,
      false,
      entry.tls.protocolSet ? entry.tls.protocols : undefined,
    ));
    const verifying = port.vhosts.find((e) => e.tls.settings.verifyClient !== 'none');
    const resumption = resumptionConfig({
      tickets: base.sessionTickets,
      serverSideCache: !['none', 'nonenotnull'].includes(settings.sessionCache.toLowerCase()),
      timeoutSeconds: settings.sessionCacheTimeout,
      ticketKey: base.ticketKey,
    });
    return {
      serverCert: identity.cert, serverChain: identity.chain, serverPrivateKey: identity.key,
      protocols: base.protocols, cipherList: base.cipherList, preferServerCiphers: base.preferServerCiphers,
      tls13Ciphersuites: base.tls13Ciphersuites, supportedGroups: base.groups ?? DEFAULT_ECDH_GROUPS,
      extendedMasterSecret: base.extendedMasterSecret,
      sniCredentials: credentials, ocspStaple: base.staple,
      ...resumption,
      ...(verifying
        ? {
          requestClientCert: true,
          clientCertPolicy: verifying.tls.settings.verifyClient === 'require' ? 'strict' as const
            : verifying.tls.settings.verifyClient === 'optional' ? 'optional' as const : 'optional_no_ca' as const,
          verifier: verifying.tls.verifier ?? new CertificateVerifier({ trustAnchors: [] }),
        }
        : {}),
    };
  }

  close(spec: PortSpec): void {
    const session = this.sessions.get(spec.port);
    if (!session) return;
    session.stop();
    this.sessions.delete(spec.port);
    this.tlsInUse.delete(spec.port);
    this.portTls.delete(spec.port);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.tlsInUse.clear();
    this.portTls.clear();
  }

  listeningPorts(): number[] {
    return [...this.sessions.keys()].sort((a, b) => a - b);
  }

  /** `apachectl graceful`: re-reads without closing the open listeners. */
  /**
   * The first TLS port whose certificate cannot be presented.
   *
   * The real `nginx -t` / `apachectl configtest` READ the certificates —
   * a configuration pointing at an unreadable one fails the test rather
   * than passing it and failing later. That is also what keeps a botched
   * renewal from taking the site down: the reload is refused before
   * anything is torn down, and the running server keeps serving.
   */
  tlsProblem(): string | null {
    // Parsed FRESH into a local, never through `this.config`:
    // `apachectl configtest` is read-only and must not move the running
    // server's view of its own configuration.
    const { config } = parseApacheConfig(
      this.host.fs, APACHE_PORTS_PATH, APACHE_SITES_ENABLED, APACHE_ENVVARS_PATH,
      this.modules(), APACHE_LAYOUT,
    );
    for (const port of new Set(config.vhosts.filter((v) => v.ssl.engine).map((v) => v.port))) {
      const onPort = config.vhosts.filter((v) => v.port === port && v.ssl.engine);
      const material = this.loadPortTls(config.vhosts.filter((v) => v.port === port), onPort);
      if (isApacheTlsProblem(material)) return material.error;
    }
    return null;
  }

  reload(): string | null {
    const error = this.loadConfig();
    if (error) return error;
    const wanted = new Set(this.configuredPorts());
    for (const port of [...this.sessions.keys()]) {
      if (!wanted.has(port)) this.close({ port, protocol: 'tcp' });
    }
    this.reopenChangedTlsPorts();
    return null;
  }

  private reopenChangedTlsPorts(): void {
    for (const port of [...this.sessions.keys()]) {
      const previous = this.tlsInUse.get(port);
      if (previous === undefined) continue;
      const fresh = this.tlsMaterialFor(port);
      if (fresh === null || isApacheTlsProblem(fresh)) continue;
      if (fresh.fingerprint === previous) continue;
      this.close({ port, protocol: 'tcp' });
      this.open({ port, protocol: 'tcp' });
    }
  }


  // ─── serving ──────────────────────────────────────────────────────

  private sniGate(port: number, req: HttpMessage, vhost: ApacheVirtualHost, peer: Http1Peer | undefined): HttpMessage | null {
    const tls = peer?.tls;
    if (!tls) return null;
    const hostHeader = req.headers.get('Host');
    const portTls = this.portTls.get(port);
    if (tls.serverName !== null) {
      if (!hostHeader) {
        this.reportRequestError('AH02031', `Hostname ${tls.serverName} provided via SNI, but no hostname provided in HTTP request`, peer);
        return this.response(400, 'Bad Request', apacheBadRequestPage());
      }
      const handshake = portTls
        ? selectVirtualHost(this.config, port, tls.serverName, portTls.vhosts.map((e) => e.vhost))
        : vhost;
      if (handshake !== vhost && portTls && !sslCompatible(portTls, handshake, vhost)) {
        this.reportRequestError('AH02032',
          `Hostname ${tls.serverName} provided via SNI and hostname ${hostHeader.split(':')[0]} provided via HTTP have no compatible SSL setup`, peer);
        return this.response(421, 'Misdirected Request', apacheMisdirectedPage(hostHeader.split(':')[0], port));
      }
      return null;
    }
    const handshakeTls = portTls?.defaultTls;
    const strict = vhost.ssl.strictSniVhostCheck || (handshakeTls?.settings.strictSniVhostCheck ?? false);
    if (strict && portTls?.nameBased) {
      this.reportRequestError('AH02033', 'No hostname was provided via SNI for a name based virtual host', peer);
      return this.response(403, 'Forbidden', apacheForbiddenPage(req.target ?? '/'));
    }
    return null;
  }

  private reportRequestError(code: string, message: string, peer: Http1Peer | undefined): void {
    this.host.appendLog(
      APACHE_ERROR_LOG,
      `${formatErrorTime(this.host.now())} [ssl:error] [pid 1] [client ${peer?.ip ?? '127.0.0.1'}:${peer?.port ?? 0}] ${code}: ${message}`,
    );
  }

  private respond(port: number, req: HttpMessage, peer?: Http1Peer): HttpMessage {
    const target = (req.target ?? '/').split('?')[0];
    const hostHeader = req.headers.get('Host') ?? '';
    const vhost = selectVirtualHost(this.config, port, hostHeader);
    if (!vhost) {
      return this.log(req, this.response(404, 'Not Found', apacheNotFoundPage(target)), null);
    }
    const gated = this.sniGate(port, req, vhost, peer);
    if (gated) return this.log(req, gated, vhost);

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
