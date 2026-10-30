/**
 * nginx 1.24.0 : `Last-Modified`, `ETag` et la requete conditionnelle d'un fichier statique.
 *
 * Sources : ngx_http_static_module.c (`last_modified_time = of.mtime`, puis `ngx_http_set_etag`), ngx_http_core_module.c
 * (`ngx_http_set_etag` : `"%xT-%xO"` = mtime puis taille, en hexadecimal minuscule ; directives `etag on|off` et
 * `if_modified_since off|exact|before`, defaut `exact`), ngx_http_range_filter_module.c (`Accept-Ranges: bytes`) et
 * ngx_http_not_modified_filter_module.c : le filtre ne regarde que les reponses 200 ; If-Unmodified-Since puis If-Match
 * donnent 412 ; If-Modified-Since et If-None-Match doivent TOUS DEUX dire « inchange » pour un 304 ; `exact` ne donne 304
 * que si la date EST celle du fichier (`ims == lm`), `before` aussi quand elle est posterieure ; If-None-Match compare le texte
 * de l'ETag en ignorant le prefixe `W/` ; `*` correspond toujours.
 *
 * Mesure de depart : aucun de ces en-tetes n'etait emis, et If-None-Match / If-Modified-Since etaient ignores (200 plein corps).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { sh } from './_httpsLab';
import { up } from './_nginxLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function get(srv: LinuxServer, path: string, headers: string[] = [], method = ''): Promise<string> {
  const flags = headers.map((h) => `-H '${h}'`).join(' ');
  return sh(srv, `curl -s -i ${method} ${flags} http://localhost${path}`);
}

const header = (out: string, name: string): string | undefined =>
  out.split('\r\n').concat(out.split('\n')).map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
const status = (out: string): string => out.split('\n')[0].trim();

describe('en-tetes d\'un fichier statique', () => {
  it('Last-Modified est une date HTTP, ETag est "mtime-taille" en hexadecimal', async () => {
    const srv = await up();
    const out = await get(srv, '/tiny.html');
    expect(header(out, 'Last-Modified')).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    const seconds = Math.floor(Date.parse(header(out, 'Last-Modified')!) / 1000);
    expect(header(out, 'ETag')).toBe(`"${seconds.toString(16)}-2"`);
    expect(header(out, 'Accept-Ranges')).toBe('bytes');
  });

  it('`etag off;` retire l\'ETag mais pas Last-Modified', async () => {
    const srv = await up('  etag off;\n');
    const out = await get(srv, '/tiny.html');
    expect(header(out, 'ETag')).toBeUndefined();
    expect(header(out, 'Last-Modified')).toBeDefined();
  });

  it('une valeur d\'etag fautive est refusee par nginx -t', async () => {
    const srv = await up();
    const { site, SERVER } = await import('./_nginxLab');
    await site(srv, SERVER('  etag maybe;\n'));
    expect(await sh(srv, 'nginx -t')).toContain('invalid value "maybe" in "etag" directive, it must be "on" or "off"');
  });

  it('if_modified_since n\'accepte que off, exact, before', async () => {
    const srv = await up();
    const { site, SERVER } = await import('./_nginxLab');
    await site(srv, SERVER('  if_modified_since never;\n'));
    expect(await sh(srv, 'nginx -t')).toContain('invalid value "never"');
  });
});

describe('If-None-Match', () => {
  it('l\'ETag courant donne 304 sans corps ni type', async () => {
    const srv = await up();
    const etag = header(await get(srv, '/tiny.html'), 'ETag')!;
    const out = await get(srv, '/tiny.html', [`If-None-Match: ${etag}`]);
    expect(status(out)).toBe('HTTP/1.1 304 Not Modified');
    expect(header(out, 'Content-Type')).toBeUndefined();
    expect(header(out, 'Content-Length')).toBeUndefined();
    expect(header(out, 'ETag')).toBe(etag);
    expect(out.endsWith('\n\r\n') || out.trimEnd().endsWith('Not Modified') || !out.includes('hi')).toBe(true);
  });

  it('un autre ETag laisse passer la reponse complete', async () => {
    const srv = await up();
    expect(status(await get(srv, '/tiny.html', ['If-None-Match: "autre"']))).toBe('HTTP/1.1 200 OK');
  });

  it('le prefixe faible W/ est ignore, et * correspond', async () => {
    const srv = await up();
    const etag = header(await get(srv, '/tiny.html'), 'ETag')!;
    expect(status(await get(srv, '/tiny.html', [`If-None-Match: W/${etag}`]))).toBe('HTTP/1.1 304 Not Modified');
    expect(status(await get(srv, '/tiny.html', ['If-None-Match: *']))).toBe('HTTP/1.1 304 Not Modified');
  });

  it('une liste d\'ETag correspond si l\'un d\'eux est le bon', async () => {
    const srv = await up();
    const etag = header(await get(srv, '/tiny.html'), 'ETag')!;
    expect(status(await get(srv, '/tiny.html', [`If-None-Match: "x", ${etag}`]))).toBe('HTTP/1.1 304 Not Modified');
  });
});

describe('If-Modified-Since', () => {
  it('la date exacte du fichier donne 304', async () => {
    const srv = await up();
    const lm = header(await get(srv, '/tiny.html'), 'Last-Modified')!;
    expect(status(await get(srv, '/tiny.html', [`If-Modified-Since: ${lm}`]))).toBe('HTTP/1.1 304 Not Modified');
  });

  it('une date posterieure ne donne PAS 304 en mode exact (le defaut de nginx)', async () => {
    const srv = await up();
    const later = new Date(Date.parse(header(await get(srv, '/tiny.html'), 'Last-Modified')!) + 86_400_000).toUTCString();
    expect(status(await get(srv, '/tiny.html', [`If-Modified-Since: ${later}`]))).toBe('HTTP/1.1 200 OK');
  });

  it('`if_modified_since before;` accepte une date posterieure', async () => {
    const srv = await up('  if_modified_since before;\n');
    const later = new Date(Date.parse(header(await get(srv, '/tiny.html'), 'Last-Modified')!) + 86_400_000).toUTCString();
    expect(status(await get(srv, '/tiny.html', [`If-Modified-Since: ${later}`]))).toBe('HTTP/1.1 304 Not Modified');
  });

  it('`if_modified_since off;` ignore l\'en-tete', async () => {
    const srv = await up('  if_modified_since off;\n');
    const lm = header(await get(srv, '/tiny.html'), 'Last-Modified')!;
    expect(status(await get(srv, '/tiny.html', [`If-Modified-Since: ${lm}`]))).toBe('HTTP/1.1 200 OK');
  });

  it('avec If-None-Match, les DEUX doivent dire inchange', async () => {
    const srv = await up();
    const first = await get(srv, '/tiny.html');
    const lm = header(first, 'Last-Modified')!;
    const etag = header(first, 'ETag')!;
    expect(status(await get(srv, '/tiny.html', [`If-Modified-Since: ${lm}`, 'If-None-Match: "autre"']))).toBe('HTTP/1.1 200 OK');
    expect(status(await get(srv, '/tiny.html', [`If-Modified-Since: ${lm}`, `If-None-Match: ${etag}`]))).toBe('HTTP/1.1 304 Not Modified');
  });
});

describe('If-Match et If-Unmodified-Since', () => {
  it('If-Match avec un autre ETag : 412', async () => {
    const srv = await up();
    expect(status(await get(srv, '/tiny.html', ['If-Match: "autre"']))).toBe('HTTP/1.1 412 Precondition Failed');
  });

  it('If-Match avec le bon ETag : 200', async () => {
    const srv = await up();
    const etag = header(await get(srv, '/tiny.html'), 'ETag')!;
    expect(status(await get(srv, '/tiny.html', [`If-Match: ${etag}`]))).toBe('HTTP/1.1 200 OK');
  });

  it('If-Unmodified-Since anterieur au fichier : 412', async () => {
    const srv = await up();
    expect(status(await get(srv, '/tiny.html', ['If-Unmodified-Since: Thu, 01 Jan 1970 00:00:01 GMT']))).toBe('HTTP/1.1 412 Precondition Failed');
  });
});

describe('ce qui n\'est pas concerne', () => {
  it('TEMOIN : sans en-tete conditionnel, la reponse est 200 avec son corps', async () => {
    const srv = await up();
    const out = await get(srv, '/tiny.html');
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(out.endsWith('hi')).toBe(true);
  });

  it('une reponse generee (404) n\'a ni ETag ni Last-Modified', async () => {
    const srv = await up();
    const out = await get(srv, '/absent.html');
    expect(status(out)).toBe('HTTP/1.1 404 Not Found');
    expect(header(out, 'ETag')).toBeUndefined();
    expect(header(out, 'Last-Modified')).toBeUndefined();
  });
});
