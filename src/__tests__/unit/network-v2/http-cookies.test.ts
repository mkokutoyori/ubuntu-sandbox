/**
 * PRD-HTTP.md §5 P4 — Cookies (RFC 6265): Set-Cookie/Cookie parsing and
 * serialization, per-agent CookieJar with domain/path matching (§5.1.3/
 * §5.1.4), hostOnly semantics, expiration, and Secure/SameSite gating.
 */
import { describe, it, expect } from 'vitest';
import { parseSetCookie, serializeCookieHeader, defaultPath } from '@/network/http/cookies/SetCookie';
import { CookieJar, domainMatch, pathMatch } from '@/network/http/cookies/CookieJar';

describe('defaultPath (RFC 6265 §5.1.4)', () => {
  it('drops the last path segment', () => {
    expect(defaultPath('/a/b/c')).toBe('/a/b');
  });

  it('is "/" when the request path has no further segments', () => {
    expect(defaultPath('/a')).toBe('/');
    expect(defaultPath('/')).toBe('/');
    expect(defaultPath('')).toBe('/');
  });
});

describe('parseSetCookie (RFC 6265 §5.2)', () => {
  it('parses name=value with no attributes, defaulting domain/path/hostOnly', () => {
    const cookie = parseSetCookie('sid=abc123', 'example.com', '/app/page');
    expect(cookie).toEqual({
      name: 'sid', value: 'abc123', domain: 'example.com', path: '/app',
      expires: undefined, maxAge: undefined, secure: false, httpOnly: false,
      sameSite: 'Lax', hostOnly: true,
    });
  });

  it('parses Domain (making the cookie non-hostOnly, lowercased, leading dot stripped)', () => {
    const cookie = parseSetCookie('sid=abc; Domain=.Example.com', 'www.example.com', '/');
    expect(cookie!.domain).toBe('example.com');
    expect(cookie!.hostOnly).toBe(false);
  });

  it('parses Path, Secure, HttpOnly, SameSite', () => {
    const cookie = parseSetCookie('sid=abc; Path=/api; Secure; HttpOnly; SameSite=Strict', 'example.com', '/');
    expect(cookie!.path).toBe('/api');
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Strict');
  });

  it('parses Expires as an absolute timestamp', () => {
    const cookie = parseSetCookie('sid=abc; Expires=Wed, 01 Jan 2030 00:00:00 GMT', 'example.com', '/');
    expect(cookie!.expires).toBe(new Date('2030-01-01T00:00:00Z').getTime());
  });

  it('parses Max-Age as a number of seconds', () => {
    const cookie = parseSetCookie('sid=abc; Max-Age=3600', 'example.com', '/');
    expect(cookie!.maxAge).toBe(3600);
  });

  it('rejects a header with no "=" in the name-value pair', () => {
    expect(parseSetCookie('garbage', 'example.com', '/')).toBeNull();
  });
});

describe('serializeCookieHeader', () => {
  it('joins name=value pairs with "; "', () => {
    const header = serializeCookieHeader([
      { name: 'a', value: '1', domain: 'x', path: '/', secure: false, httpOnly: false, sameSite: 'Lax', hostOnly: true },
      { name: 'b', value: '2', domain: 'x', path: '/', secure: false, httpOnly: false, sameSite: 'Lax', hostOnly: true },
    ]);
    expect(header).toBe('a=1; b=2');
  });
});

describe('domainMatch (RFC 6265 §5.1.3)', () => {
  it('matches an identical host', () => {
    expect(domainMatch('example.com', 'example.com')).toBe(true);
  });

  it('matches a subdomain of the cookie domain', () => {
    expect(domainMatch('www.example.com', 'example.com')).toBe(true);
  });

  it('does not match an unrelated domain, or a suffix without a dot boundary', () => {
    expect(domainMatch('notexample.com', 'example.com')).toBe(false);
    expect(domainMatch('evilexample.com', 'example.com')).toBe(false);
  });

  it('never matches by suffix when the request host is an IP address', () => {
    expect(domainMatch('192.168.1.1', '168.1.1')).toBe(false);
  });
});

describe('pathMatch (RFC 6265 §5.1.4)', () => {
  it('matches identical paths', () => {
    expect(pathMatch('/a/b', '/a/b')).toBe(true);
  });

  it('matches when cookie-path is a "/"-terminated prefix', () => {
    expect(pathMatch('/a/b/c', '/a/')).toBe(true);
  });

  it('matches when the next char after the cookie-path prefix is "/"', () => {
    expect(pathMatch('/a/b', '/a')).toBe(true);
  });

  it('does not match a same-prefix sibling path', () => {
    expect(pathMatch('/apple', '/app')).toBe(false);
  });
});

describe('CookieJar', () => {
  it('stores a cookie and returns it for a matching request', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=abc123', 'example.com', '/');
    const cookies = jar.cookiesFor('example.com', '/');
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('sid');
  });

  it('a hostOnly cookie is not sent to a subdomain', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=abc', 'example.com', '/');
    expect(jar.cookiesFor('www.example.com', '/')).toHaveLength(0);
    expect(jar.cookiesFor('example.com', '/')).toHaveLength(1);
  });

  it('a cookie with an explicit Domain is sent to matching subdomains', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=abc; Domain=example.com', 'www.example.com', '/');
    expect(jar.cookiesFor('www.example.com', '/')).toHaveLength(1);
    expect(jar.cookiesFor('shop.example.com', '/')).toHaveLength(1);
    expect(jar.cookiesFor('example.com', '/')).toHaveLength(1);
  });

  it('rejects a Domain attribute that does not domain-match the setting host', () => {
    const jar = new CookieJar();
    const accepted = jar.setFromHeader('sid=abc; Domain=evil.com', 'example.com', '/');
    expect(accepted).toBe(false);
    expect(jar.all()).toHaveLength(0);
  });

  it('respects Path when selecting cookies for a request', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=abc; Path=/admin', 'example.com', '/');
    expect(jar.cookiesFor('example.com', '/admin/users')).toHaveLength(1);
    expect(jar.cookiesFor('example.com', '/public')).toHaveLength(0);
  });

  it('does not send a Secure cookie over a non-secure request', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=abc; Secure', 'example.com', '/');
    expect(jar.cookiesFor('example.com', '/', { secure: false })).toHaveLength(0);
    expect(jar.cookiesFor('example.com', '/', { secure: true })).toHaveLength(1);
  });

  it('does not send a SameSite=Strict/Lax cookie in a cross-site context', () => {
    const jar = new CookieJar();
    jar.setFromHeader('strict=1; SameSite=Strict', 'example.com', '/');
    jar.setFromHeader('lax=1; SameSite=Lax', 'example.com', '/');
    jar.setFromHeader('none=1; SameSite=None', 'example.com', '/');
    const crossSite = jar.cookiesFor('example.com', '/', { siteContext: 'cross-site' }).map((c) => c.name);
    expect(crossSite).toEqual(['none']);
    const sameSite = jar.cookiesFor('example.com', '/', { siteContext: 'same-site' }).map((c) => c.name).sort();
    expect(sameSite).toEqual(['lax', 'none', 'strict']);
  });

  it('expires a cookie via Max-Age and stops returning it', () => {
    const jar = new CookieJar();
    const now = Date.now();
    jar.setFromHeader('sid=abc; Max-Age=10', 'example.com', '/', now);
    expect(jar.cookiesFor('example.com', '/', {}, now + 5_000)).toHaveLength(1);
    expect(jar.cookiesFor('example.com', '/', {}, now + 15_000)).toHaveLength(0);
  });

  it('a re-set cookie with the same name/domain/path replaces the old one', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=old', 'example.com', '/');
    jar.setFromHeader('sid=new', 'example.com', '/');
    const cookies = jar.cookiesFor('example.com', '/');
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe('new');
  });

  it('an already-expired Max-Age deletes any existing matching cookie', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=abc', 'example.com', '/');
    jar.setFromHeader('sid=abc; Max-Age=0', 'example.com', '/');
    expect(jar.all()).toHaveLength(0);
  });
});
