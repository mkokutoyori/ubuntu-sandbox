import type { TcpStack } from '@/network/tcp/TcpStack';
import { Http1ServerSession, type Http1Peer } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { pemToCert, pemToPrivateKey } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import { contentTypeForPath } from '@/network/http/HttpTypes';
import type { PortSpec } from '../../../../core/ports/PortNumber';
import type { ServiceSocketServer } from '../../ports/ServiceSocketServer';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { createRequest } from '@/network/http/semantics/types';
import {
  parseNginxConfig, extractServers, extractUpstreams, validateNginxConfig,
  type NginxFileSource, type NginxServerBlock, type NginxLocation,
  type NginxUpstream, type NginxProxyPass,
} from './NginxConfig';
import {
  NGINX_VERSION, NGINX_ACCESS_LOG, NGINX_ERROR_LOG,
  notFoundPage, forbiddenPage, badGatewayPage,
} from './NginxFiles';

export interface NginxHostFs extends NginxFileSource {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readableBy(path: string, uid: number, gid: number): boolean;
}

export interface NginxHost {
  readonly fs: NginxHostFs;
  tcpStack(): TcpStack;
  /**
   * §P6 — `proxy_pass http://amont;` nomme le plus souvent un hôte et
   * non une adresse. Le mandataire résout par la machine qui l'exécute,
   * comme le vrai nginx : c'est le `/etc/hosts` et le
   * `/etc/resolv.conf` du serveur qui décident, pas une table à part.
   * `null` quand l'hôte ne se résout pas.
   */
  resolve?(name: string): string | null;
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

/**
 * §P6 — la borne de récursion du mandataire. Voir `proxyDepth`.
 */
const MAX_PROXY_DEPTH = 4;

/**
 * RFC 9110 §7.6.1 — les en-têtes qui décrivent la connexion elle-même
 * et non le message. Un mandataire ne les relaie pas, dans un sens
 * comme dans l'autre.
 */
const HOP_BY_HOP = [
  'Connection', 'Keep-Alive', 'Proxy-Authenticate', 'Proxy-Authorization',
  'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade',
];

/**
 * La règle de nginx, et c'est la plus mal comprise de `proxy_pass` :
 * la présence d'un chemin dans l'URI décide, pas sa valeur.
 *
 *   proxy_pass http://amont;    → /api/v1 part tel quel
 *   proxy_pass http://amont/;   → /api/v1 devient /v1   (le préfixe de
 *                                 la `location` est REMPLACÉ)
 *   proxy_pass http://amont/x;  → /api/v1 devient /x/v1
 *
 * D'où `path?: string` plutôt qu'une chaîne : `undefined` et `''` sont
 * deux configurations différentes.
 */
function rewriteTarget(target: string, locationPath: string, passPath?: string): string {
  if (passPath === undefined) return target;
  const reste = target.startsWith(locationPath) ? target.slice(locationPath.length) : target;
  const base = passPath.endsWith('/') ? passPath.slice(0, -1) : passPath;
  const suite = reste.startsWith('/') ? reste : `/${reste}`;
  const out = `${base}${suite}`;
  return out === '' ? '/' : out;
}

/**
 * Les variables que `proxy_set_header` emploie en pratique. Une
 * variable inconnue est laissée telle quelle plutôt que vidée : nginx
 * REFUSE au démarrage une variable qu'il ne connaît pas, et rendre une
 * chaîne vide ferait passer une faute de frappe pour un en-tête absent.
 */
function expandProxyVariables(
  value: string, req: HttpMessage, upstream: { host: string; port: number },
  peer?: Http1Peer,
): string {
  const client = peer?.ip ?? '0.0.0.0';
  return value
    .replace(/\$proxy_add_x_forwarded_for/g, (() => {
      // La variable la plus utile de la liste, et la seule qui AJOUTE :
      // elle empile le client derrière la chaîne déjà reçue, ce qui est
      // exactement ce que `X-Forwarded-For` sert à porter.
      const recu = req.headers.get('X-Forwarded-For');
      return recu ? `${recu}, ${client}` : client;
    })())
    .replace(/\$proxy_host/g, `${upstream.host}:${upstream.port}`)
    .replace(/\$http_host/g, req.headers.get('Host') ?? '')
    .replace(/\$host/g, (req.headers.get('Host') ?? '').split(':')[0])
    .replace(/\$remote_addr/g, client)
    .replace(/\$scheme/g, 'http')
    .replace(/\$request_uri/g, req.target ?? '/');
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
  /** First certificate a declared TLS port cannot present, if any. */
  tlsProblem(): string | null;
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

/** A port that asked for TLS and cannot have it, with the server's own words. */
interface TlsProblem { readonly error: string }

function isTlsProblem(v: unknown): v is TlsProblem {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/**
 * Identifies the material a port is currently serving, so a reload can
 * tell a renewed pair from the same one.
 *
 * The key's material is part of it on purpose: replacing only the KEY
 * file leaves the certificate's serial unchanged, and a fingerprint built
 * from the certificate alone would miss that — the server would keep
 * presenting a pair whose halves no longer match. It lives in a private
 * in-memory map, no more exposed than the key already is inside the live
 * TLS session.
 */
function tlsFingerprint(m: { cert: X509Certificate; key: PkiPrivateKey }): string {
  return `${m.cert.serialNumber}|${m.cert.notAfter}|${m.key.material}`;
}


export class LinuxNginxService implements ServiceSocketServer, NginxControl {
  private servers: NginxServerBlock[] = [];
  private upstreams: NginxUpstream[] = [];
  /**
   * §P6 — profondeur de mandat en cours.
   *
   * La livraison des trames est SYNCHRONE ici : le mandataire appelle
   * l'amont depuis l'intérieur de son propre gestionnaire de requête, et
   * une configuration qui se mandate elle-même récurserait sans fin,
   * bloquant l'onglet. Un vrai nginx boucle aussi, mais il finit par
   * épuiser ses connexions et répondre une erreur ; ici il n'y a rien à
   * épuiser, donc la borne est explicite.
   */
  private proxyDepth = 0;
  private readonly sessions = new Map<number, NginxSession>();
  /**
   * What each open TLS port was started with, so a reload can tell a
   * renewed certificate from the same one. Without it, `systemctl reload`
   * after replacing the PEM kept serving the OLD certificate — the exact
   * operation certbot automates, and the one moment an operator checks.
   */
  private readonly tlsInUse = new Map<number, string>();

  constructor(private readonly host: NginxHost) {}

  /** Relit la configuration. Rend l'erreur de nginx, ou null. */
  loadConfig(): string | null {
    const parsed = parseNginxConfig(this.host.fs);
    if (parsed.ok === false) return parsed.error.message;
    const invalid = validateNginxConfig(parsed.tree);
    if (invalid) return invalid.message;
    this.servers = extractServers(parsed.tree);
    this.upstreams = extractUpstreams(parsed.tree);
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
    if (isTlsProblem(tls)) { this.reportStartupFailure(tls.error); return false; }

    const session: NginxSession = tls === null
      ? new Http1ServerSession(
        this.host.tcpStack(), spec.port, (req, peer) => this.respond(spec.port, req, peer),
      )
      : new HttpsServerSession(
        this.host.tcpStack(), spec.port,
        { serverCert: tls.cert, serverPrivateKey: tls.key },
        (req, peer) => this.respond(spec.port, req, peer),
      );
    try {
      session.start(identity);
    } catch {
      return false;
    }
    this.sessions.set(spec.port, session);
    if (tls !== null) this.tlsInUse.set(spec.port, tlsFingerprint(tls));
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
  private tlsMaterialFor(port: number): { cert: X509Certificate; key: PkiPrivateKey } | null | TlsProblem {
    const server = this.servers.find((s) => s.listen.some((l) => l.port === port && l.ssl));
    if (!server) return null;
    return this.tlsMaterialForServer(server, port);
  }

  private tlsMaterialForServer(
    server: NginxServerBlock, port: number,
  ): { cert: X509Certificate; key: PkiPrivateKey } | null | TlsProblem {
    const fail = (message: string): TlsProblem => ({ error: `nginx: [emerg] ${message}` });
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
    // Parsed FRESH into a local, never through `this.servers`: `nginx -t`
    // is a read-only command and must not move the running server's view
    // of its own configuration, and the files on disk are what it is
    // being asked about.
    const parsed = parseNginxConfig(this.host.fs);
    if (parsed.ok === false) return null;
    for (const server of extractServers(parsed.tree)) {
      for (const l of server.listen) {
        if (!l.ssl) continue;
        const material = this.tlsMaterialForServer(server, l.port);
        if (isTlsProblem(material)) return material.error;
      }
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
    this.reopenRenewedTlsPorts();
    for (const port of wanted) {
      if (!this.sessions.has(port)) this.open({ port, protocol: 'tcp' });
    }
    return null;
  }

  /**
   * A reload re-reads the certificates, because renewing one and
   * reloading is THE routine TLS operation — it is what certbot does.
   *
   * This exists for `nginx -s reload` SPECIFICALLY, and the measurement
   * is worth recording: `systemctl reload nginx` already picked a renewal
   * up on its own, because the service manager's `resyncServicePorts`
   * releases and rebinds the unit's sockets, which re-reads the files.
   * `nginx -s reload` goes straight to the server with nothing behind it,
   * so without this the running session kept the certificate it started
   * with. Apache has no equivalent path — its `reload()` is only ever
   * reached through the lifecycle — so it deliberately has no twin of
   * this method rather than a copy nothing exercises.
   *
   * A port whose new material cannot be read is left ALONE rather than
   * closed: the real server aborts the reload and its old workers keep
   * serving with the old certificate. Going dark on a bad renewal would
   * turn a recoverable mistake into an outage.
   */
  private reopenRenewedTlsPorts(): void {
    for (const port of [...this.sessions.keys()]) {
      const previous = this.tlsInUse.get(port);
      if (previous === undefined) continue;
      const fresh = this.tlsMaterialFor(port);
      if (fresh === null || isTlsProblem(fresh)) continue;
      if (tlsFingerprint(fresh) === previous) continue;
      // Close AND reopen here rather than closing and trusting someone
      // else to notice: this method is the only thing that knows the
      // material changed, so leaving the port shut for another step to
      // pick up would make a renewal depend on who runs next.
      this.close({ port, protocol: 'tcp' });
      this.open({ port, protocol: 'tcp' });
    }
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

  private respond(port: number, req: HttpMessage, peer?: Http1Peer): HttpMessage {
    const target = (req.target ?? '/').split('?')[0];
    const hostHeader = req.headers.get('Host') ?? '';
    const server = this.selectServer(port, hostHeader);
    const response = server
      ? this.serve(server, target, req, peer)
      : this.errorResponse(404, 'Not Found', notFoundPage());
    this.logRequest(server, req, response, target, peer);
    return response;
  }

  private serve(
    server: NginxServerBlock, target: string,
    req?: HttpMessage, peer?: Http1Peer,
  ): HttpMessage {
    const location = matchLocation(server, target);

    if (location?.proxyPass && req) {
      return this.proxy(server, location, location.proxyPass, target, req, peer);
    }

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

  /**
   * §P6 — nginx en mandataire inverse.
   *
   * Il n'y a rien d'asynchrone ici, et ce n'est pas une simplification :
   * la livraison des trames est synchrone dans ce simulateur, donc
   * `Http1ClientSession.send()` rend la réponse de l'amont avant de
   * revenir. Le PRD supposait le contraire et annonçait « un chantier à
   * part entière » ; la mesure a montré qu'un gestionnaire de requête
   * peut appeler l'amont EN LIGNE et écrire sa réponse dans la foulée.
   */
  private proxy(
    server: NginxServerBlock, location: NginxLocation,
    pass: NginxProxyPass, target: string, req: HttpMessage, peer?: Http1Peer,
  ): HttpMessage {
    if (pass.scheme === 'https') {
      // Refusé plutôt qu'ouvert en clair : tout ce qui lit `https`
      // attend du chiffré, et parler en clair sur cette foi serait la
      // pire des réponses disponibles — la même règle que `tlsMaterialFor`.
      return this.badGateway(server, location,
        'https upstreams are not supported by this simulator', peer);
    }
    if (this.proxyDepth >= MAX_PROXY_DEPTH) {
      return this.badGateway(server, location,
        `proxy loop detected after ${MAX_PROXY_DEPTH} hops`, peer);
    }

    const target502 = this.resolveUpstream(pass);
    if (!target502) {
      return this.badGateway(server, location,
        `${pass.host} could not be resolved`, peer);
    }

    const outboundTarget = rewriteTarget(target, location.path, pass.path);
    const request = createRequest(req.method ?? 'GET', outboundTarget);
    for (const [k, v] of req.headers.entries()) request.headers.set(k, v);
    // Par défaut nginx réécrit `Host` avec l'autorité du `proxy_pass` ;
    // `proxy_set_header Host $host` est précisément ce qu'on écrit pour
    // l'en empêcher, donc l'ordre compte et le défaut vient d'abord.
    request.headers.set('Host', `${target502.host}:${target502.port}`);
    // Un mandataire ne relaie pas les en-têtes saut-par-saut (RFC 9110
    // §7.6.1) : les transmettre ferait fermer la connexion de l'amont
    // par celle du client.
    for (const hop of HOP_BY_HOP) request.headers.delete(hop);
    for (const [name, value] of [...server.proxySetHeaders, ...location.proxySetHeaders]) {
      const resolved = expandProxyVariables(value, req, target502, peer);
      if (resolved === '') request.headers.delete(name);
      else request.headers.set(name, resolved);
    }
    request.body = req.body;

    this.proxyDepth++;
    let sent;
    try {
      const client = new Http1ClientSession(
        this.host.tcpStack(), target502.ip, target502.port);
      sent = client.send(request);
      client.close();
    } finally {
      this.proxyDepth--;
    }

    if (!sent.ok || !sent.response) {
      return this.badGateway(server, location,
        sent.error ?? 'no response from upstream', peer);
    }
    const res = sent.response;
    for (const hop of HOP_BY_HOP) res.headers.delete(hop);
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    this.applyHeaders(res, server, location);
    return res;
  }

  /**
   * `proxy_pass http://amont;` désigne soit un bloc `upstream`, soit un
   * hôte. L'`upstream` est consulté EN PREMIER, comme chez nginx : un
   * bloc de ce nom masque un hôte qui s'appellerait pareil.
   */
  private resolveUpstream(
    pass: NginxProxyPass,
  ): { ip: string; host: string; port: number } | null {
    const group = this.upstreams.find((u) => u.name === pass.host);
    if (group) {
      for (const member of group.servers) {
        if (member.down) continue;
        const ip = this.resolveHost(member.host);
        if (ip) return { ip, host: member.host, port: member.port };
      }
      return null;
    }
    const ip = this.resolveHost(pass.host);
    return ip ? { ip, host: pass.host, port: pass.port } : null;
  }

  private resolveHost(name: string): string | null {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name;
    return this.host.resolve?.(name) ?? null;
  }

  /**
   * `502 Bad Gateway`, et la RAISON dans le journal d'erreurs — c'est
   * là que l'opérateur la cherche, la page servie au client ne la
   * portant jamais.
   */
  private badGateway(
    server: NginxServerBlock, location: NginxLocation, reason: string,
    peer?: Http1Peer,
  ): HttpMessage {
    this.host.appendLog(server.errorLog ?? NGINX_ERROR_LOG,
      `${formatErrorTime(this.host.now())} [error] 0#0: *1 ${reason}, `
      + `client: ${peer?.ip ?? '0.0.0.0'}, server: ${server.serverNames[0] ?? '_'}`);
    return this.errorResponse(502, 'Bad Gateway', badGatewayPage(), server, location);
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
    peer?: Http1Peer,
  ): void {
    const status = res.statusCode ?? 0;
    const accessLog = server ? server.accessLog : NGINX_ACCESS_LOG;
    if (accessLog) {
      // Le format combiné commence par l'adresse du client. Elle valait
      // `-` faute de la connaître ; un journal d'accès qui ne dit pas
      // qui a demandé est la moitié d'un journal d'accès.
      const line = `${peer?.ip ?? '-'} - - [${formatLogTime(this.host.now())}] "${req.method ?? 'GET'} ${target} HTTP/${req.httpVersion}" ${status} ${res.body?.length ?? 0} "-" "${req.headers.get('User-Agent') ?? '-'}"`;
      this.host.appendLog(accessLog, line);
    }
    // Seuls 403 et 404 viennent d'une recherche de FICHIER, et cette
    // ligne parle d'`open()`. Avant §P6, tout ce qui dépassait 400
    // venait de là, si bien qu'un `status >= 400` était équivalent ; un
    // `502` du mandataire ne l'est plus — il n'a ouvert aucun fichier,
    // et il a déjà écrit sa vraie raison. La conserver produisait deux
    // lignes pour une panne, dont une fausse.
    if (status === 403 || status === 404) {
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
