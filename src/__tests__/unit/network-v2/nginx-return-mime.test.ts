/**
 * nginx 1.24.0 : la directive `return`, les lignes de statut et les pages
 * d'erreur de nginx, `default_type` et `types`.
 *
 * Sources : ngx_http_rewrite_module.c (`ngx_http_rewrite_return`),
 * ngx_http_script.c (`ngx_http_script_return_code`), ngx_http_core_module.c
 * (`ngx_http_send_response`, `ngx_http_set_content_type`),
 * ngx_http_header_filter_module.c (`ngx_http_status_lines`),
 * ngx_http_special_response.c (pages), conf/mime.types.
 *
 * Mesuré avant le correctif : `return 200 "hello"` répondait `200 Found`
 * avec `Location: hello` et un corps vide ; `return 404;` répondait
 * `404 Found` sans page ; un `return` au niveau `server` (la
 * redirection http -> https que tout le monde écrit) était IGNORÉ ;
 * `302` s'appelait `Found` alors que nginx dit `Moved Temporarily` ;
 * `default_type` et `types` étaient acceptés sans effet, et
 * `/etc/nginx/mime.types`, inclus par le nginx.conf livré, n'existait pas.
 *
 * Discrimination par `git stash -u` de src/network : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { sh } from './_httpsLab';
import { up } from './_nginxLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const URL = 'http://localhost';

async function raw(srv: LinuxServer, path: string, flags = ''): Promise<string> {
  return sh(srv, `curl -s -i ${flags} ${URL}${path}`);
}

const statusLine = (out: string): string => out.split('\n')[0].trim();

describe('return <code> <texte>', () => {
  it('200 avec un texte : le texte est le corps, le type est default_type du nginx.conf livré', async () => {
    const srv = await up('  location /ok { return 200 "hello"; }\n');
    const out = await raw(srv, '/ok');
    expect(statusLine(out)).toBe('HTTP/1.1 200 OK');
    expect(out).toContain('Content-Type: application/octet-stream');
    expect(out).toContain('Content-Length: 5');
    expect(out.endsWith('hello')).toBe(true);
    expect(out).not.toContain('Location:');
  });

  it('default_type de la location change le type', async () => {
    const srv = await up('  location /ok { default_type text/plain; return 200 "hello"; }\n');
    expect(await raw(srv, '/ok')).toContain('Content-Type: text/plain');
  });

  it('l\'extension de l\'URI décide avant default_type', async () => {
    const srv = await up('  location /page.html { return 200 "<b>x</b>"; }\n');
    expect(await raw(srv, '/page.html')).toContain('Content-Type: text/html');
  });

  it('204 : pas de corps', async () => {
    const srv = await up('  location /none { return 204; }\n');
    const out = await raw(srv, '/none');
    expect(statusLine(out)).toBe('HTTP/1.1 204 No Content');
    expect(out.split('\n\n')[1] ?? '').toBe('');
  });

  it('un texte avec variables : $host et $request_uri', async () => {
    const srv = await up('  location /who { return 200 "$host|$request_uri|$scheme"; }\n');
    expect((await raw(srv, '/who?a=1')).endsWith('localhost|/who?a=1|http')).toBe(true);
  });
});

describe('return <code> sans texte, pour une erreur : la page de nginx', () => {
  const cases: readonly [number, string, string][] = [
    [403, 'Forbidden', '403 Forbidden'],
    [404, 'Not Found', '404 Not Found'],
    [405, 'Not Allowed', '405 Not Allowed'],
    [429, 'Too Many Requests', '429 Too Many Requests'],
    [500, 'Internal Server Error', '500 Internal Server Error'],
    [503, 'Service Temporarily Unavailable', '503 Service Temporarily Unavailable'],
    [504, 'Gateway Time-out', '504 Gateway Time-out'],
  ];
  for (const [code, reason, title] of cases) {
    it(`${code} → « ${reason} » et la page <h1>${title}</h1>`, async () => {
      const srv = await up(`  location /e { return ${code}; }\n`);
      const out = await raw(srv, '/e');
      expect(statusLine(out)).toBe(`HTTP/1.1 ${code} ${reason}`);
      expect(out).toContain('Content-Type: text/html');
      expect(out).toContain(`<center><h1>${title}</h1></center>`);
      expect(out).toContain('<hr><center>nginx/1.24.0</center>');
    });
  }

  it('401 : la page dit « Authorization Required », la ligne « Unauthorized »', async () => {
    const srv = await up('  location /e { return 401; }\n');
    const out = await raw(srv, '/e');
    expect(statusLine(out)).toBe('HTTP/1.1 401 Unauthorized');
    expect(out).toContain('<h1>401 Authorization Required</h1>');
  });
});

describe('return 30x <url>', () => {
  it('301 : ligne, Location absolu, type html et page « 301 Moved Permanently »', async () => {
    const srv = await up('  location /old { return 301 /new; }\n');
    const out = await raw(srv, '/old');
    expect(statusLine(out)).toBe('HTTP/1.1 301 Moved Permanently');
    expect(out).toContain('Location: http://localhost/new');
    expect(out).toContain('Content-Type: text/html');
    expect(out).toContain('<h1>301 Moved Permanently</h1>');
  });

  it('302 : la ligne dit « Moved Temporarily », la page dit « 302 Found »', async () => {
    const srv = await up('  location /tmp { return 302 /x; }\n');
    const out = await raw(srv, '/tmp');
    expect(statusLine(out)).toBe('HTTP/1.1 302 Moved Temporarily');
    expect(out).toContain('<h1>302 Found</h1>');
  });

  for (const [code, reason] of [[303, 'See Other'], [307, 'Temporary Redirect'], [308, 'Permanent Redirect']] as const) {
    it(`${code} → ${reason}`, async () => {
      const srv = await up(`  location /r { return ${code} /x; }\n`);
      expect(statusLine(await raw(srv, '/r'))).toBe(`HTTP/1.1 ${code} ${reason}`);
    });
  }

  it('une seule URL (http://…) vaut 302', async () => {
    const srv = await up('  location /go { return http://example.org$request_uri; }\n');
    const out = await raw(srv, '/go?q=1');
    expect(statusLine(out)).toBe('HTTP/1.1 302 Moved Temporarily');
    expect(out).toContain('Location: http://example.org/go?q=1');
  });

  it('HEAD : mêmes en-têtes, pas de corps', async () => {
    const srv = await up('  location /old { return 301 /new; }\n');
    const out = await sh(srv, `curl -s -I ${URL}/old`);
    expect(out).toContain('301 Moved Permanently');
    expect(out).not.toContain('<h1>');
  });
});

describe('return au niveau server : la phase de réécriture passe AVANT les locations', () => {
  it('http -> https, le cas le plus écrit de nginx', async () => {
    const srv = await up('  return 301 https://$host$request_uri;\n');
    const out = await raw(srv, '/page?x=1');
    expect(statusLine(out)).toBe('HTTP/1.1 301 Moved Permanently');
    expect(out).toContain('Location: https://localhost/page?x=1');
  });

  it('une location n\'est jamais atteinte', async () => {
    const srv = await up('  return 403;\n  location / { return 200 "jamais"; }\n');
    const out = await raw(srv, '/');
    expect(statusLine(out)).toBe('HTTP/1.1 403 Forbidden');
    expect(out).not.toContain('jamais');
  });

  it('WITNESS : sans return, le site statique répond', async () => {
    const srv = await up();
    expect(await raw(srv, '/')).toContain('Welcome to nginx!');
  });
});

describe('types et mime.types', () => {
  it('/etc/nginx/mime.types existe et dit ce que nginx 1.24.0 livre', async () => {
    const srv = await up();
    const file = await sh(srv, 'cat /etc/nginx/mime.types');
    expect(file).toContain('types {');
    expect(file).toContain('text/html');
    expect(file).toContain('image/png');
  });

  it('un .png est servi image/png (octet-stream avant)', async () => {
    const srv = await up();
    await sh(srv, `sh -c 'printf "PNGDATA" > /var/www/html/p.png'`);
    expect(await raw(srv, '/p.png')).toContain('Content-Type: image/png');
  });

  it('une extension inconnue prend default_type', async () => {
    const srv = await up();
    await sh(srv, `sh -c 'printf "x" > /var/www/html/f.zorg'`);
    expect(await raw(srv, '/f.zorg')).toContain('Content-Type: application/octet-stream');
    EquipmentRegistry.getInstance().clear();
    const text = await up('  default_type text/plain;\n');
    await sh(text, `sh -c 'printf "x" > /var/www/html/f.zorg'`);
    expect(await raw(text, '/f.zorg')).toContain('Content-Type: text/plain');
  });

  it('un bloc types de la location REMPLACE la table héritée', async () => {
    const srv = await up('  location / { types { text/x-zorg zorg; } }\n');
    await sh(srv, `sh -c 'printf "x" > /var/www/html/f.zorg'`);
    await sh(srv, `sh -c 'printf "<p>" > /var/www/html/g.html'`);
    expect(await raw(srv, '/f.zorg')).toContain('Content-Type: text/x-zorg');
    expect(await raw(srv, '/g.html')).toContain('Content-Type: application/octet-stream');
  });

  it('le type est choisi sans tenir compte de la casse de l\'extension', async () => {
    const srv = await up();
    await sh(srv, `sh -c 'printf "<p>" > /var/www/html/UP.HTML'`);
    expect(await raw(srv, '/UP.HTML')).toContain('Content-Type: text/html');
  });
});

describe('nginx -t juge return, default_type et types', () => {
  const refused = async (extra: string): Promise<string> => {
    const { site, SERVER } = await import('./_nginxLab');
    const { machine } = await import('./_httpsLab');
    const srv = machine();
    await site(srv, SERVER(extra));
    return sh(srv, 'nginx -t');
  };

  it('return sans argument → invalid number of arguments', async () => {
    expect(await refused('  return;\n')).toContain('invalid number of arguments in "return" directive');
  });
  it('return abc → invalid return code "abc"', async () => {
    expect(await refused('  return abc;\n')).toContain('invalid return code "abc"');
  });
  it('return 1000 → invalid return code "1000"', async () => {
    expect(await refused('  return 1000;\n')).toContain('invalid return code "1000"');
  });
  it('return 200 $zorg → unknown "zorg" variable', async () => {
    expect(await refused('  return 200 $zorg;\n')).toContain('unknown "zorg" variable');
  });
  it('return 301 a b → invalid number of arguments', async () => {
    expect(await refused('  return 301 a b;\n')).toContain('invalid number of arguments in "return" directive');
  });
  it('default_type sans argument → invalid number of arguments', async () => {
    expect(await refused('  default_type;\n')).toContain('invalid number of arguments in "default_type" directive');
  });
  it('default_type deux fois dans le même bloc → is duplicate', async () => {
    expect(await refused('  default_type a/b;\n  default_type c/d;\n')).toContain('"default_type" directive is duplicate');
  });
  it('WITNESS : la configuration livrée reste valide', async () => {
    expect(await refused('')).toContain('successful');
  });
});
