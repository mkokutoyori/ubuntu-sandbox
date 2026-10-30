import type { TcpStack } from '@/network/tcp/TcpStack';
import { Http1ServerSession, type Http1Peer } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { CertificateVerifier, type VerificationReason } from '@/network/pki/CertificateVerifier';
import { x509VerifyError } from '@/network/pki/x509VerifyErrors';
import type { TlsServerCredential } from '@/network/tls/TlsServerSession';
import type { HttpsServerConfig } from '@/network/http/https/HttpsServerSession';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import type { PortSpec } from '../../../../core/ports/PortNumber';
import type { ServiceSocketServer } from '../../ports/ServiceSocketServer';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { createRequest } from '@/network/http/semantics/types';
import {
  parseNginxConfig, extractServers, extractUpstreams, validateNginxConfig,
  type NginxFileSource, type NginxServerBlock, type NginxLocation,
  type NginxUpstream, type NginxProxyPass, type NginxUpstreamServer,
} from './NginxConfig';
import {
  NGINX_VERSION, NGINX_ACCESS_LOG, NGINX_ERROR_LOG,
  notFoundPage, forbiddenPage, badGatewayPage, sslCertificateErrorPage, sslNoCertificatePage, misdirectedPage,
} from './NginxFiles';
import type { OcspWireDeps } from '@/network/http/ocsp/OcspHttpClient';
import { loadServerTls, isTlsProblem, type ServerTls, type TlsProblem } from './NginxTls';
import { ephemeralIdentity, resumptionConfig, credentialFor } from '@/network/http/https/ServerTlsToolkit';
import { clientCertificateVerdict } from './NginxSsl';
import { applyGzipFilter } from './NginxGzip';
import { evaluateConditional, fileValidators, httpDate } from './NginxConditional';
import { applyRangeFilter } from './NginxRange';
import { rewriteSetCookie } from './NginxCookie';
import {
  runRewriteOps, type NginxRewriteOp, type RewriteEnv, type RewriteState,
} from './NginxRewrite';
import { nginxReason, errorPage } from './NginxStatus';
import { contentTypeFor } from './NginxMime';
import type { NginxReturnRule } from './NginxReturn';
import type { NginxTryFiles } from './NginxTryFiles';
import { findErrorPage, KEEP_STATUS, REPLACEMENT_STATUS } from './NginxErrorPage';
import { expandNginxVariables, type NginxVariableContext } from './NginxVariables';
import {
  absoluteLocationValue, isRedirectStatus, rewriteRedirectValue, type NginxRedirectSettings,
} from './NginxRedirect';
import { findServerByName, serverNameMatches, type ServerNameEntry } from './NginxServerNames';
import { NGINX_LISTEN_BACKLOG } from '../../ports/ListenBacklogs';
import { binaryStringToBytes as bytes } from '@/crypto/encoding';

export interface NginxHostFs extends NginxFileSource {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readableBy(path: string, uid: number, gid: number): boolean;
  stat(path: string): { readonly mtimeMs: number; readonly size: number } | null;
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

interface Handled {
  readonly response: HttpMessage;
  readonly location: NginxLocation | null;
}

const MAX_URI_CHANGES = 10;

function splitTarget(target: string): [string, string] {
  const at = target.indexOf('?');
  return at < 0 ? [target, ''] : [target.slice(0, at), target.slice(at + 1)];
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function matchLocation(server: NginxServerBlock, target: string): NginxLocation | null {
  let best: NginxLocation | null = null;
  for (const loc of server.locations) {
    if (target.startsWith(loc.path) && (!best || loc.path.length > best.path.length)) best = loc;
  }
  return best;
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

interface PortTls {
  readonly servers: readonly { readonly block: NginxServerBlock; readonly tls: ServerTls }[];
  readonly defaultTls: ServerTls;
  readonly fingerprint: string;
}

export class LinuxNginxService implements ServiceSocketServer, NginxControl {
  private servers: NginxServerBlock[] = [];
  private readonly generated = new WeakSet<HttpMessage>();
  private readonly rangeable = new WeakSet<HttpMessage>();
  private readonly rewriteBuckets = new WeakMap<HttpMessage, RewriteBucket>();
  private rangeBoundary = 0;
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
  /**
   * L'état d'équilibrage, par groupe : où en est le tour de rôle, et ce
   * que chaque membre a raté récemment.
   *
   * Il vit ici et non dans la configuration parce que c'est une MESURE,
   * pas une déclaration. Mais il est REMIS À ZÉRO par `loadConfig()`,
   * et ce détail a été corrigé après mesure : un rechargement fait
   * naître de nouveaux processus de travail chez nginx, et sans
   * `zone` chacun part avec des compteurs vierges. Le garder aurait
   * fait servir un membre de secours dès la première requête suivant un
   * rechargement, sur la foi d'une panne constatée avant.
   */
  private readonly balance = new Map<string, {
    curseur: number;
    echecs: Map<string, { compte: number; depuis: number }>;
  }>();
  private readonly sessions = new Map<number, NginxSession>();
  /**
   * What each open TLS port was started with, so a reload can tell a
   * renewed certificate from the same one. Without it, `systemctl reload`
   * after replacing the PEM kept serving the OLD certificate — the exact
   * operation certbot automates, and the one moment an operator checks.
   */
  private readonly tlsInUse = new Map<number, string>();
  private readonly portTls = new Map<number, PortTls>();

  constructor(private readonly host: NginxHost) {}

  /** Relit la configuration. Rend l'erreur de nginx, ou null. */
  loadConfig(): string | null {
    const parsed = parseNginxConfig(this.host.fs);
    if (parsed.ok === false) return parsed.error.message;
    const invalid = validateNginxConfig(parsed.tree);
    if (invalid) return invalid.message;
    this.servers = extractServers(parsed.tree);
    this.upstreams = extractUpstreams(parsed.tree);
    this.balance.clear();
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

  private reportStartupWarnings(port: PortTls): void {
    for (const entry of port.servers) {
      for (const warning of entry.tls.warnings) {
        this.host.appendLog(NGINX_ERROR_LOG, `${formatErrorTime(this.host.now())} [warn] 0#0: ${warning}`);
      }
    }
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
    if (tls !== null) this.reportStartupWarnings(tls);

    const session: NginxSession = tls === null
      ? new Http1ServerSession(
        this.host.tcpStack(), spec.port, (req, peer) => this.respond(spec.port, req, peer),
      )
      : new HttpsServerSession(
        this.host.tcpStack(), spec.port, this.engineConfig(tls),
        (req, peer) => this.respond(spec.port, req, peer),
      );
    try {
      session.start(identity, NGINX_LISTEN_BACKLOG);
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
   * The certificate a port presents, or `null` when it is plain HTTP.
   *
   * `'error'` is a THIRD outcome and not a variant of `null`: a port
   * declared `ssl` whose certificate cannot be read must not silently fall
   * back to serving cleartext on 443 — that would be the worst possible
   * answer, a machine quietly serving in the clear on the port whose whole
   * point is that it is not. The failure is written to `error.log` with
   * nginx's own wording, and the port stays shut.
   */
  private tlsMaterialFor(port: number): PortTls | null | TlsProblem {
    const onPort = this.servers.filter((s) => s.listen.some((l) => l.port === port && l.ssl));
    if (onPort.length === 0) return null;
    return this.loadPortTls(onPort, port);
  }

  private readonly ocspZones = new Map<string, unknown>();

  private wireDeps(): OcspWireDeps {
    return { tcpStack: () => this.host.tcpStack(), resolve: (name) => this.host.resolve?.(name) ?? null, now: () => this.host.now().getTime(), sharedCache: this.ocspZones };
  }

  private loadPortTls(onPort: readonly NginxServerBlock[], port: number): PortTls | TlsProblem {
    const loaded: { block: NginxServerBlock; tls: ServerTls }[] = [];
    for (const block of onPort) {
      const tls = loadServerTls(block, this.host.fs, this.wireDeps());
      if (isTlsProblem(tls)) return tls;
      loaded.push({ block, tls });
    }
    const defaultEntry = loaded.find((e) => e.block.listen.some((l) => l.port === port && l.defaultServer)) ?? loaded[0];
    return {
      servers: loaded, defaultTls: defaultEntry.tls,
      fingerprint: loaded.map((e) => `${e.block.serverNames.join(',')}#${e.tls.fingerprint}`).join('||'),
    };
  }

  private engineConfig(port: PortTls): HttpsServerConfig {
    const base = port.defaultTls;
    const settings = base.settings;
    const credentials: TlsServerCredential[] = [];
    const entries: ServerNameEntry<{ block: NginxServerBlock; tls: ServerTls }>[] = [];
    for (const entry of port.servers) {
      for (const name of entry.block.serverNames) entries.push({ pattern: name, owner: entry });
    }
    const fallback = base.identity
      ?? port.servers.find((e) => e.tls.identity !== null)?.tls.identity
      ?? ephemeralIdentity();
    for (const entry of port.servers) {
      credentials.push(credentialFor(
        entry.tls.identity ?? fallback, (name) => findServerByName(entries, name) === entry,
        entry.tls.settings.rejectHandshake,
      ));
    }
    const verifying = port.servers.find((e) => e.tls.settings.verifyClient !== 'off');
    const resumption = resumptionConfig({
      tickets: base.sessionTickets,
      serverSideCache: settings.sessionCache.builtin === 'builtin' || settings.sessionCache.shared !== null,
      timeoutSeconds: settings.sessionTimeout,
      ticketKey: base.ticketKey,
    });
    return {
      serverCert: fallback.cert, serverChain: fallback.chain, serverPrivateKey: fallback.key,
      protocols: base.protocols, cipherList: base.cipherList, preferServerCiphers: base.preferServerCiphers,
      tls13Ciphersuites: base.tls13Ciphersuites, supportedGroups: base.groups,
      extendedMasterSecret: base.extendedMasterSecret,
      sniCredentials: credentials, rejectHandshake: settings.rejectHandshake,
      earlyData: settings.earlyData, sendBufferSize: settings.bufferSize,
      ocspStaple: base.staple, dhParameters: base.dhParameters,
      ...resumption,
      ...(verifying
        ? {
          requestClientCert: true, clientCertPolicy: 'lenient' as const,
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
    const servers = extractServers(parsed.tree);
    for (const port of new Set(servers.flatMap((server) => server.listen.filter((l) => l.ssl).map((l) => l.port)))) {
      const onPort = servers.filter((server) => server.listen.some((l) => l.port === port && l.ssl));
      const material = this.loadPortTls(onPort, port);
      if (isTlsProblem(material)) return material.error;
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
      if (fresh.fingerprint === previous) continue;
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
    const byName = findServerByName(
      onPort.flatMap((s) => s.serverNames.map((pattern) => ({ pattern, owner: s }))), hostHeader,
    );
    if (byName) return byName;
    return onPort.find((s) => s.listen.some((l) => l.port === port && l.defaultServer)) ?? onPort[0];
  }

  private respond(port: number, req: HttpMessage, peer?: Http1Peer): HttpMessage {
    const [path, args] = splitTarget(req.target ?? '/');
    const hostHeader = req.headers.get('Host') ?? '';
    const server = this.selectServer(port, hostHeader);
    const gated = server ? this.clientCertificateGate(server, hostHeader, peer) : null;
    let outcome: Handled = gated !== null
      ? { response: gated, location: null }
      : server
        ? this.handle(server, path, args, req, peer, port, 0)
        : { response: this.errorResponse(404, notFoundPage()), location: null };
    if (server) {
      outcome = this.withErrorPage(server, outcome, req, peer, port);
      applyGzipFilter(req, outcome.response, (outcome.location ?? server).gzip);
      outcome = this.withRanges(server, outcome, req);
    }
    this.logRequest(server, req, outcome.response, path, peer);
    return outcome.response;
  }

  private clientCertificateGate(server: NginxServerBlock, hostHeader: string, peer?: Http1Peer): HttpMessage | null {
    const tls = peer?.tls;
    if (!tls) return null;
    const host = hostHeader.split(':')[0];
    if (tls.serverName !== null && tls.serverName !== host) {
      if (server.ssl.verifyClient !== 'off') {
        this.host.appendLog(server.errorLog ?? NGINX_ERROR_LOG,
          `${formatErrorTime(this.host.now())} [info] 0#0: *1 client attempted to request the server name different from the one that was negotiated, client: ${peer?.ip ?? '0.0.0.0'}`);
        return this.errorResponse(421, misdirectedPage(), server);
      }
    }
    const settings = server.ssl;
    if (settings.verifyClient === 'off') return null;
    const verifier = this.clientVerifier(server);
    let reason: VerificationReason | null = null;
    if (tls.clientCertificate && verifier) {
      const outcome = verifier.verify(
        tls.clientCertificate, undefined, tls.clientCertificateChain.slice(1), 'clientAuth',
      );
      if (outcome.ok === false) reason = outcome.reason;
    } else if (tls.clientCertificate) {
      reason = 'unknown';
    }
    const verdict = clientCertificateVerdict(settings.verifyClient, tls.clientCertificate !== null, reason);
    if (verdict.outcome === 'pass') return null;
    const failure = reason !== null && tls.clientCertificate
      ? x509VerifyError(reason, tls.clientCertificate, [])
      : null;
    const detail = failure
      ? `client SSL certificate verify error: (${failure.n}:${failure.texte})`
      : 'client sent no required SSL certificate';
    this.host.appendLog(server.errorLog ?? NGINX_ERROR_LOG,
      `${formatErrorTime(this.host.now())} [info] 0#0: *1 ${detail}, client: ${peer?.ip ?? '0.0.0.0'}, server: ${server.serverNames[0] ?? '_'}`);
    return this.errorResponse(
      400, verdict.status === 495 ? sslCertificateErrorPage() : sslNoCertificatePage(), server,
    );
  }

  private clientVerifier(server: NginxServerBlock): CertificateVerifier | null {
    const tls = loadServerTls(server, this.host.fs, this.wireDeps());
    return isTlsProblem(tls) ? null : tls.verifier;
  }

  private handle(
    server: NginxServerBlock, path: string, args: string, req: HttpMessage,
    peer: Http1Peer | undefined, port: number, hops: number,
  ): Handled {
    if (hops >= MAX_URI_CHANGES) return this.redirectCycle(server, path, req, peer);
    const state = this.rewriteState(server, req, path, args);
    const early = this.rewritePhase(server, null, server.rewrites, state, req, peer, port);
    if (early !== null) return early;
    return this.runLocation(server, matchLocation(server, state.uri), state.uri, state.args, req, peer, port, hops);
  }

  private rewriteBucket(server: NginxServerBlock, req: HttpMessage): RewriteBucket {
    let bucket = this.rewriteBuckets.get(req);
    if (bucket === undefined) {
      const vars = new Map<string, string>();
      for (const name of server.declaredVariables) vars.set(name, '');
      bucket = { vars, captures: new Map(), uri: null, args: '' };
      this.rewriteBuckets.set(req, bucket);
    }
    return bucket;
  }

  private rewriteState(server: NginxServerBlock, req: HttpMessage, path: string, args: string): RewriteState {
    const bucket = this.rewriteBucket(server, req);
    bucket.uri = path;
    bucket.args = args;
    return { uri: path, args, uriChanged: false, vars: bucket.vars, captures: bucket.captures };
  }

  private rewritePhase(
    server: NginxServerBlock, location: NginxLocation | null, ops: readonly NginxRewriteOp[], state: RewriteState,
    req: HttpMessage, peer: Http1Peer | undefined, port: number,
  ): Handled | null {
    if (ops.length === 0) return null;
    const bucket = this.rewriteBucket(server, req);
    const env: RewriteEnv = {
      context: (current) => {
        bucket.uri = current.uri;
        bucket.args = current.args;
        bucket.captures = current.captures;
        return this.variablesFor(server, req, port, peer, null, location);
      },
      fileTest: (test, path) => {
        const fs = this.host.fs;
        if (!fs.exists(path)) return false;
        if (test === 'd') return fs.isDirectory(path);
        if (test === 'f') return !fs.isDirectory(path);
        return true;
      },
    };
    const result = runRewriteOps(ops, state, env);
    bucket.uri = state.uri;
    bucket.args = state.args;
    bucket.captures = state.captures;
    if (result.kind === 'return') {
      return { response: this.returnResponse(result.rule, server, location, req, port, peer), location };
    }
    if (result.kind === 'redirect') {
      const res = this.errorResponse(result.status, errorPage(result.status, NGINX_VERSION) ?? '', server, location);
      res.headers.set('Location', this.absolutize(result.location, (location ?? server).redirect, server, req, port, peer));
      return { response: res, location };
    }
    return null;
  }

  private runLocation(
    server: NginxServerBlock, location: NginxLocation | null, path: string, args: string,
    req: HttpMessage, peer: Http1Peer | undefined, port: number, hops: number,
  ): Handled {
    if (location !== null && location.rewrites.length > 0) {
      const state = this.rewriteState(server, req, path, args);
      const early = this.rewritePhase(server, location, location.rewrites, state, req, peer, port);
      if (early !== null) return early;
      if (state.uriChanged) {
        if (hops + 1 >= MAX_URI_CHANGES) return this.redirectCycle(server, state.uri, req, peer, 'processing');
        return this.runLocation(server, matchLocation(server, state.uri), state.uri, state.args, req, peer, port, hops + 1);
      }
      path = state.uri;
      args = state.args;
    }
    if (location?.proxyPass) {
      const target = args === '' ? path : `${path}?${args}`;
      return { response: this.proxy(server, location, location.proxyPass, target, req, peer, port), location };
    }
    const scope = location ?? server;
    let uri = path;
    if (scope.tryFiles) {
      const tried = this.tryFiles(server, scope, location, path, args, req, peer, port);
      if (tried.kind === 'handled') return tried.handled;
      if (tried.kind === 'redirect') {
        return this.internalRedirect(server, tried.uri, req, peer, port, hops);
      }
      uri = tried.uri;
    }
    return { response: this.content(server, location, uri, args, req, peer, port, hops), location };
  }

  private internalRedirect(
    server: NginxServerBlock, target: string, req: HttpMessage,
    peer: Http1Peer | undefined, port: number, hops: number,
  ): Handled {
    if (target.startsWith('@')) {
      const named = server.locations.find((candidate) => candidate.path === target) ?? null;
      return this.runLocation(server, named, (req.target ?? '/').split('?')[0], '', req, peer, port, hops + 1);
    }
    const [path, args] = splitTarget(target);
    return this.handle(server, path, args, req, peer, port, hops + 1);
  }

  private redirectCycle(
    server: NginxServerBlock, path: string, req: HttpMessage, peer: Http1Peer | undefined,
    how: 'redirecting' | 'processing' = 'redirecting',
  ): Handled {
    this.host.appendLog(server.errorLog ?? NGINX_ERROR_LOG,
      `${formatErrorTime(this.host.now())} [error] 0#0: *1 rewrite or internal redirection cycle `
      + `while ${how === 'processing' ? `processing "${path}"` : `internally redirecting to "${path}"`}, client: ${peer?.ip ?? '0.0.0.0'}, `
      + `server: ${server.serverNames[0] ?? '_'}, request: "${req.method ?? 'GET'} ${req.target ?? '/'} HTTP/${req.httpVersion}"`);
    return { response: this.errorResponse(500, errorPage(500, NGINX_VERSION) ?? '', server, null), location: null };
  }

  private tryFiles(
    server: NginxServerBlock, scope: NginxServerBlock | NginxLocation, location: NginxLocation | null,
    path: string, args: string, req: HttpMessage, peer: Http1Peer | undefined, port: number,
  ): { kind: 'serve'; uri: string } | { kind: 'redirect'; uri: string } | { kind: 'handled'; handled: Handled } {
    const plan = scope.tryFiles as NginxTryFiles;
    const root = location?.root ?? server.root;
    const context = { ...this.variablesFor(server, req, port, peer, null), uri: safeDecode(path), args };
    for (const entry of plan.entries) {
      const name = expandNginxVariables(entry.name, context);
      const fsPath = joinPath(root, name);
      const matches = entry.testDir
        ? this.host.fs.isDirectory(fsPath)
        : this.host.fs.exists(fsPath) && !this.host.fs.isDirectory(fsPath);
      if (matches) return { kind: 'serve', uri: name };
    }
    if (plan.fallback.kind === 'code') {
      const code = plan.fallback.code;
      const response = code >= 300
        ? this.errorResponse(code, errorPage(code, NGINX_VERSION) ?? '', server, location)
        : createResponse(code, nginxReason(code));
      return { kind: 'handled', handled: { response, location } };
    }
    return { kind: 'redirect', uri: expandNginxVariables(plan.fallback.uri, context) };
  }

  private content(
    server: NginxServerBlock, location: NginxLocation | null, uri: string, args: string,
    req: HttpMessage, peer: Http1Peer | undefined, port: number, hops: number,
  ): HttpMessage {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return this.errorResponse(405, errorPage(405, NGINX_VERSION) ?? '', server, location);
    }
    const root = location?.root ?? server.root;
    const decoded = safeDecode(uri);

    if (uri.endsWith('/')) {
      const dir = joinPath(root, decoded);
      for (const name of location?.index ?? server.index) {
        const candidate = name.startsWith('/') ? name : `${uri}${name}`;
        const candidatePath = joinPath(root, safeDecode(candidate));
        if (!this.host.fs.exists(candidatePath) || this.host.fs.isDirectory(candidatePath)) continue;
        if (!this.host.fs.readableBy(candidatePath, NGINX_UID, NGINX_GID)) {
          return this.errorResponse(403, forbiddenPage(), server, location);
        }
        return this.internalRedirect(server, args === '' ? candidate : `${candidate}?${args}`, req, peer, port, hops).response;
      }
      if (this.host.fs.isDirectory(dir) && location?.autoindex) {
        return this.autoindex(dir, uri, server, location);
      }
      return this.errorResponse(403, forbiddenPage(), server, location);
    }

    const fsPath = joinPath(root, decoded);
    if (!this.host.fs.exists(fsPath)) return this.errorResponse(404, notFoundPage(), server, location);
    if (this.host.fs.isDirectory(fsPath)) {
      const res = this.errorResponse(301, errorPage(301, NGINX_VERSION) ?? '', server, location);
      const settings = (location ?? server).redirect;
      res.headers.set('Location', this.absolutize(args === '' ? `${uri}/` : `${uri}/?${args}`, settings, server, req, port, peer));
      return res;
    }
    if (!this.host.fs.readableBy(fsPath, NGINX_UID, NGINX_GID)) {
      return this.errorResponse(403, forbiddenPage(), server, location);
    }
    if (method === 'POST') return this.errorResponse(405, errorPage(405, NGINX_VERSION) ?? '', server, location);
    const res = createResponse(200, 'OK');
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    res.headers.set('Content-Type', contentTypeFor((location ?? server).contentTypes, fsPath));
    this.applyHeaders(res, server, location);
    res.body = bytes(this.host.fs.read(fsPath) ?? '');
    return this.conditional(res, req, fsPath, server, location);
  }

  private withRanges(server: NginxServerBlock, outcome: Handled, req: HttpMessage): Handled {
    const original = outcome.response;
    if (!this.rangeable.has(original)) return outcome;
    const total = original.body?.length ?? 0;
    const verdict = applyRangeFilter(req, original, (outcome.location ?? server).conditional.maxRanges, () => ++this.rangeBoundary);
    if (verdict !== 'unsatisfiable') return outcome;
    const refused = this.errorResponse(416, errorPage(416, NGINX_VERSION) ?? '', server, outcome.location);
    refused.headers.set('Content-Range', `bytes */${total}`);
    return { response: refused, location: outcome.location };
  }

  private rewriteUpstreamCookies(res: HttpMessage, location: NginxLocation, variables: NginxVariableContext): void {
    const cookies = res.headers.getAll('Set-Cookie');
    if (cookies.length === 0 || (location.cookies.domains === null && location.cookies.paths === null && location.cookies.flags === null)) return;
    res.headers.delete('Set-Cookie');
    for (const cookie of cookies) res.headers.append('Set-Cookie', rewriteSetCookie(cookie, location.cookies, variables));
  }

  private conditional(
    res: HttpMessage, req: HttpMessage, fsPath: string, server: NginxServerBlock, location: NginxLocation | null,
  ): HttpMessage {
    const stat = this.host.fs.stat(fsPath);
    if (stat === null) return res;
    const settings = (location ?? server).conditional;
    const validators = fileValidators(stat.mtimeMs, res.body?.length ?? stat.size, settings);
    res.headers.set('Last-Modified', httpDate(validators.lastModifiedSeconds));
    if (validators.etag !== null) res.headers.set('ETag', validators.etag);
    this.rangeable.add(res);

    const verdict = evaluateConditional(req, validators, settings);
    if (verdict === 412) return this.errorResponse(412, errorPage(412, NGINX_VERSION) ?? '', server, location);
    if (verdict === 304) {
      res.statusCode = 304;
      res.reasonPhrase = nginxReason(304);
      res.headers.delete('Content-Type');
      res.headers.delete('Content-Length');
      res.body = null;
    }
    return res;
  }

  private autoindex(dir: string, uri: string, server: NginxServerBlock, location: NginxLocation | null): HttpMessage {
    const entries = this.host.fs.list(dir) ?? [];
    const listing = `<html><head><title>Index of ${uri}</title></head><body>\r\n<h1>Index of ${uri}</h1><hr><pre><a href="../">../</a>\r\n${entries.sort().map((e) => `<a href="${e}">${e}</a>`).join('\r\n')}\r\n</pre><hr></body>\r\n</html>\r\n`;
    const res = createResponse(200, 'OK');
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    res.headers.set('Content-Type', 'text/html');
    this.applyHeaders(res, server, location);
    res.body = bytes(listing);
    return res;
  }

  private withErrorPage(
    server: NginxServerBlock, outcome: Handled, req: HttpMessage,
    peer: Http1Peer | undefined, port: number,
  ): Handled {
    const original = outcome.response;
    if (!this.generated.has(original)) return outcome;
    const rule = findErrorPage((outcome.location ?? server).errorPages, original.statusCode ?? 0);
    if (rule === undefined) return outcome;

    const context = this.variablesFor(server, req, port, peer, null);
    const target = expandNginxVariables(rule.target, context);
    const redirected = { ...req, method: req.method === 'HEAD' ? 'HEAD' : 'GET' } as HttpMessage;
    if (target.startsWith('/') || target.startsWith('@')) {
      const inner = this.internalRedirect(server, target, redirected, peer, port, 0);
      if (this.generated.has(inner.response)) return inner;
      const final = rule.overwrite === KEEP_STATUS ? (original.statusCode ?? 200) : rule.overwrite;
      if (final !== REPLACEMENT_STATUS) {
        inner.response.statusCode = final;
        inner.response.reasonPhrase = nginxReason(final);
      }
      return inner;
    }
    const status = rule.overwrite >= 300 && rule.overwrite < 400 ? rule.overwrite : 302;
    const res = this.errorResponse(status, errorPage(status, NGINX_VERSION) ?? '', server, outcome.location);
    res.headers.set('Location', target);
    return { response: res, location: outcome.location };
  }

  private returnResponse(
    rule: NginxReturnRule, server: NginxServerBlock, location: NginxLocation | null,
    req: HttpMessage, port: number, peer?: Http1Peer,
  ): HttpMessage {
    const text = rule.text === null
      ? null
      : expandNginxVariables(rule.text, this.variablesFor(server, req, port, peer, null));
    if (isRedirectStatus(rule.status)) {
      const res = this.errorResponse(rule.status, errorPage(rule.status, NGINX_VERSION) ?? '', server, location);
      res.headers.set('Location', this.absolutize(text ?? '', (location ?? server).redirect, server, req, port, peer));
      return res;
    }
    if (rule.status >= 400 && (text === null || text === '')) {
      return this.errorResponse(rule.status, errorPage(rule.status, NGINX_VERSION) ?? '', server, location);
    }
    const res = createResponse(rule.status, nginxReason(rule.status));
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    res.headers.set('Content-Type', contentTypeFor((location ?? server).contentTypes, (req.target ?? '/').split('?')[0]));
    this.applyHeaders(res, server, location);
    res.body = bytes(text ?? '');
    return res;
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
    pass: NginxProxyPass, target: string, req: HttpMessage, peer?: Http1Peer, port = 0,
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

    const target502 = this.resolveUpstream(pass, peer?.ip);
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
      const resolved = expandNginxVariables(value, this.variablesFor(server, req, port, peer, target502));
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
      // C'est ICI que la détection passive se nourrit : l'échec est
      // constaté sur du trafic réel, pas sur une sonde.
      if (target502.groupe) {
        this.noterEchec(target502.groupe, target502.host, target502.port);
      }
      return this.badGateway(server, location, upstreamFailure(sent), peer, sent.failure === 'timeout' ? 504 : 502);
    }
    const res = sent.response;
    for (const hop of HOP_BY_HOP) res.headers.delete(hop);
    this.rewriteUpstreamRedirects(res, server, location, pass, req, port, peer, target502);
    this.rewriteUpstreamCookies(res, location, this.variablesFor(server, req, port, peer, target502));
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    this.applyHeaders(res, server, location);
    return res;
  }

  private variablesFor(
    server: NginxServerBlock, req: HttpMessage, port: number, peer: Http1Peer | undefined,
    upstream: { host: string; port: number } | null, location: NginxLocation | null = null,
  ): NginxVariableContext {
    const bucket = this.rewriteBuckets.get(req);
    return {
      request: req, clientIp: peer?.ip ?? '0.0.0.0', secure: peer?.tls !== undefined,
      serverName: server.serverNames[0] ?? '', serverPort: port, upstream,
      root: location?.root ?? server.root,
      ...(bucket === undefined ? {} : {
        variables: bucket.vars, captures: bucket.captures,
        ...(bucket.uri === null ? {} : { uri: bucket.uri, args: bucket.args }),
      }),
    };
  }

  private absolutize(
    value: string, settings: NginxRedirectSettings, server: NginxServerBlock,
    req: HttpMessage, port: number, peer?: Http1Peer,
  ): string {
    return absoluteLocationValue(value, settings, {
      hostHeader: req.headers.get('Host') ?? '', serverName: server.serverNames[0] ?? '',
      port, secure: peer?.tls !== undefined,
    });
  }

  private rewriteUpstreamRedirects(
    res: HttpMessage, server: NginxServerBlock, location: NginxLocation, pass: NginxProxyPass,
    req: HttpMessage, port: number, peer: Http1Peer | undefined, upstream: { host: string; port: number },
  ): void {
    const settings = location.redirect;
    if (settings.policy === 'off') return;
    const context = {
      passUrl: pass.url, passHasUri: pass.path !== undefined && pass.path.length > 0,
      locationPath: location.path, variables: this.variablesFor(server, req, port, peer, upstream),
    };
    const redirect = res.headers.get('Location');
    if (redirect !== undefined) {
      const rewritten = rewriteRedirectValue(redirect, 0, settings.policy, context);
      if (rewritten !== null) {
        res.headers.set('Location', this.absolutize(rewritten, settings, server, req, port, peer));
      }
    }
    const refresh = res.headers.get('Refresh');
    const urlAt = refresh === undefined ? -1 : refresh.toLowerCase().indexOf('url=');
    if (refresh !== undefined && urlAt >= 0) {
      const rewritten = rewriteRedirectValue(refresh, urlAt + 4, settings.policy, context);
      if (rewritten !== null) res.headers.set('Refresh', rewritten);
    }
  }

  /**
   * `proxy_pass http://amont;` désigne soit un bloc `upstream`, soit un
   * hôte. L'`upstream` est consulté EN PREMIER, comme chez nginx : un
   * bloc de ce nom masque un hôte qui s'appellerait pareil.
   */
  private resolveUpstream(
    pass: NginxProxyPass, client?: string,
  ): { ip: string; host: string; port: number; groupe?: string } | null {
    const group = this.upstreams.find((u) => u.name === pass.host);
    if (group) {
      const membre = this.choisirMembre(group, client);
      if (!membre) return null;
      const ip = this.resolveHost(membre.host);
      return ip
        ? { ip, host: membre.host, port: membre.port, groupe: group.name }
        : null;
    }
    const ip = this.resolveHost(pass.host);
    return ip ? { ip, host: pass.host, port: pass.port } : null;
  }

  private cle(m: NginxUpstreamServer): string { return `${m.host}:${m.port}`; }

  private etat(groupe: string) {
    let e = this.balance.get(groupe);
    if (!e) { e = { curseur: 0, echecs: new Map() }; this.balance.set(groupe, e); }
    return e;
  }

  /**
   * Un membre est « hors service » tant que sa fenêtre de pénalité
   * court. La fenêtre est celle de `fail_timeout`, et elle sert DEUX
   * fois chez nginx — durée pendant laquelle les échecs se comptent, et
   * durée de mise à l'écart — ce qui est reproduit ici.
   */
  private disponible(groupe: string, m: NginxUpstreamServer, maintenant: number): boolean {
    if (m.down) return false;
    if (m.maxFails === 0) return true;
    const e = this.etat(groupe).echecs.get(this.cle(m));
    if (!e) return true;
    if (maintenant - e.depuis >= m.failTimeoutMs) {
      this.etat(groupe).echecs.delete(this.cle(m));
      return true;
    }
    return e.compte < m.maxFails;
  }

  /**
   * Le tour de rôle pondéré, et le repli sur les `backup`.
   *
   * `weight=3` prend trois tours sur le cycle : la liste est développée
   * plutôt que d'être parcourue avec un compteur, parce que le résultat
   * est alors lisible à l'œil dans un test — et un équilibrage qu'on ne
   * peut pas observer est indiscernable d'un décor.
   */
  private choisirMembre(
    groupe: NginxUpstream, client?: string,
  ): NginxUpstreamServer | null {
    const maintenant = this.host.now().getTime();
    const vivants = (backup: boolean): NginxUpstreamServer[] => {
      const out: NginxUpstreamServer[] = [];
      for (const m of groupe.servers) {
        if (m.backup !== backup) continue;
        if (!this.disponible(groupe.name, m, maintenant)) continue;
        for (let i = 0; i < m.weight; i++) out.push(m);
      }
      return out;
    };
    // Les `backup` ne servent QUE si tous les autres sont hors service :
    // c'est ce que le mot veut dire, et un repli qui prendrait sa part
    // du trafic ordinaire ne serait pas un repli.
    const cycle = vivants(false).length > 0 ? vivants(false) : vivants(true);
    if (cycle.length === 0) return null;

    if (groupe.method === 'ip_hash' && client) {
      // La même adresse doit retomber sur le même membre — c'est le seul
      // usage de cette méthode, et il se vérifie.
      let h = 0;
      for (const octet of client.split('.')) h = (h * 31 + Number(octet)) >>> 0;
      return cycle[h % cycle.length];
    }
    const e = this.etat(groupe.name);
    const choisi = cycle[e.curseur % cycle.length];
    e.curseur = (e.curseur + 1) % cycle.length;
    return choisi;
  }

  /**
   * La détection PASSIVE de panne : nginx n'interroge pas ses amonts, il
   * retient ceux qui viennent de le décevoir en servant du trafic réel.
   * Sans cela, `max_fails` serait une valeur stockée et lue par
   * personne — et un groupe dont un membre est mort renverrait un `502`
   * une requête sur deux, indéfiniment.
   */
  private noterEchec(groupe: string, hote: string, port: number): void {
    const e = this.etat(groupe);
    const cle = `${hote}:${port}`;
    const maintenant = this.host.now().getTime();
    const vu = e.echecs.get(cle);
    if (vu && maintenant - vu.depuis < 60_000) vu.compte++;
    else e.echecs.set(cle, { compte: 1, depuis: maintenant });
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
    peer?: Http1Peer, status: 502 | 504 = 502,
  ): HttpMessage {
    this.host.appendLog(server.errorLog ?? NGINX_ERROR_LOG,
      `${formatErrorTime(this.host.now())} [error] 0#0: *1 ${reason}, `
      + `client: ${peer?.ip ?? '0.0.0.0'}, server: ${server.serverNames[0] ?? '_'}`);
    return this.errorResponse(status, status === 504 ? (errorPage(504, NGINX_VERSION) ?? '') : badGatewayPage(), server, location);
  }

  private applyHeaders(res: HttpMessage, server?: NginxServerBlock, location?: NginxLocation | null): void {
    for (const [k, v] of server?.addHeaders ?? []) res.headers.set(k, v);
    for (const [k, v] of location?.addHeaders ?? []) res.headers.set(k, v);
  }

  private errorResponse(
    status: number, body: string,
    server?: NginxServerBlock, location?: NginxLocation | null,
  ): HttpMessage {
    const res = createResponse(status, nginxReason(status));
    res.headers.set('Server', `nginx/${NGINX_VERSION}`);
    res.headers.set('Content-Type', 'text/html');
    this.applyHeaders(res, server, location);
    res.body = bytes(body);
    this.generated.add(res);
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

function upstreamFailure(
  sent: { readonly error?: string; readonly failure?: 'refused' | 'timeout' | 'unreachable' | 'prohibited' },
): string {
  if (sent.failure === undefined) return sent.error ?? 'no response from upstream';
  const phrase = {
    refused: 'connect() failed (111: Connection refused)',
    prohibited: 'connect() failed (111: Connection refused)',
    unreachable: 'connect() failed (113: No route to host)',
    timeout: 'upstream timed out (110: Connection timed out)',
  }[sent.failure];
  return `${phrase} while connecting to upstream`;
}

interface RewriteBucket {
  readonly vars: Map<string, string>;
  captures: Map<string, string>;
  uri: string | null;
  args: string;
}
