export type SameSite = 'Strict' | 'Lax' | 'None';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  hostOnly: boolean;
}

// RFC 6265 §5.1.4 — the default-path when no Path attribute is given.
export function defaultPath(requestPath: string): string {
  if (!requestPath || requestPath[0] !== '/') return '/';
  const lastSlash = requestPath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return requestPath.slice(0, lastSlash);
}

// RFC 6265 §5.2 — parses a single Set-Cookie header value.
export function parseSetCookie(header: string, requestHost: string, requestPath: string): Cookie | null {
  const parts = header.split(';').map((s) => s.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();

  let domain = '';
  let hostOnly = true;
  let path: string | undefined;
  let expires: number | undefined;
  let maxAge: number | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = 'Lax';

  for (const attr of attrs) {
    const eqIdx = attr.indexOf('=');
    const attrName = (eqIdx === -1 ? attr : attr.slice(0, eqIdx)).trim().toLowerCase();
    const attrValue = eqIdx === -1 ? '' : attr.slice(eqIdx + 1).trim();
    switch (attrName) {
      case 'domain':
        if (attrValue) {
          domain = attrValue.toLowerCase().replace(/^\./, '');
          hostOnly = false;
        }
        break;
      case 'path':
        if (attrValue.startsWith('/')) path = attrValue;
        break;
      case 'expires': {
        const d = new Date(attrValue);
        if (!isNaN(d.getTime())) expires = d.getTime();
        break;
      }
      case 'max-age': {
        const n = parseInt(attrValue, 10);
        if (!isNaN(n)) maxAge = n;
        break;
      }
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite': {
        const v = attrValue.toLowerCase();
        if (v === 'strict') sameSite = 'Strict';
        else if (v === 'none') sameSite = 'None';
        else sameSite = 'Lax';
        break;
      }
      default:
        break;
    }
  }

  if (!domain) domain = requestHost.toLowerCase();
  return { name, value, domain, path: path ?? defaultPath(requestPath), expires, maxAge, secure, httpOnly, sameSite, hostOnly };
}

export function serializeCookieHeader(cookies: Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
