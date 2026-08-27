import { Http1ClientSession } from '../http1/Http1ClientSession';
import { HttpsClientSession } from '../https/HttpsClientSession';
import {
  CertificateVerifier,
  certificateMatchesHostname,
  type VerificationResult,
} from '@/network/pki/CertificateVerifier';
import { pemToCertChain } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { createRequest, type HttpMessage, type HttpMethod } from '../semantics/types';
import { encodeBasicCredentials } from '../auth/BasicAuth';
import type { CookieJar } from '../cookies/CookieJar';
import { serializeCookieHeader } from '../cookies/SetCookie';
import { jarFromArgument, serializeNetscapeCookies } from './CurlCookies';
import { buildMultipart } from './CurlForm';
import { isKnownMethod } from '../semantics/methods';
import type { CurlOptions } from './CurlArgs';
import type { CurlHost } from './CurlHost';

export interface CurlUrl {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly effective: string;
}

export interface CurlHeaderPair { readonly name: string; readonly value: string }

export interface CurlSuccess {
  readonly ok: true;
  readonly url: CurlUrl;
  readonly remoteIp: string;
  readonly statusCode: number;
  readonly reasonPhrase: string;
  readonly httpVersion: string;
  readonly headers: readonly CurlHeaderPair[];
  readonly body: string;
  readonly method: string;
  readonly numRedirects: number;
  readonly trace: readonly string[];
}

export interface CurlFailure {
  readonly ok: false;
  readonly code: number;
  readonly message: string;
  readonly url: CurlUrl | null;
  readonly remoteIp: string;
  readonly method: string;
  readonly numRedirects: number;
  readonly trace: readonly string[];
}

export type CurlOutcome = CurlSuccess | CurlFailure;

class InsecureCertificateVerifier extends CertificateVerifier {
  verify(): VerificationResult {
    return { ok: true };
  }
}

const URL_RE = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/?#:]+)(?::(\d+))?([/?#].*)?$/;

export type UrlParse =
  | { ok: true; url: CurlUrl }
  | { ok: false; code: number; message: string };

export function parseCurlUrl(raw: string): UrlParse {
  const m = URL_RE.exec(raw);
  if (!m) return { ok: false, code: 3, message: 'curl: (3) URL using bad/illegal format or missing URL' };
  const scheme = (m[1] ?? 'http').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, code: 1, message: `curl: (1) Protocol "${scheme}" not supported or disabled in libcurl` };
  }
  const host = m[2];
  const port = m[3] ? parseInt(m[3], 10) : scheme === 'https' ? 443 : 80;
  const path = m[4] || '/';
  const authority = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
    ? host
    : `${host}:${port}`;
  return { ok: true, url: { scheme, host, port, path, effective: `${scheme}://${authority}${path}` } };
}

function headerPairs(message: HttpMessage): CurlHeaderPair[] {
  return message.headers.entries().map(([name, value]) => ({ name, value }));
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function resolvedOverride(opts: CurlOptions, url: CurlUrl): string | null {
  const entry = opts.resolve.find((r) => r.host === url.host && r.port === url.port);
  return entry ? entry.address : null;
}

function applyCustomHeaders(request: HttpMessage, specs: readonly string[]): void {
  for (const spec of specs) {
    const colon = spec.indexOf(':');
    if (colon === -1) {
      if (spec.endsWith(';')) request.headers.set(spec.slice(0, -1).trim(), '');
      continue;
    }
    const name = spec.slice(0, colon).trim();
    const value = spec.slice(colon + 1).trim();
    if (!name) continue;
    if (value === '') request.headers.delete(name);
    else request.headers.set(name, value);
  }
}

function bodyFor(opts: CurlOptions, host: CurlHost): string | null {
  if (opts.uploadFile !== null) return host.readFile(opts.uploadFile);
  if (opts.data.length === 0) return null;
  return opts.data.join('&');
}

function methodFor(opts: CurlOptions): string {
  if (opts.method) return opts.method;
  if (opts.head) return 'HEAD';
  if (opts.form.length > 0) return 'POST';
  // `-T` fait un PUT, pas un POST : c'est un TÉLÉVERSEMENT, et le
  // confondre changerait la sémantique côté serveur.
  if (opts.uploadFile !== null) return 'PUT';
  if (opts.data.length > 0) return 'POST';
  return 'GET';
}

function buildRequest(
  url: CurlUrl, method: string, opts: CurlOptions, body: string | null,
  jar?: CookieJar, formContentType?: string,
): HttpMessage {
  const verb: HttpMethod = isKnownMethod(method) ? method : 'GET';
  const request = createRequest(verb, url.path);
  const authority = (url.scheme === 'https' && url.port === 443) || (url.scheme === 'http' && url.port === 80)
    ? url.host
    : `${url.host}:${url.port}`;
  request.headers.set('Host', authority);
  request.headers.set('User-Agent', opts.userAgent);
  request.headers.set('Accept', '*/*');
  if (opts.referer !== null) request.headers.set('Referer', opts.referer);
  if (opts.user) {
    const colon = opts.user.indexOf(':');
    const name = colon === -1 ? opts.user : opts.user.slice(0, colon);
    const secret = colon === -1 ? '' : opts.user.slice(colon + 1);
    request.headers.set('Authorization', encodeBasicCredentials(name, secret));
  }
  if (body !== null) {
    // Un téléversement n'est pas un formulaire : curl n'impose alors
    // aucun type et laisse le serveur décider. Un `-F`, lui, porte sa
    // frontière dans le type, sans quoi le serveur ne saurait pas où
    // coupent les parties.
    if (formContentType) request.headers.set('Content-Type', formContentType);
    else if (opts.uploadFile === null) {
      request.headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }
    request.body = binaryStringToBytes(body);
  }
  if (jar) {
    // Le bocal décide seul de ce qui part : domaine, chemin, `Secure`.
    // C'est ce filtrage qui rend l'option utile — envoyer tout le bocal
    // à tout le monde serait une chaîne d'en-tête, pas un témoin.
    const envoyes = jar.cookiesFor(url.host, url.path.split('?')[0], {
      secure: url.scheme === 'https',
    });
    if (envoyes.length > 0) request.headers.set('Cookie', serializeCookieHeader(envoyes));
  }
  applyCustomHeaders(request, opts.headers);
  return request;
}

function traceRequest(trace: string[], request: HttpMessage, url: CurlUrl): void {
  trace.push(`> ${request.method} ${url.path} HTTP/1.1`);
  for (const [name, value] of request.headers.entries()) trace.push(`> ${name}: ${value}`);
  trace.push('> ');
}

function traceResponse(trace: string[], response: HttpMessage): void {
  trace.push(`< HTTP/${response.httpVersion} ${response.statusCode} ${response.reasonPhrase ?? ''}`.trimEnd());
  for (const [name, value] of response.headers.entries()) trace.push(`< ${name}: ${value}`);
  trace.push('< ');
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectMethod(status: number, method: string): string {
  if (status === 307 || status === 308) return method;
  if (method === 'HEAD') return 'HEAD';
  return 'GET';
}

function resolveLocation(base: CurlUrl, location: string): UrlParse {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(location)) return parseCurlUrl(location);
  if (location.startsWith('/')) {
    const authority = (base.scheme === 'https' && base.port === 443) || (base.scheme === 'http' && base.port === 80)
      ? base.host
      : `${base.host}:${base.port}`;
    return parseCurlUrl(`${base.scheme}://${authority}${location}`);
  }
  const dir = base.path.slice(0, base.path.lastIndexOf('/') + 1);
  const authority = (base.scheme === 'https' && base.port === 443) || (base.scheme === 'http' && base.port === 80)
    ? base.host
    : `${base.host}:${base.port}`;
  return parseCurlUrl(`${base.scheme}://${authority}${dir}${location}`);
}

class CurlConnectRefused extends Error {}

export async function performCurlRequest(
  host: CurlHost,
  first: CurlUrl,
  opts: CurlOptions,
): Promise<CurlOutcome> {
  const trace: string[] = [];
  const body = bodyFor(opts, host);
  // `-T` sur un fichier absent est une erreur AVANT toute connexion :
  // curl ne va pas ouvrir une socket pour découvrir qu'il n'a rien à
  // envoyer.
  if (opts.uploadFile !== null && body === null) {
    return {
      ok: false, code: 26,
      message: `curl: (26) Failed to open/read local data from file/application`,
      url: first, remoteIp: '', method: 'PUT', numRedirects: 0, trace: [],
    };
  }
  // Le corps multipart est construit AVANT toute connexion : un
  // fichier de partie absent doit échouer comme `-T`, sans ouvrir de
  // socket pour rien.
  let formContentType: string | undefined;
  let corpsForm: string | null = null;
  if (opts.form.length > 0) {
    const forme = buildMultipart(opts.form, (p) => host.readFile(p));
    if (forme.ok === false) {
      return {
        ok: false, code: forme.code, message: forme.message,
        url: first, remoteIp: '', method: 'POST', numRedirects: 0, trace: [],
      };
    }
    formContentType = forme.contentType;
    corpsForm = forme.body;
  }
  let url = first;
  let method = methodFor(opts);
  let sendBody = body !== null || opts.form.length > 0;
  let redirects = 0;
  let remoteIp = '';
  // Le bocal vit pour tout le transfert, redirections comprises — et
  // c'est là qu'il sert vraiment : une session s'ouvre par un `302` qui
  // pose le témoin, et la requête suivante doit le porter.
  const jar = jarFromArgument(opts.cookie, first.host, (p) => host.readFile(p));

  // `--cacert` REPLACES the machine's trust store, it does not add to it.
  // That is the whole reason a lab uses it: the operator's own root has to
  // be the only thing that can vouch for the server, otherwise passing the
  // wrong bundle would still succeed through the system anchors and the
  // option would prove nothing. Resolved once, before any connection, so a
  // path that does not exist fails the way real curl fails it — before the
  // handshake, not after.
  let anchors: readonly X509Certificate[] = host.trustAnchors();
  if (opts.caCert !== null) {
    const pem = host.readFile(opts.caCert);
    if (pem === null) {
      return {
        ok: false, code: 77,
        message: `curl: (77) error setting certificate file: ${opts.caCert}`,
        url: null, remoteIp, method, numRedirects: redirects, trace,
      };
    }
    anchors = pemToCertChain(pem);
  }

  for (;;) {
    const override = resolvedOverride(opts, url);
    let address = override;
    if (!address) {
      const resolved = await host.resolveHostname(url.host);
      if (!resolved) {
        return {
          ok: false, code: 6, message: `curl: (6) Could not resolve host: ${url.host}`,
          url, remoteIp, method, numRedirects: redirects, trace,
        };
      }
      address = resolved;
    }
    remoteIp = address;
    trace.push(`*   Trying ${address}:${url.port}...`);

    const request = buildRequest(
      url, method, opts, sendBody ? (corpsForm ?? body) : null, jar, formContentType);

    let response: HttpMessage | null = null;
    let failure: CurlFailure | null = null;

    if (url.scheme === 'https') {
      const verifier = opts.insecure
        ? new InsecureCertificateVerifier({ trustAnchors: [] })
        : new CertificateVerifier({ trustAnchors: anchors });
      const porte = host.tcpStack().connect(address, url.port);
      const refuse = !porte || porte.state !== 'established';
      porte?.close();
      if (refuse) {
        failure = {
          ok: false, code: 7,
          message: `curl: (7) Failed to connect to ${url.host} port ${url.port}: Connection refused`,
          url, remoteIp, method, numRedirects: redirects, trace,
        };
      }

      let session: HttpsClientSession | null = null;
      try {
        if (refuse) throw new CurlConnectRefused();
        session = new HttpsClientSession(host.tcpStack(), address, url.port, { verifier });
        const result = await session.sendAsync(request);
        if (!result.ok || !result.response) {
          if (!opts.insecure) {
            failure = {
              ok: false, code: 60,
              message: 'curl: (60) SSL certificate problem: unable to get local issuer certificate',
              url, remoteIp, method, numRedirects: redirects, trace,
            };
          } else {
            failure = {
              ok: false, code: 35,
              message: `curl: (35) OpenSSL SSL_connect: SSL routines::wrong version number in connection to ${url.host}:${url.port}`,
              url, remoteIp, method, numRedirects: redirects, trace,
            };
          }
        } else {
          const peer = session.peerCertificate;
          if (peer && !opts.insecure && !certificateMatchesHostname(peer, url.host)) {
            failure = {
              ok: false, code: 60,
              message: `curl: (60) SSL: no alternative certificate subject name matches target host name '${url.host}'`,
              url, remoteIp, method, numRedirects: redirects, trace,
            };
          } else {
            trace.push(`* Connected to ${url.host} (${address}) port ${url.port}`);
            trace.push('* SSL connection using TLSv1.3');
            if (peer) {
              trace.push('* Server certificate:');
              trace.push(`*  subject: ${peer.subject}`);
              trace.push(`*  issuer: ${peer.issuer}`);
            }
            response = result.response;
          }
        }
      } catch (error) {
        if (!(error instanceof CurlConnectRefused)) {
          failure = {
            ok: false, code: 35,
            message: `curl: (35) OpenSSL SSL_connect: SSL routines::wrong version number in connection to ${url.host}:${url.port}`,
            url, remoteIp, method, numRedirects: redirects, trace,
          };
        }
      } finally {
        session?.close();
      }
    } else {
      const session = new Http1ClientSession(host.tcpStack(), address, url.port);
      // `sendAsync` et non `send` : un serveur qui doit authentifier par
      // AAA répond après un aller-retour, et le contrat synchrone rendait
      // sa réponse invisible. Un serveur synchrone répond au premier tour,
      // donc rien ne change pour nginx, Apache ou IIS.
      const result = await session.sendAsync(request);
      session.close();
      if (!result.ok || !result.response) {
        const empty = result.error === 'Empty reply from server';
        failure = {
          ok: false,
          code: empty ? 52 : 7,
          message: empty
            ? 'curl: (52) Empty reply from server'
            : `curl: (7) Failed to connect to ${url.host} port ${url.port}: Connection refused`,
          url, remoteIp, method, numRedirects: redirects, trace,
        };
      } else {
        trace.push(`* Connected to ${url.host} (${address}) port ${url.port}`);
        response = result.response;
      }
    }

    if (failure) return failure;
    if (!response) {
      return {
        ok: false, code: 52, message: 'curl: (52) Empty reply from server',
        url, remoteIp, method, numRedirects: redirects, trace,
      };
    }

    traceRequest(trace, request, url);
    traceResponse(trace, response);

    // Récolté AVANT de décider d'une redirection : un `302` qui pose un
    // témoin de session est le cas d'usage même de cette option, et
    // attendre la réponse finale le perdrait.
    for (const [nom, valeur] of response.headers.entries()) {
      if (nom.toLowerCase() === 'set-cookie') {
        jar.setFromHeader(valeur, url.host, url.path.split('?')[0]);
      }
    }

    const status = response.statusCode ?? 0;
    const location = response.headers.get('Location');
    if (opts.location && isRedirect(status) && location) {
      if (redirects >= opts.maxRedirs) {
        return {
          ok: false, code: 47,
          message: `curl: (47) Maximum (${opts.maxRedirs}) redirects followed`,
          url, remoteIp, method, numRedirects: redirects, trace,
        };
      }
      const next = resolveLocation(url, location);
      if (next.ok === false) {
        return {
          ok: false, code: next.code, message: next.message,
          url, remoteIp, method, numRedirects: redirects, trace,
        };
      }
      trace.push(`* Issue another request to this URL: '${next.url.effective}'`);
      const redirected = redirectMethod(status, method);
      if (redirected !== method) sendBody = false;
      method = redirected;
      url = next.url;
      redirects++;
      continue;
    }

    trace.push(`* Connection #0 to host ${url.host} left intact`);
    // `-c` écrit le bocal à la FIN du transfert, comme curl : ce qu'il
    // garde est l'état après la dernière réponse, redirections
    // comprises.
    if (opts.cookieJar !== null) {
      host.writeFile(opts.cookieJar, serializeNetscapeCookies(jar.entries()));
    }
    return {
      ok: true,
      url,
      remoteIp,
      statusCode: status,
      reasonPhrase: response.reasonPhrase ?? '',
      httpVersion: response.httpVersion,
      headers: headerPairs(response),
      body: response.body ? bytesToBinaryString(response.body) : '',
      method,
      numRedirects: redirects,
      trace,
    };
  }
}
