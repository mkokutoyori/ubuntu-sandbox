import type { TcpStack } from '@/network/tcp/TcpStack';
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
import {
  parseNginxConfig, extractServers, validateNginxConfig,
  type NginxFileSource, type NginxServerBlock, type NginxLocation,
} from './NginxConfig';
import {
  NGINX_VERSION, NGINX_ACCESS_LOG, NGINX_ERROR_LOG,
  notFoundPage, forbiddenPage,
} from './NginxFiles';

export interface NginxHostFs extends NginxFileSource {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readableBy(path: string, uid: number, gid: number): boolean;
}

export interface NginxHost {
  readonly fs: NginxHostFs;
  tcpStack(): TcpStack;
  /** Un autre processus tient-il déjà ce port ? */
  portTaken(port: number): boolean;
  appendLog(path: string, line: string): void;
  now(): Date;
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

function matchLocation(server: NginxServerBlock, target: string): NginxLocation | null {
  let best: NginxLocation | null = null;
  for (const loc of server.locations) {
    if (target.startsWith(loc.path) && (!best || loc.path.length > best.path.length)) best = loc;
  }
  return best;
}

function hostMatches(server: NginxServerBlock, hostHeader: string): boolean {
  const name = hostHeader.split(':')[0].toLowerCase();
  return server.serverNames.some((n) => {
    if (n === '_' || n === name) return true;
    if (n.startsWith('*.')) return name.endsWith(n.slice(1));
    return false;
  });
}

const NGINX_UID = 33;
const NGINX_GID = 33;

/**
 * nginx (docs/PRD-Nginx.md §P1/§P2) — un serveur de configuration posé sur
 * `Http1ServerSession`, exactement comme `WindowsIisRole`. Aucun moteur
 * HTTP nouveau : ce qui est écrit ici, c'est la lecture de
 * `/etc/nginx/nginx.conf` et le choix du fichier à servir.
 *
 * La configuration est la source de vérité : `reload()` relit les fichiers
 * et rien d'autre ne décrit l'état du serveur, de sorte qu'un `vim` sur
 * `sites-available/default` change vraiment ce qui est servi.
 */
/** Ce que la commande `nginx` pilote, sans dépendre de la classe entière. */
export interface NginxControl {
  loadConfig(): string | null;
  reload(): string | null;
  stopAll(): void;
  listeningPorts(): number[];
}

/**
 * docs/PRD-Nginx.md §P5 — HTTPS.
 *
 * The PRD declared this phase blocked, and named the blocker exactly: no
 * path existed by which a certificate could reach the VFS under Linux, so
 * nginx would have read a file no learner could produce. That blocker is
 * gone — `openssl req -x509` writes real PEM (`docs/PRD-OpenSSL.md`) — and
 * this is the option the PRD itself preferred: write openssl first, then
 * let nginx read what it produces.
 *
 * No new TLS engine either: `HttpsServerSession` already drives a real
 * `TlsServerSession` record by record. All that was missing was reading
 * the two files and handing over the certificate.
 */
type NginxSession = Http1ServerSession | HttpsServerSession;

export class LinuxNginxService implements ServiceSocketServer, NginxControl {
  private servers: NginxServerBlock[] = [];
  private readonly sessions = new Map<number, NginxSession>();

  constructor(private readonly host: NginxHost) {}

  /** Relit la configuration. Rend l'erreur de nginx, ou null. */
  loadConfig(): string | null {
    const parsed = parseNginxConfig(this.host.fs);
    if (parsed.ok === false) return parsed.error.message;
    const invalid = validateNginxConfig(parsed.tree);
    if (invalid) return invalid.message;
    this.servers = extractServers(parsed.tree);
    return null;
  }

  /**
   * Ce que nginx constate au démarrage et que la seule lecture du fichier
   * ne peut pas dire : le port qu'il veut est-il libre ? Un vrai nginx
   * échoue ici, avec l'errno, et n'ouvre rien du tout.
   */
  portConflict(): string | null {
    for (const port of this.configuredPorts()) {
      if (this.sessions.has(port)) continue;
      if (this.host.portTaken(port)) {
        return `nginx: [emerg] bind() to 0.0.0.0:${port} failed (98: Address already in use)`;
      }
    }
    return null;
  }

  /** Le refus de démarrage part aussi dans le journal d'erreurs, comme le vrai. */
  reportStartupFailure(message: string): void {
    this.host.appendLog(NGINX_ERROR_LOG, `${formatErrorTime(this.host.now())} [emerg] 0#0: ${message.replace(/^nginx: \[emerg\] /, '')}`);
  }

  /** Les ports que la configuration déclare — ce que le service doit ouvrir. */
  configuredPorts(): number[] {
    const ports = new Set<number>();
    for (const s of this.servers) for (const l of s.listen) ports.add(l.port);
    return [...ports].sort((a, b) => a - b);
  }

  open(spec: PortSpec, identity?: ListenerIdentity): boolean {
    if (spec.protocol !== 'tcp') return false;
    if (this.servers.length === 0 && this.loadConfig() !== null) return false;
    // Le port demandé vient de systemd, qui a déjà tranché entre ce que
    // déclare le fichier et un `portOverride` passé en ligne de commande —
    // et l'override prime, comme sur une vraie machine. Le refuser ici
    // ferait de `-p 9090` une option acceptée sans effet.
    if (this.servers.length === 0) return false;
    if (this.sessions.has(spec.port)) return true;

    const tls = this.tlsMaterialFor(spec.port);
    if (tls === 'error') return false;

    const session: NginxSession = tls === null
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
   * The certificate a port presents, or `null` when it is plain HTTP.
   *
   * `'error'` is a THIRD outcome and not a variant of `null`: a port
   * declared `ssl` whose certificate cannot be read must not silently fall
   * back to serving cleartext on 443 — that would be the worst possible
   * answer, a machine quietly serving in the clear on the port whose whole
   * point is that it is not. The failure is written to `error.log` with
   * nginx's own wording, and the port stays shut.
   */
  private tlsMaterialFor(port: number): { cert: X509Certificate; key: PkiPrivateKey } | null | 'error' {
    const server = this.servers.find((s) => s.listen.some((l) => l.port === port && l.ssl));
    if (!server) return null;

    const fail = (message: string): 'error' => {
      this.reportStartupFailure(`nginx: [emerg] ${message}`);
      return 'error';
    };
    if (!server.sslCertificate || !server.sslCertificateKey) {
      return fail(`no "ssl_certificate" is defined for the "listen ... ssl" directive`);
    }
    const certPem = this.host.fs.read(server.sslCertificate);
    if (certPem === null) {
      return fail(`cannot load certificate "${server.sslCertificate}": `
        + 'BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory)');
    }
    const keyPem = this.host.fs.read(server.sslCertificateKey);
    if (keyPem === null) {
      return fail(`cannot load certificate key "${server.sslCertificateKey}": `
        + 'BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory)');
    }
    const cert = pemToCert(certPem);
    const key = pemToPrivateKey(keyPem);
    if (!cert) {
      return fail(`PEM_read_bio_X509_AUX("${server.sslCertificate}") failed `
        + '(SSL: error:0480006C:PEM routines::no start line:Expecting: TRUSTED CERTIFICATE)');
    }
    if (!key) {
      return fail(`cannot load certificate key "${server.sslCertificateKey}": `
        + 'PEM_read_bio_PrivateKey() failed (SSL: error:0480006C:PEM routines::no start line)');
    }
    return { cert, key };
  }

  close(spec: PortSpec): void {
    const session = this.sessions.get(spec.port);
    if (!session) return;
    session.stop();
    this.sessions.delete(spec.port);
  }

  /** `-s reload` : relit la configuration sans fermer les écoutes déjà ouvertes. */
  reload(): string | null {
    const error = this.loadConfig();
    if (error) return error;
    const wanted = new Set(this.configuredPorts());
    for (const port of [...this.sessions.keys()]) {
      if (!wanted.has(port)) this.close({ port, protocol: 'tcp' });
    }
    for (const port of wanted) {
      if (!this.sessions.has(port)) this.open({ port, protocol: 'tcp' });
    }
    return null;
  }

  stopAll(): void {
    for (const port of [...this.sessions.keys()]) this.close({ port, protocol: 'tcp' });
  }

  listeningPorts(): number[] {
    return [...this.sessions.keys()].sort((a, b) => a - b);
  }

  // ─── Traitement d'une requête ────────────────────────────────────────

  private selectServer(port: number, hostHeader: string): NginxServerBlock | null {
    const onPort = this.servers.filter((s) => s.listen.some((l) => l.port === port));
    // Écoute forcée sur un port qu'aucun bloc ne déclare : le site
    // configuré est quand même servi, sinon l'override ouvrirait un port
    // qui ne répond rien.
    if (onPort.length === 0) return this.servers[0] ?? null;
    const byName = onPort.find((s) => hostMatches(s, hostHeader));
    if (byName) return byName;
    return onPort.find((s) => s.listen.some((l) => l.port === port && l.defaultServer)) ?? onPort[0];
  }

  private respond(port: number, req: HttpMessage): HttpMessage {
    const target = (req.target ?? '/').split('?')[0];
    const hostHeader = req.headers.get('Host') ?? '';
    const server = this.selectServer(port, hostHeader);
    const response = server
      ? this.serve(server, target)
      : this.errorResponse(404, 'Not Found', notFoundPage());
    this.logRequest(server, req, response, target);
    return response;
  }

  private serve(server: NginxServerBlock, target: string): HttpMessage {
    const location = matchLocation(server, target);

    if (location?.returnStatus !== undefined) {
      const res = createResponse(location.returnStatus, location.returnStatus === 301 ? 'Moved Permanently' : 'Found');
      res.headers.set('Server', `nginx/${NGINX_VERSION}`);
      if (location.returnTarget) res.headers.set('Location', location.returnTarget);
      res.headers.set('Content-Length', '0');
      return res;
    }

    const root = location?.root ?? server.root;
    const indexes = location?.index ?? server.index;
    const fsPath = joinPath(root, decodeURIComponent(target));

    const candidates = this.host.fs.isDirectory(fsPath)
      ? indexes.map((i) => joinPath(fsPath, i))
      : [fsPath];

    for (const candidate of candidates) {
      if (!this.host.fs.exists(candidate) || this.host.fs.isDirectory(candidate)) continue;
      if (!this.host.fs.readableBy(candidate, NGINX_UID, NGINX_GID)) {
        return this.errorResponse(403, 'Forbidden', forbiddenPage(), server, location);
      }
      const body = this.host.fs.read(candidate) ?? '';
      const res = createResponse(200, 'OK');
      res.headers.set('Server', `nginx/${NGINX_VERSION}`);
      res.headers.set('Content-Type', contentTypeForPath(candidate));
      this.applyHeaders(res, server, location);
      res.body = bytes(body);
      return res;
    }

    if (this.host.fs.isDirectory(fsPath) && location?.autoindex) {
      const entries = this.host.fs.list(fsPath) ?? [];
      const listing = `<html><head><title>Index of ${target}</title></head><body>\r\n<h1>Index of ${target}</h1><hr><pre><a href="../">../</a>\r\n${entries.sort().map((e) => `<a href="${e}">${e}</a>`).join('\r\n')}\r\n</pre><hr></body>\r\n</html>\r\n`;
      const res = createResponse(200, 'OK');
      res.headers.set('Server', `nginx/${NGINX_VERSION}`);
      res.headers.set('Content-Type', 'text/html');
      this.applyHeaders(res, server, location);
      res.body = bytes(listing);
      return res;
    }

    if (this.host.fs.isDirectory(fsPath)) {
      return this.errorResponse(403, 'Forbidden', forbiddenPage(), server, location);
    }
    return this.errorResponse(404, 'Not Found', notFoundPage(), server, location);
  }

  private applyHeaders(res: HttpMessage, server?: NginxServerBlock, location?: NginxLocation | null): void {
    for (const [k, v] of server?.addHeaders ?? []) res.headers.set(k, v);
    for (const [k, v] of location?.addHeaders ?? []) res.headers.set(k, v);
  }

  private errorResponse(
    status: number, reason: string, body: string,
    server?: NginxServerBlock, location?: NginxLocation | null,
  ): HttpMessage {
    const res = createResponse(status, reason);
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    res.headers.set('Content-Type', 'text/html');
    this.applyHeaders(res, server, location);
    res.body = bytes(body);
    return res;
  }

  // ─── Journaux ────────────────────────────────────────────────────────

  private logRequest(
    server: NginxServerBlock | null, req: HttpMessage, res: HttpMessage, target: string,
  ): void {
    const status = res.statusCode ?? 0;
    const accessLog = server ? server.accessLog : NGINX_ACCESS_LOG;
    if (accessLog) {
      const line = `- - - [${formatLogTime(this.host.now())}] "${req.method ?? 'GET'} ${target} HTTP/${req.httpVersion}" ${status} ${res.body?.length ?? 0} "-" "${req.headers.get('User-Agent') ?? '-'}"`;
      this.host.appendLog(accessLog, line);
    }
    if (status >= 400) {
      const errorLog = server?.errorLog ?? NGINX_ERROR_LOG;
      const what = status === 403 ? 'Permission denied' : 'No such file or directory';
      this.host.appendLog(
        errorLog,
        `${formatErrorTime(this.host.now())} [error] 0#0: *1 open() "${joinPath(server?.root ?? '/var/www/html', target)}" failed (${status === 403 ? 13 : 2}: ${what}), request: "${req.method ?? 'GET'} ${target} HTTP/${req.httpVersion}"`,
      );
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string { return String(n).padStart(2, '0'); }

function formatLogTime(d: Date): string {
  return `${pad(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()}:${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0000`;
}

function formatErrorTime(d: Date): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
