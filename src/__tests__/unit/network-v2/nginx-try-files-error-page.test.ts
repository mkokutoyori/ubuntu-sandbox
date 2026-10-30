/**
 * nginx 1.24.0 : `try_files`, `error_page`, redirections internes et
 * gestionnaire statique.
 *
 * Sources : ngx_http_try_files_module.c (`ngx_http_try_files_handler`,
 * `ngx_http_try_files`), ngx_http_core_module.c (`ngx_http_core_error_page`,
 * `ngx_http_internal_redirect`, `ngx_http_named_location`),
 * ngx_http_special_response.c (`ngx_http_send_error_page`),
 * ngx_http_static_module.c (`ngx_http_static_handler`),
 * ngx_http_index_module.c.
 *
 * Mesuré avant le correctif : `try_files` et `error_page` étaient classées
 * « appliquées » et lues par personne (le nginx.conf livré écrit
 * `try_files $uri $uri/ =404;` sans qu'il décide de rien) ; le répertoire
 * sans `/` final était servi au lieu d'être redirigé en 301 ; le fichier
 * d'index était servi sans repasser par le choix de la location ; PUT et
 * DELETE sur un fichier recevaient 200 ; le mandataire OUBLIAIT la query
 * string (`/search?q=1` arrivait à l'amont comme `/search`).
 *
 * Discrimination par `git stash -u` de src/network : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';
import { sh, machine } from './_httpsLab';
import { up, site, SERVER } from './_nginxLab';
import { demarrer, labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const URL = 'http://localhost';

const raw = (srv: LinuxServer, path: string, flags = ''): Promise<string> =>
  sh(srv, `curl -s -i ${flags} '${URL}${path}'`);
const status = (out: string): string => out.split('\n')[0].trim();
const body = (out: string): string => out.split('\r\n\r\n').slice(1).join('\r\n\r\n') || out.split('\n\n').slice(1).join('\n\n');

async function withSite(extra: string, files: Record<string, string> = {}): Promise<LinuxServer> {
  const srv = await up(extra);
  await sh(srv, 'mkdir -p /var/www/html/sub /var/www/html/empty');
  await sh(srv, `sh -c 'printf "SUBPAGE" > /var/www/html/sub/index.nginx-debian.html'`);
  for (const [path, content] of Object.entries(files)) {
    await sh(srv, `sh -c 'printf "${content}" > /var/www/html${path}'`);
  }
  return srv;
}

describe('try_files', () => {
  const DEFAULT = '  location / { try_files $uri $uri/ =404; }\n';

  it('un fichier existant est servi', async () => {
    const srv = await withSite(DEFAULT);
    expect(body(await raw(srv, '/tiny.html'))).toBe('hi');
  });

  it('$uri/ : « /sub/ » (avec « / ») est servi par l\'index', async () => {
    const srv = await withSite(DEFAULT);
    const out = await raw(srv, '/sub/');
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(body(out)).toBe('SUBPAGE');
  });

  it('$uri/ : « /sub » (sans « / ») → 301, l\'URI est posée sans « / » puis le gestionnaire statique redirige', async () => {
    const srv = await withSite(DEFAULT);
    const out = await raw(srv, '/sub');
    expect(status(out)).toBe('HTTP/1.1 301 Moved Permanently');
    expect(out).toContain('Location: http://localhost/sub/');
  });

  it('rien ne correspond → =404 rend la page de nginx', async () => {
    const srv = await withSite(DEFAULT);
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 404 Not Found');
    expect(out).toContain('<h1>404 Not Found</h1>');
  });

  it('un fichier est cherché comme FICHIER : « $uri/ » ne retient pas un fichier ordinaire', async () => {
    const srv = await withSite('  location / { try_files $uri/ =404; }\n');
    expect(status(await raw(srv, '/tiny.html'))).toBe('HTTP/1.1 404 Not Found');
  });

  it('« $uri » ne retient pas un répertoire (il faut le « / » final)', async () => {
    const srv = await withSite('  location / { try_files $uri =404; }\n');
    expect(status(await raw(srv, '/sub'))).toBe('HTTP/1.1 404 Not Found');
  });

  it('repli sur une URI : le front d\'une application monopage', async () => {
    const srv = await withSite('  location / { try_files $uri /index.html; }\n', { '/index.html': 'SPA' });
    const out = await raw(srv, '/a/b/c');
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(body(out)).toBe('SPA');
  });

  it('la première entrée qui existe l\'emporte', async () => {
    const srv = await withSite('  location / { try_files /b.html /a.html =404; }\n', { '/a.html': 'A', '/b.html': 'B' });
    expect(body(await raw(srv, '/quelconque'))).toBe('B');
  });

  it('repli sur un code : =503 rend la page 503', async () => {
    const srv = await withSite('  location / { try_files $uri =503; }\n');
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 503 Service Temporarily Unavailable');
    expect(out).toContain('<h1>503 Service Temporarily Unavailable</h1>');
  });

  it('repli sur une location nommée', async () => {
    const srv = await withSite('  location / { try_files $uri @fb; }\n  location @fb { return 200 "repli-nomme"; }\n');
    expect(body(await raw(srv, '/absent'))).toBe('repli-nomme');
  });

  it('un try_files du server est hérité par une location qui n\'en écrit pas', async () => {
    const srv = await withSite('  try_files $uri /index.html;\n  location /x/ { }\n', { '/index.html': 'HERITE' });
    expect(body(await raw(srv, '/x/inconnu'))).toBe('HERITE');
  });

  it('un cycle de redirections internes : 500 et la ligne d\'error.log de nginx', async () => {
    const srv = await withSite('  location / { try_files /nope /again; }\n');
    const out = await raw(srv, '/x');
    expect(status(out)).toBe('HTTP/1.1 500 Internal Server Error');
    const log = await sh(srv, 'cat /var/log/nginx/error.log');
    expect(log).toContain('rewrite or internal redirection cycle while internally redirecting to "/again"');
  });
});

describe('gestionnaire statique', () => {
  it('un répertoire sans « / » final : 301 vers le « / » final, URL absolue, query conservée', async () => {
    const srv = await withSite('  location / { }\n');
    const out = await raw(srv, '/sub?a=1');
    expect(status(out)).toBe('HTTP/1.1 301 Moved Permanently');
    expect(out).toContain('Location: http://localhost/sub/?a=1');
    expect(out).toContain('<h1>301 Moved Permanently</h1>');
  });

  it('le répertoire avec « / » final est servi par son index', async () => {
    const srv = await withSite('  location / { }\n');
    expect(body(await raw(srv, '/sub/'))).toBe('SUBPAGE');
  });

  it('l\'index repasse par le choix de la location (redirection interne)', async () => {
    const srv = await withSite('  location / { }\n  location = /sub/index.nginx-debian.html { return 200 "exacte"; }\n');
    expect(body(await raw(srv, '/sub/'))).toBe('exacte');
  });

  it('un répertoire sans index ni autoindex : 403', async () => {
    const srv = await withSite('  location / { }\n');
    expect(status(await raw(srv, '/empty/'))).toBe('HTTP/1.1 403 Forbidden');
  });

  it('autoindex on liste le répertoire', async () => {
    const srv = await withSite('  location / { autoindex on; }\n');
    await sh(srv, `sh -c 'printf "x" > /var/www/html/empty/visible.txt'`);
    const out = await raw(srv, '/empty/');
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(out).toContain('visible.txt');
  });

  for (const method of ['DELETE', 'PUT', 'POST']) {
    it(`${method} sur un fichier : 405 « Not Allowed »`, async () => {
      const srv = await withSite('  location / { }\n');
      const out = await sh(srv, `curl -s -i -X ${method} ${URL}/tiny.html`);
      expect(status(out)).toBe('HTTP/1.1 405 Not Allowed');
      expect(out).toContain('<h1>405 Not Allowed</h1>');
    });
  }

  it('WITNESS : GET et HEAD servent le fichier', async () => {
    const srv = await withSite('  location / { }\n');
    expect(status(await raw(srv, '/tiny.html'))).toBe('HTTP/1.1 200 OK');
    expect(await sh(srv, `curl -s -I ${URL}/tiny.html`)).toContain('200 OK');
  });
});

describe('error_page', () => {
  const PAGE = { '/404.html': 'PAGE-404', '/50x.html': 'PAGE-50X' };

  it('error_page 404 /404.html : le corps du fichier, le statut reste 404', async () => {
    const srv = await withSite('  error_page 404 /404.html;\n', PAGE);
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 404 Not Found');
    expect(body(out)).toBe('PAGE-404');
    expect(out).toContain('Content-Type: text/html');
  });

  it('=200 : le même corps avec un autre statut', async () => {
    const srv = await withSite('  error_page 404 =200 /404.html;\n', PAGE);
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 200 OK');
    expect(body(out)).toBe('PAGE-404');
  });

  it('« = » seul : le statut de la page de remplacement', async () => {
    const srv = await withSite('  error_page 404 = /404.html;\n', PAGE);
    expect(status(await raw(srv, '/absent'))).toBe('HTTP/1.1 200 OK');
  });

  it('plusieurs codes pour une page', async () => {
    const srv = await withSite(
      '  error_page 500 502 503 504 /50x.html;\n  location /boom { return 503; }\n', PAGE);
    const out = await raw(srv, '/boom');
    expect(status(out)).toBe('HTTP/1.1 503 Service Temporarily Unavailable');
    expect(body(out)).toBe('PAGE-50X');
  });

  it('une URL externe : redirection 302', async () => {
    const srv = await withSite('  error_page 404 http://example.org/nf;\n');
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 302 Moved Temporarily');
    expect(out).toContain('Location: http://example.org/nf');
  });

  it('une location nommée', async () => {
    const srv = await withSite('  error_page 404 @nf;\n  location @nf { return 200 "nomme"; }\n');
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 404 Not Found');
    expect(body(out)).toBe('nomme');
  });

  it('une page de remplacement absente : sa propre erreur, sans récursion', async () => {
    const srv = await withSite('  error_page 404 /404.html;\n');
    const out = await raw(srv, '/absent');
    expect(status(out)).toBe('HTTP/1.1 404 Not Found');
    expect(out).toContain('<h1>404 Not Found</h1>');
  });

  it('héritage : la liste d\'une location REMPLACE celle du server', async () => {
    const srv = await withSite(
      '  error_page 404 /404.html;\n  location /l/ { error_page 404 /50x.html; }\n', PAGE);
    expect(body(await raw(srv, '/absent'))).toBe('PAGE-404');
    expect(body(await raw(srv, '/l/absent'))).toBe('PAGE-50X');
  });

  it('un code qui n\'est pas listé n\'est pas touché', async () => {
    const srv = await withSite('  error_page 500 /50x.html;\n', PAGE);
    expect(body(await raw(srv, '/absent'))).not.toBe('PAGE-50X');
  });

  it('la page traite la requête en GET (une méthode inconnue ne la casse pas)', async () => {
    const srv = await withSite('  error_page 405 /404.html;\n', PAGE);
    const out = await sh(srv, `curl -s -i -X DELETE ${URL}/tiny.html`);
    expect(status(out)).toBe('HTTP/1.1 405 Not Allowed');
    expect(body(out)).toBe('PAGE-404');
  });
});

describe('error_page et le mandataire', () => {
  it('une erreur de l\'AMONT traverse (pas de proxy_intercept_errors), un 502 de nginx est intercepté', async () => {
    const lab = labo();
    new Http1ServerSession(lab.back.getTcpStack(), 9000, () => {
      const res = createResponse(404, 'Not Found');
      res.headers.set('Content-Type', 'text/plain');
      res.body = new TextEncoder().encode('404-AMONT');
      return res;
    }).start();
    await lab.front.executeCommand(`sh -c 'printf "PAGE-LOCALE" > /var/www/html/404.html'`);
    await demarrer(lab, `server {
  listen 80;
  error_page 404 502 /404.html;
  location /up/ { proxy_pass http://10.0.0.2:9000/; }
  location /mort/ { proxy_pass http://10.0.0.2:9999/; }
}
`);
    const amont = await lab.back.executeCommand('curl -s -i http://10.0.0.1/up/x');
    expect(body(amont)).toBe('404-AMONT');
    const mort = await lab.back.executeCommand('curl -s -i http://10.0.0.1/mort/x');
    expect(status(mort)).toBe('HTTP/1.1 502 Bad Gateway');
    expect(body(mort)).toBe('PAGE-LOCALE');
  });

  it('la query string traverse jusqu\'à l\'amont', async () => {
    const lab = labo();
    const vues: string[] = [];
    new Http1ServerSession(lab.back.getTcpStack(), 9000, (req) => {
      vues.push(req.target ?? '');
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode('ok');
      return res;
    }).start();
    await demarrer(lab, 'server {\n  listen 80;\n  location / { proxy_pass http://10.0.0.2:9000; }\n}\n');
    await lab.back.executeCommand("curl -s 'http://10.0.0.1/search?q=1&r=2'");
    expect(vues).toEqual(['/search?q=1&r=2']);
  });
});

describe('nginx -t juge try_files et error_page', () => {
  const refused = async (extra: string): Promise<string> => {
    const srv = machine();
    await site(srv, SERVER(extra));
    return sh(srv, 'nginx -t');
  };

  it('try_files avec un seul argument → invalid number of arguments', async () => {
    expect(await refused('  location / { try_files $uri; }\n')).toContain('invalid number of arguments in "try_files" directive');
  });
  it('try_files =abc → invalid code "=abc"', async () => {
    expect(await refused('  location / { try_files $uri =abc; }\n')).toContain('invalid code "=abc"');
  });
  it('try_files =1000 → invalid code', async () => {
    expect(await refused('  location / { try_files $uri =1000; }\n')).toContain('invalid code "=1000"');
  });
  it('try_files deux fois → is duplicate', async () => {
    expect(await refused('  location / { try_files $uri =404; try_files $uri =403; }\n')).toContain('"try_files" directive is duplicate');
  });
  it('try_files avec une variable inconnue → unknown "zorg" variable', async () => {
    expect(await refused('  location / { try_files $zorg =404; }\n')).toContain('unknown "zorg" variable');
  });
  it('error_page avec un seul argument → invalid number of arguments', async () => {
    expect(await refused('  error_page 404;\n')).toContain('invalid number of arguments in "error_page" directive');
  });
  it('error_page abc /x → invalid value "abc"', async () => {
    expect(await refused('  error_page abc /x;\n')).toContain('invalid value "abc"');
  });
  it('error_page 200 /x → value "200" must be between 300 and 599', async () => {
    expect(await refused('  error_page 200 /x;\n')).toContain('value "200" must be between 300 and 599');
  });
  it('error_page 404 =abc /x → invalid value "=abc"', async () => {
    expect(await refused('  error_page 404 =abc /x;\n')).toContain('invalid value "=abc"');
  });
  it('error_page =404 /x (le « = » en premier) → invalid value "=404"', async () => {
    expect(await refused('  error_page =404 /x;\n')).toContain('invalid value "=404"');
  });
  it('WITNESS : une configuration valide passe', async () => {
    expect(await refused('  error_page 404 =200 /x;\n  location / { try_files $uri $uri/ =404; }\n')).toContain('successful');
  });
});
