import { parseSetCookie, type Cookie } from './SetCookie';

export type SiteContext = 'same-site' | 'cross-site';

interface StoredCookie {
  cookie: Cookie;
  expiryMs: number | null;
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

// RFC 6265 §5.1.3 — domain-match(request-host, cookie-domain).
export function domainMatch(requestHost: string, cookieDomain: string): boolean {
  const host = requestHost.toLowerCase();
  const domain = cookieDomain.toLowerCase();
  if (host === domain) return true;
  if (isIpAddress(host)) return false;
  return host.endsWith(`.${domain}`);
}

// RFC 6265 §5.1.4 — path-match(request-path, cookie-path).
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith('/')) return true;
    if (requestPath[cookiePath.length] === '/') return true;
  }
  return false;
}

export interface CookieRequestOptions {
  secure?: boolean;
  siteContext?: SiteContext;
}

/** A per-agent cookie store, as a real browser or `curl -c/-b` would keep. */
export class CookieJar {
  private store: StoredCookie[] = [];

  private removeMatching(name: string, domain: string, path: string): void {
    this.store = this.store.filter((e) => !(e.cookie.name === name && e.cookie.domain === domain && e.cookie.path === path));
  }

  private isLive(entry: StoredCookie, now: number): boolean {
    return entry.expiryMs === null || entry.expiryMs > now;
  }

  /**
   * RFC 6265 §5.3 — sets one cookie from a `Set-Cookie` header value.
   * A `Domain` attribute that does not domain-match the setting host is
   * rejected outright (step 6). Max-Age has precedence over Expires; an
   * already-past effective expiry deletes any matching stored cookie.
   */
  setFromHeader(header: string, requestHost: string, requestPath: string, now = Date.now()): boolean {
    const cookie = parseSetCookie(header, requestHost, requestPath);
    if (!cookie) return false;
    if (!cookie.hostOnly && !domainMatch(requestHost, cookie.domain)) return false;

    const expiryMs = cookie.maxAge !== undefined ? now + cookie.maxAge * 1000 : cookie.expires ?? null;
    this.removeMatching(cookie.name, cookie.domain, cookie.path);
    if (expiryMs !== null && expiryMs <= now) return true;

    this.store.push({ cookie, expiryMs });
    return true;
  }

  /**
   * Selects the cookies a request to `requestHost`/`requestPath` should
   * carry: live (not expired), domain- and path-matching, `Secure`-gated,
   * and `SameSite` filtered by the declared site context (a simplified
   * same-site/cross-site model, not a full browser-grade origin engine —
   * cf. PRD-HTTP.md §2.2).
   */
  cookiesFor(requestHost: string, requestPath: string, opts: CookieRequestOptions = {}, now = Date.now()): Cookie[] {
    const secure = opts.secure ?? false;
    const siteContext = opts.siteContext ?? 'same-site';
    return this.store
      .filter((e) => this.isLive(e, now))
      .filter((e) => (e.cookie.hostOnly ? requestHost.toLowerCase() === e.cookie.domain : domainMatch(requestHost, e.cookie.domain)))
      .filter((e) => pathMatch(requestPath, e.cookie.path))
      .filter((e) => !e.cookie.secure || secure)
      .filter((e) => e.cookie.sameSite === 'None' || siteContext === 'same-site')
      .map((e) => e.cookie);
  }

  all(now = Date.now()): Cookie[] {
    return this.store.filter((e) => this.isLive(e, now)).map((e) => e.cookie);
  }

  clear(): void {
    this.store = [];
  }
}
