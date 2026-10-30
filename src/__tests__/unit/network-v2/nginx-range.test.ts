/**
 * nginx 1.24.0 : les requetes `Range` d'un fichier statique (ngx_http_range_filter_module.c : `ngx_http_range_header_filter`,
 * `ngx_http_range_parse`, `ngx_http_range_singlepart_header`, `ngx_http_range_multipart_header`, `ngx_http_range_not_satisfiable`).
 *
 * Ce que la source fixe : le filtre n'agit que sur un 200 dont la longueur est connue (donc PAS sur une reponse compressee, qui part en
 * chunked) ; `Accept-Ranges: bytes` n'est ecrit que lorsque la reponse n'est pas decoupee ; `Range` doit commencer par `bytes=` ; un
 * `If-Range` qui ne correspond pas a l'ETag (texte exact) ni a la date (egalite) fait servir le corps entier ; une syntaxe fautive ou
 * un debut >= longueur donne 416 avec `Content-Range` valant « bytes », une etoile, une barre et la longueur ; un intervalle ouvert (`5-`) ou un suffixe (`-3`) est
 * ramene a la longueur ; plusieurs intervalles donnent `multipart/byteranges` dont la frontiere est un compteur sur 20 chiffres.
 *
 * Mesure de depart : `Range` etait ignore (200 plein corps) et `Accept-Ranges` n'etait jamais emis.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { sh } from './_httpsLab';
import { up } from './_nginxLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(extra = ''): Promise<LinuxServer> {
  const srv = await up(extra);
  await sh(srv, `sh -c 'printf "0123456789" > /var/www/html/digits.txt'`);
  return srv;
}

async function get(srv: LinuxServer, path: string, headers: string[] = []): Promise<string> {
  return sh(srv, `curl -s -i ${headers.map((h) => `-H '${h}'`).join(' ')} http://localhost${path}`);
}

const status = (out: string): string => out.split('\n')[0].trim();
const header = (out: string, name: string): string | undefined =>
  out.split('\n').map((l) => l.trim()).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
const body = (out: string): string => {
  const blank = /\r?\n\r?\n/.exec(out);
  return blank === null ? '' : out.slice(blank.index + blank[0].length);
};

describe('un seul intervalle', () => {
  it('bytes=2-5 : 206, Content-Range et les quatre octets', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=2-5']);
    expect(status(out)).toBe('HTTP/1.1 206 Partial Content');
    expect(header(out, 'Content-Range')).toBe('bytes 2-5/10');
    expect(header(out, 'Content-Length')).toBe('4');
    expect(body(out)).toBe('2345');
  });

  it('un intervalle ouvert va jusqu\'a la fin', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=7-']);
    expect(header(out, 'Content-Range')).toBe('bytes 7-9/10');
    expect(body(out)).toBe('789');
  });

  it('un suffixe prend la fin', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=-3']);
    expect(header(out, 'Content-Range')).toBe('bytes 7-9/10');
    expect(body(out)).toBe('789');
  });

  it('une fin au-dela de la longueur est ramenee a la longueur', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=8-99']);
    expect(header(out, 'Content-Range')).toBe('bytes 8-9/10');
  });

  it('un suffixe plus long que le fichier donne tout le fichier en 206', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=-50']);
    expect(status(out)).toBe('HTTP/1.1 206 Partial Content');
    expect(header(out, 'Content-Range')).toBe('bytes 0-9/10');
  });
});

describe('416', () => {
  it('un debut au-dela du fichier : 416 et « bytes */10 »', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=20-30']);
    expect(status(out)).toBe('HTTP/1.1 416 Requested Range Not Satisfiable');
    expect(header(out, 'Content-Range')).toBe('bytes */10');
  });

  it('une syntaxe fautive : 416', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=abc']);
    expect(status(out)).toBe('HTTP/1.1 416 Requested Range Not Satisfiable');
  });
});

describe('ce que le filtre laisse passer', () => {
  it('Accept-Ranges: bytes sur une reponse 200', async () => {
    expect(header(await get(await lab(), '/digits.txt'), 'Accept-Ranges')).toBe('bytes');
  });

  it('un Range qui ne commence pas par « bytes= » est ignore', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: items=1-2']);
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(body(out)).toBe('0123456789');
  });

  it('une reponse compressee n\'est pas decoupee et ne promet pas de Range', async () => {
    const srv = await lab('  gzip_types text/plain;\n  gzip on;\n  gzip_min_length 1;\n');
    const out = await get(srv, '/digits.txt', ['Accept-Encoding: gzip', 'Range: bytes=2-5']);
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(header(out, 'Accept-Ranges')).toBeUndefined();
  });

  it('un 404 n\'est pas concerne', async () => {
    const out = await get(await lab(), '/absent.txt', ['Range: bytes=0-1']);
    expect(status(out)).toBe('HTTP/1.1 404 Not Found');
  });
});

describe('If-Range', () => {
  it('l\'ETag exact : le Range est servi', async () => {
    const srv = await lab();
    const etag = header(await get(srv, '/digits.txt'), 'ETag')!;
    const out = await get(srv, '/digits.txt', ['Range: bytes=0-1', `If-Range: ${etag}`]);
    expect(status(out)).toBe('HTTP/1.1 206 Partial Content');
  });

  it('un autre ETag : le corps entier', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=0-1', 'If-Range: "autre"']);
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(body(out)).toBe('0123456789');
  });

  it('la date exacte du fichier : le Range est servi', async () => {
    const srv = await lab();
    const lm = header(await get(srv, '/digits.txt'), 'Last-Modified')!;
    expect(status(await get(srv, '/digits.txt', ['Range: bytes=0-1', `If-Range: ${lm}`]))).toBe('HTTP/1.1 206 Partial Content');
  });
});

describe('plusieurs intervalles', () => {
  it('multipart/byteranges, frontiere sur 20 chiffres, une partie par intervalle', async () => {
    const out = await get(await lab(), '/digits.txt', ['Range: bytes=0-1,5-6']);
    expect(status(out)).toBe('HTTP/1.1 206 Partial Content');
    const type = header(out, 'Content-Type')!;
    const boundary = /^multipart\/byteranges; boundary=(\d{20})$/.exec(type)?.[1];
    expect(boundary).toBeDefined();
    const parts = body(out);
    expect(parts.startsWith(`\r\n--${boundary}\r\nContent-Type: text/plain\r\nContent-Range: bytes 0-1/10\r\n\r\n01`)).toBe(true);
    expect(parts).toContain(`\r\n--${boundary}\r\nContent-Type: text/plain\r\nContent-Range: bytes 5-6/10\r\n\r\n56`);
    expect(parts.trimEnd().endsWith(`\r\n--${boundary}--`)).toBe(true);
    expect(header(out.slice(0, out.length - parts.length), 'Content-Range')).toBeUndefined();
  });
});

describe('HEAD', () => {
  it('un Range sur HEAD annonce le 206 sans corps', async () => {
    const out = await sh(await lab(), `curl -s -I -H 'Range: bytes=2-5' http://localhost/digits.txt`);
    expect(status(out)).toBe('HTTP/1.1 206 Partial Content');
    expect(header(out, 'Content-Range')).toBe('bytes 2-5/10');
  });
});

describe('max_ranges (ngx_http_core_module.c, ngx_http_range_parse : `ranges-- == 0` rend NGX_DECLINED)', () => {
  it('0 : le filtre est coupe, pas de 206 ni d\'Accept-Ranges', async () => {
    for (const value of ['0']) {
      EquipmentRegistry.getInstance().clear();
      const out = await get(await lab(`  max_ranges ${value};\n`), '/digits.txt', ['Range: bytes=2-5']);
      expect(status(out), value).toBe('HTTP/1.1 200 OK');
      expect(header(out, 'Accept-Ranges'), value).toBeUndefined();
    }
  });

  it('1 : un intervalle passe, deux donnent le corps entier', async () => {
    const srv = await lab('  max_ranges 1;\n');
    expect(status(await get(srv, '/digits.txt', ['Range: bytes=0-1']))).toBe('HTTP/1.1 206 Partial Content');
    expect(status(await get(srv, '/digits.txt', ['Range: bytes=0-1,5-6']))).toBe('HTTP/1.1 200 OK');
  });

  it('2 : deux intervalles passent', async () => {
    const srv = await lab('  max_ranges 2;\n');
    expect(status(await get(srv, '/digits.txt', ['Range: bytes=0-1,5-6']))).toBe('HTTP/1.1 206 Partial Content');
  });

  it('une valeur qui n\'est pas un nombre est refusee par nginx -t', async () => {
    const srv = await lab();
    const { site, SERVER } = await import('./_nginxLab');
    await site(srv, SERVER('  max_ranges many;\n'));
    expect(await sh(srv, 'nginx -t')).toContain('"max_ranges" directive invalid number');
  });
});
