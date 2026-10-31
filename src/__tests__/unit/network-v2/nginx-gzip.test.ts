/**
 * nginx 1.24.0 `ngx_http_gzip_filter_module` : `gzip on;` COMPRESSE.
 *
 * Source : src/http/modules/ngx_http_gzip_filter_module.c
 * (`ngx_http_gzip_header_filter`) et src/http/ngx_http_core_module.c
 * (`ngx_http_gzip_ok`, `ngx_http_gzip_accept_encoding`, directives
 * `gzip_vary`, `gzip_proxied`, `gzip_disable`, `gzip_http_version`).
 *
 * Mesuré avant le correctif : le `nginx.conf` livré dit `gzip on;`, et
 * `curl -H 'Accept-Encoding: gzip'` recevait le corps en clair, sans
 * `Content-Encoding`. Les huit directives `gzip*` étaient dans
 * `ACCEPTED_INERT` : acceptées, rendues, sans effet (CLAUDE.md règle 6).
 * Le codec existe pourtant (`rsyslog/Zlib.ts`) ; le TODO affirmait le
 * contraire.
 *
 * Discrimination par `git stash` : voir la fin du fichier.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { machine, sh } from './_httpsLab';
import { site, SERVER, up } from './_nginxLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const STRONG_ETAG_HEADER = `  etag off;\n  add_header ETag '"abc"';\n`;
const WELCOME = 'Welcome to nginx!';

interface Answer { readonly head: string; readonly body: string; readonly plain: string; readonly size: number }

async function get(
  srv: LinuxServer, path: string, headers: readonly string[] = ['Accept-Encoding: gzip'], flags = '',
): Promise<Answer> {
  const h = headers.map((x) => `-H '${x}'`).join(' ');
  await sh(srv, 'rm -f /tmp/h /tmp/body');
  await sh(srv, `curl -s ${flags} -D /tmp/h -o /tmp/body ${h} http://localhost${path}`);
  const head = await sh(srv, 'cat /tmp/h');
  const body = await sh(srv, 'cat /tmp/body');
  const plain = head.includes('Content-Encoding: gzip')
    ? await sh(srv, 'zcat /tmp/body') : body;
  const size = Number((await sh(srv, 'wc -c < /tmp/body')).trim());
  return { head, body, plain, size };
}

const compressed = (a: Answer): boolean => a.head.includes('Content-Encoding: gzip');

describe('ngx_http_gzip_header_filter : ce qui se compresse', () => {
  it('le nginx.conf livré (gzip on) compresse une page HTML demandée avec Accept-Encoding: gzip', async () => {
    const srv = await up();
    const a = await get(srv, '/');
    expect(compressed(a)).toBe(true);
    expect(a.plain).toContain(WELCOME);
  });

  it('la réponse compressée est en Transfer-Encoding: chunked, sans Content-Length', async () => {
    const srv = await up();
    const a = await get(srv, '/big.html');
    expect(a.head).toContain('Transfer-Encoding: chunked');
    expect(a.head).not.toContain('Content-Length');
  });

  it('un grand corps est vraiment plus court sur le fil, et revient identique', async () => {
    const srv = await up();
    const a = await get(srv, '/big.html');
    const original = await sh(srv, 'cat /var/www/html/big.html');
    expect(compressed(a)).toBe(true);
    expect(a.plain).toBe(original);
    expect(a.body.length).toBeLessThan(original.length / 2);
  });

  it('sans Accept-Encoding : corps en clair', async () => {
    const srv = await up();
    const a = await get(srv, '/', []);
    expect(compressed(a)).toBe(false);
    expect(a.body).toContain(WELCOME);
  });

  it('gzip off (valeur par défaut hors nginx.conf livré) : rien n\'est compressé', async () => {
    const srv = await up('  gzip off;\n');
    expect(compressed(await get(srv, '/'))).toBe(false);
  });

  it('un 404 est compressé (statuts 200, 403, 404 seulement)', async () => {
    const srv = await up();
    const a = await get(srv, '/absent.html');
    expect(a.head).toContain('404');
    expect(compressed(a)).toBe(true);
    expect(a.plain).toContain('404 Not Found');
  });

  it('un 301 (return) et un 502 ne sont jamais compressés', async () => {
    const srv = await up(
      '  location /old { return 301 /new; }\n  location /dead { proxy_pass http://127.0.0.1:9; }\n',
    );
    expect(compressed(await get(srv, '/old'))).toBe(false);
    const dead = await get(srv, '/dead');
    expect(dead.head).toContain('502');
    expect(compressed(dead)).toBe(false);
  });

  it('HEAD n\'est pas compressé (r->header_only)', async () => {
    const srv = await up();
    const a = await get(srv, '/big.html', ['Accept-Encoding: gzip'], '-I');
    expect(a.head).toContain('200');
    expect(compressed(a)).toBe(false);
  });
});

describe('ngx_http_gzip_accept_encoding : lecture de l\'en-tête du client', () => {
  const cases: readonly [string, boolean][] = [
    ['gzip', true],
    ['gzip, deflate', true],
    ['gzip,deflate,sdch', true],
    ['deflate, gzip', true],
    ['br, gzip;q=0.5', true],
    ['gzip;q=0.001', true],
    ['gzip ; q=1.0', true],
    ['GZIP', true],
    ['gzip;q=0', false],
    ['gzip;q=0.000', false],
    ['gzip;q=0.0', false],
    ['identity', false],
    ['deflate', false],
    ['xgzip', false],
    ['gzipx', false],
    ['gzip;level=1', false],
  ];
  for (const [value, expected] of cases) {
    it(`Accept-Encoding: ${value} → ${expected ? 'compressé' : 'en clair'}`, async () => {
      const srv = await up();
      expect(compressed(await get(srv, '/', [`Accept-Encoding: ${value}`]))).toBe(expected);
    });
  }
});

describe('gzip_types, gzip_min_length', () => {
  it('par défaut seul text/html est compressé : une feuille de style ne l\'est pas', async () => {
    const srv = await up();
    expect(compressed(await get(srv, '/site.css'))).toBe(false);
  });

  it('gzip_types text/css l\'ajoute, text/html reste compressé', async () => {
    const srv = await up('  gzip_types text/css;\n');
    expect(compressed(await get(srv, '/site.css'))).toBe(true);
    expect(compressed(await get(srv, '/big.html'))).toBe(true);
  });

  it('gzip_types * compresse tout type', async () => {
    const srv = await up('  gzip_types *;\n');
    expect(compressed(await get(srv, '/site.css'))).toBe(true);
  });

  it('le nom du type est comparé sans casse', async () => {
    const srv = await up('  gzip_types TEXT/CSS;\n');
    expect(compressed(await get(srv, '/site.css'))).toBe(true);
  });

  it('gzip_min_length par défaut 20 : 2 octets ne sont pas compressés, 612 le sont', async () => {
    const srv = await up();
    expect(compressed(await get(srv, '/tiny.html'))).toBe(false);
    expect(compressed(await get(srv, '/'))).toBe(true);
  });

  it('gzip_min_length 1k laisse passer en clair une page de 612 octets', async () => {
    const srv = await up('  gzip_min_length 1k;\n');
    expect(compressed(await get(srv, '/'))).toBe(false);
    expect(compressed(await get(srv, '/big.html'))).toBe(true);
  });

  it('gzip_min_length 0 compresse même 2 octets', async () => {
    const srv = await up('  gzip_min_length 0;\n');
    const a = await get(srv, '/tiny.html');
    expect(compressed(a)).toBe(true);
    expect(a.plain).toBe('hi');
  });
});

describe('gzip_vary, gzip_proxied, gzip_disable', () => {
  it('gzip_vary on : Vary: Accept-Encoding, y compris pour un client qui n\'accepte pas gzip', async () => {
    const srv = await up('  gzip_vary on;\n');
    expect((await get(srv, '/', ['Accept-Encoding: gzip'])).head).toContain('Vary: Accept-Encoding');
    const without = await get(srv, '/', []);
    expect(compressed(without)).toBe(false);
    expect(without.head).toContain('Vary: Accept-Encoding');
  });

  it('gzip_vary off (défaut) : pas de Vary', async () => {
    const srv = await up();
    expect((await get(srv, '/')).head).not.toContain('Vary');
  });

  it('gzip_vary ne marque pas ce qui ne serait jamais compressé (trop court)', async () => {
    const srv = await up('  gzip_vary on;\n');
    expect((await get(srv, '/tiny.html')).head).not.toContain('Vary');
  });

  it('une requête portant Via est servie en clair tant que gzip_proxied est off', async () => {
    const srv = await up();
    const a = await get(srv, '/', ['Accept-Encoding: gzip', 'Via: 1.1 cache']);
    expect(compressed(a)).toBe(false);
  });

  it('gzip_proxied any compresse malgré Via', async () => {
    const srv = await up('  gzip_proxied any;\n');
    expect(compressed(await get(srv, '/', ['Accept-Encoding: gzip', 'Via: 1.1 cache']))).toBe(true);
  });

  it('gzip_proxied off any est valide, et off l\'emporte (ngx_http_gzip_ok teste OFF avant ANY)', async () => {
    const srv = await up('  gzip_proxied off any;\n');
    expect(compressed(await get(srv, '/', ['Accept-Encoding: gzip', 'Via: 1.1 cache']))).toBe(false);
  });

  it('gzip_proxied auth : Authorization suffit ; sinon une réponse à Cache-Control hors liste est refusée', async () => {
    const srv = await up('  gzip_proxied auth;\n  add_header Cache-Control "max-age=60";\n');
    expect(compressed(await get(srv, '/', ['Accept-Encoding: gzip', 'Via: 1.1 c']))).toBe(false);
    expect(compressed(await get(srv, '/', [
      'Accept-Encoding: gzip', 'Via: 1.1 c', 'Authorization: Basic YTpi',
    ]))).toBe(true);
  });

  it('gzip_proxied no-cache n\'accepte que Cache-Control: no-cache, pas private', async () => {
    const priv = await up('  gzip_proxied no-cache;\n  add_header Cache-Control "private";\n');
    const via = ['Accept-Encoding: gzip', 'Via: 1.1 c'];
    expect(compressed(await get(priv, '/', via))).toBe(false);
    EquipmentRegistry.getInstance().clear();
    const nc = await up('  gzip_proxied no-cache;\n  add_header Cache-Control "no-cache";\n');
    expect(compressed(await get(nc, '/', via))).toBe(true);
  });

  it('gzip_proxied expired n\'accepte que Expires dans le passé', async () => {
    const via = ['Accept-Encoding: gzip', 'Via: 1.1 c'];
    const past = await up('  gzip_proxied expired;\n  add_header Expires "Thu, 01 Jan 1970 00:00:01 GMT";\n');
    expect(compressed(await get(past, '/', via))).toBe(true);
    EquipmentRegistry.getInstance().clear();
    const future = await up('  gzip_proxied expired;\n  add_header Expires "Fri, 01 Jan 2100 00:00:01 GMT";\n');
    expect(compressed(await get(future, '/', via))).toBe(false);
  });

  it('gzip_proxied no_etag refuse une réponse portant un ETag', async () => {
    const via = ['Accept-Encoding: gzip', 'Via: 1.1 c'];
    const tagged = await up(STRONG_ETAG_HEADER + '  gzip_proxied no_etag;\n');
    expect(compressed(await get(tagged, '/', via))).toBe(false);
    EquipmentRegistry.getInstance().clear();
    const bare = await up('  etag off;\n  gzip_proxied no_etag;\n');
    expect(compressed(await get(bare, '/', via))).toBe(true);
  });

  it('gzip_disable "msie6" écarte MSIE 6.0 mais pas MSIE 6.0 avec SV1, ni un autre navigateur', async () => {
    const srv = await up('  gzip_disable "msie6";\n');
    const ua = (v: string) => get(srv, '/', ['Accept-Encoding: gzip', `User-Agent: ${v}`]);
    expect(compressed(await ua('Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)'))).toBe(false);
    expect(compressed(await ua('Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1)'))).toBe(true);
    expect(compressed(await ua('Mozilla/5.0 Firefox/115.0'))).toBe(true);
  });

  it('gzip_disable accepte une expression régulière, sans casse', async () => {
    const srv = await up('  gzip_disable "BadBot/[0-9]+";\n');
    expect(compressed(await get(srv, '/', ['Accept-Encoding: gzip', 'User-Agent: badbot/12']))).toBe(false);
    expect(compressed(await get(srv, '/', ['Accept-Encoding: gzip', 'User-Agent: goodbot/12']))).toBe(true);
  });
});

describe('ngx_http_weak_etag', () => {
  it('un ETag fort devient faible quand la réponse est compressée, et reste fort sinon', async () => {
    const srv = await up(STRONG_ETAG_HEADER);
    expect((await get(srv, '/')).head).toContain('ETag: W/"abc"');
    expect((await get(srv, '/', [])).head).toContain('ETag: "abc"');
  });
});

describe('héritage http → server → location', () => {
  it('gzip off dans une location l\'emporte sur gzip on du nginx.conf', async () => {
    const srv = await up('  location /raw/ { gzip off; }\n  location /zip/ { gzip on; }\n');
    await sh(srv, 'mkdir -p /var/www/html/raw /var/www/html/zip');
    await sh(srv, 'cp /var/www/html/big.html /var/www/html/raw/big.html');
    await sh(srv, 'cp /var/www/html/big.html /var/www/html/zip/big.html');
    expect(compressed(await get(srv, '/raw/big.html'))).toBe(false);
    expect(compressed(await get(srv, '/zip/big.html'))).toBe(true);
    expect(compressed(await get(srv, '/big.html'))).toBe(true);
  });

  it('une location hérite des gzip_types du server', async () => {
    const srv = await up('  gzip_types text/css;\n  location /s/ { }\n');
    await sh(srv, 'mkdir -p /var/www/html/s');
    await sh(srv, 'cp /var/www/html/site.css /var/www/html/s/site.css');
    expect(compressed(await get(srv, '/s/site.css'))).toBe(true);
  });

  it('gzip_types d\'une location REMPLACE celui du server (ce n\'est pas une liste cumulée)', async () => {
    const srv = await up('  gzip_types text/css;\n  location /j/ { gzip_types application/json; }\n');
    await sh(srv, 'mkdir -p /var/www/html/j');
    await sh(srv, 'cp /var/www/html/site.css /var/www/html/j/site.css');
    expect(compressed(await get(srv, '/j/site.css'))).toBe(false);
  });

  it('un réglage du bloc http s\'applique à tous les server', async () => {
    const srv = await up('', 'gzip_min_length 1k;\n');
    expect(compressed(await get(srv, '/'))).toBe(false);
  });
});

describe('gzip_comp_level', () => {
  it('le niveau 9 ne produit jamais plus que le niveau 1, et les deux se décompressent', async () => {
    const one = await up('  gzip_comp_level 1;\n');
    const a1 = await get(one, '/big.html');
    EquipmentRegistry.getInstance().clear();
    const nine = await up('  gzip_comp_level 9;\n');
    const a9 = await get(nine, '/big.html');
    expect(a9.plain).toBe(a1.plain);
    expect(a9.body.length).toBeLessThanOrEqual(a1.body.length);
  });
});

describe('journal d\'accès : $body_bytes_sent est la taille COMPRESSÉE', () => {
  it('la ligne porte l\'octet-compte du corps compressé, pas celui du fichier', async () => {
    const srv = await up();
    const original = (await sh(srv, 'cat /var/www/html/big.html')).length;
    const a = await get(srv, '/big.html');
    const line = (await sh(srv, 'tail -n 1 /var/log/nginx/access.log')).trim();
    const sent = Number(/" 200 (\d+) /.exec(line)?.[1]);
    expect(compressed(a)).toBe(true);
    expect(sent).toBeLessThan(original);
    expect(sent).toBe(a.size);
  });
});

describe('nginx -t juge les directives gzip (ngx_conf_file.c)', () => {
  const refused = async (extra: string): Promise<string> => {
    const srv = machine();
    await site(srv, SERVER(extra));
    return sh(srv, 'nginx -t');
  };

  it('gzip maybe → invalid value "maybe", it must be "on" or "off"', async () => {
    expect(await refused('  gzip maybe;\n'))
      .toContain('invalid value "maybe" in "gzip" directive, it must be "on" or "off"');
  });
  it('gzip_vary 1 → invalid value', async () => {
    expect(await refused('  gzip_vary 1;\n')).toContain('invalid value "1" in "gzip_vary" directive');
  });
  it('gzip_comp_level 10 → value must be between 1 and 9', async () => {
    expect(await refused('  gzip_comp_level 10;\n')).toContain('value must be between 1 and 9');
  });
  it('gzip_comp_level 0 → value must be between 1 and 9', async () => {
    expect(await refused('  gzip_comp_level 0;\n')).toContain('value must be between 1 and 9');
  });
  it('gzip_comp_level x → invalid number', async () => {
    expect(await refused('  gzip_comp_level x;\n')).toContain('"gzip_comp_level" directive invalid number');
  });
  it('gzip écrit deux fois dans le même bloc → is duplicate', async () => {
    expect(await refused('  gzip on;\n  gzip off;\n')).toContain('"gzip" directive is duplicate');
  });
  it('gzip_min_length abc → invalid value', async () => {
    expect(await refused('  gzip_min_length abc;\n')).toContain('"gzip_min_length" directive invalid value');
  });
  it('gzip_http_version 2.0 → invalid value "2.0"', async () => {
    expect(await refused('  gzip_http_version 2.0;\n')).toContain('invalid value "2.0"');
  });
  it('gzip_proxied zorglub → invalid value "zorglub"', async () => {
    expect(await refused('  gzip_proxied zorglub;\n')).toContain('invalid value "zorglub"');
  });
  it('gzip_disable "(" → expression régulière invalide', async () => {
    expect(await refused('  gzip_disable "(";\n')).toContain('pcre2_compile() failed');
  });
  it('gzip sans argument → invalid number of arguments', async () => {
    expect(await refused('  gzip;\n')).toContain('invalid number of arguments in "gzip" directive');
  });
  it('WITNESS : la configuration livrée reste valide', async () => {
    const srv = machine();
    expect(await sh(srv, 'nginx -t')).toContain('syntax is ok');
  });
});
