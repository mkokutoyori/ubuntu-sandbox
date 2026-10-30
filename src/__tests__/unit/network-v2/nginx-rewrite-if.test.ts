/**
 * nginx 1.24.0 : le module rewrite -- `set`, `if`, `rewrite`, `break`, `return` executes dans l'ordre (ngx_http_rewrite_module.c :
 * `ngx_http_rewrite`, `ngx_http_rewrite_if`, `ngx_http_rewrite_if_condition`, `ngx_http_rewrite_set` ; ngx_http_script.c :
 * `ngx_http_script_regex_start_code`, `ngx_http_script_regex_end_code`, `ngx_http_script_if_code`, `ngx_http_script_equal_code` ;
 * ngx_http_core_module.c : `ngx_http_core_post_rewrite_phase`).
 *
 * Ce que la source fixe : les directives s'executent dans l'ordre, d'abord au niveau `server` (avant le choix de la location) puis
 * dans la location ; `if` est vrai quand la variable n'est ni vide ni « 0 » ; `~` et `~*` posent $1.. ; `-f -d -e -x` testent un
 * fichier ; un `rewrite` avec drapeau (`last`, `break`, `redirect`, `permanent`) ou vers une URL absolue arrete le script s'il
 * correspond ; sans drapeau le script continue puis l'URI changee relance le choix de la location ; `break` garde la location ;
 * les arguments d'origine sont ajoutes (« & ») sauf si le remplacement finit par « ? » ; au-dela de 10 relances, 500.
 *
 * Mesure de depart : `set`, `rewrite` et `if` etaient refuses ou sans effet.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { sh } from './_httpsLab';
import { up, site, SERVER } from './_nginxLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function get(srv: LinuxServer, target: string, headers: string[] = []): Promise<string> {
  return sh(srv, `curl -s -i ${headers.map((h) => `-H '${h}'`).join(' ')} "http://localhost${target}"`);
}
const status = (out: string): string => out.split('\n')[0].trim();
const body = (out: string): string => {
  const blank = /\r?\n\r?\n/.exec(out);
  return blank === null ? '' : out.slice(blank.index + blank[0].length);
};
const header = (out: string, name: string): string | undefined =>
  out.split('\n').map((l) => l.trim()).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

async function config(directives: string): Promise<string> {
  const srv = await up();
  await site(srv, SERVER(directives));
  return sh(srv, 'nginx -t');
}

describe('set et variables', () => {
  it('set pose une variable lue par return, avec $arg_nom', async () => {
    const srv = await up('  location /v { set $greeting "bonjour"; return 200 "$greeting-$arg_who"; }\n');
    expect(body(await get(srv, '/v?who=zoe'))).toBe('bonjour-zoe');
  });
});

describe('if : conditions', () => {
  it('= et != comparent le texte', async () => {
    const srv = await up('  location /g { if ($arg_x = 1) { return 403; } if ($arg_x != 2) { return 404; } return 200 "ok"; }\n');
    expect(status(await get(srv, '/g?x=1'))).toBe('HTTP/1.1 403 Forbidden');
    expect(status(await get(srv, '/g?x=3'))).toBe('HTTP/1.1 404 Not Found');
    expect(body(await get(srv, '/g?x=2'))).toBe('ok');
  });

  it('une variable seule est vraie si elle n\'est ni vide ni « 0 »', async () => {
    const srv = await up('  location /t { if ($arg_x) { return 403; } return 200 "faux"; }\n');
    expect(status(await get(srv, '/t?x=a'))).toBe('HTTP/1.1 403 Forbidden');
    expect(body(await get(srv, '/t?x=0'))).toBe('faux');
    expect(body(await get(srv, '/t?x='))).toBe('faux');
    expect(body(await get(srv, '/t'))).toBe('faux');
  });

  it('~ pose $1 pour la suite', async () => {
    const srv = await up('  location /user/ { if ($uri ~ "^/user/(\\d+)$") { return 200 "id-$1"; } return 404; }\n');
    expect(body(await get(srv, '/user/42'))).toBe('id-42');
    expect(status(await get(srv, '/user/abc'))).toBe('HTTP/1.1 404 Not Found');
  });

  it('~* ignore la casse, !~ inverse', async () => {
    const srv = await up('  location /ua { if ($http_user_agent ~* MOBILE) { return 200 "mobile"; } if ($http_user_agent !~ curl) { return 200 "autre"; } return 200 "curl"; }\n');
    expect(body(await get(srv, '/ua', ['User-Agent: some mobile phone']))).toBe('mobile');
    expect(body(await get(srv, '/ua', ['User-Agent: curl/8']))).toBe('curl');
    expect(body(await get(srv, '/ua', ['User-Agent: wget']))).toBe('autre');
  });

  it('-f, -e et leur negation testent un fichier', async () => {
    const srv = await up('  location / { if (!-e $document_root$uri) { return 200 "absent"; } if (-f $request_filename) { return 200 "fichier"; } }\n');
    expect(body(await get(srv, '/nofile.txt'))).toBe('absent');
    expect(body(await get(srv, '/tiny.html'))).toBe('fichier');
  });
});

describe('rewrite', () => {
  it('last relance le choix de la location', async () => {
    const srv = await up('  location /old/ { rewrite ^/old/(.*)$ /new/$1 last; }\n  location /new/ { return 200 "new:$uri"; }\n');
    expect(body(await get(srv, '/old/x'))).toBe('new:/new/x');
  });

  it('redirect et permanent donnent 302 et 301 avec un Location absolu', async () => {
    const srv = await up('  location = /a { rewrite ^ /b redirect; }\n  location = /c { rewrite ^ /d permanent; }\n');
    const temporary = await get(srv, '/a');
    expect(status(temporary)).toBe('HTTP/1.1 302 Moved Temporarily');
    expect(header(temporary, 'Location')).toBe('http://localhost/b');
    const permanent = await get(srv, '/c');
    expect(status(permanent)).toBe('HTTP/1.1 301 Moved Permanently');
    expect(header(permanent, 'Location')).toBe('http://localhost/d');
  });

  it('un remplacement qui commence par http:// est un 302 sans drapeau', async () => {
    const srv = await up('  location = /e { rewrite ^ http://example.org$request_uri; }\n');
    const out = await get(srv, '/e');
    expect(status(out)).toBe('HTTP/1.1 302 Moved Temporarily');
    expect(header(out, 'Location')).toBe('http://example.org/e');
  });

  it('sans drapeau le script continue avec l\'URI changee', async () => {
    const srv = await up('  location /n { rewrite ^/n/(.*)$ /m/$1; return 200 "uri=$uri"; }\n');
    expect(body(await get(srv, '/n/x'))).toBe('uri=/m/x');
  });

  it('break garde la location et sert le fichier reecrit', async () => {
    const srv = await up('  location /bk/ { rewrite ^/bk/.*$ /tiny.html break; }\n');
    expect(body(await get(srv, '/bk/zzz'))).toBe('hi');
  });

  it('les arguments d\'origine sont ajoutes, un « ? » final les supprime', async () => {
    const srv = await up('  location = /q { rewrite ^ /dest?z=1 last; }\n  location = /q2 { rewrite ^ /dest? last; }\n  location = /q3 { rewrite ^ /dest last; }\n  location /dest { return 200 "args=$args"; }\n');
    expect(body(await get(srv, '/q?a=2'))).toBe('args=z=1&a=2');
    expect(body(await get(srv, '/q2?a=2'))).toBe('args=');
    expect(body(await get(srv, '/q3?a=2'))).toBe('args=a=2');
  });

  it('un rewrite de niveau server precede le choix de la location', async () => {
    const srv = await up('  rewrite ^/pre$ /tiny.html;\n');
    expect(body(await get(srv, '/pre'))).toBe('hi');
  });

  it('la directive break arrete le script', async () => {
    const srv = await up('  location /b2 { set $x 1; break; return 403; }\n');
    expect(status(await get(srv, '/b2'))).toBe('HTTP/1.1 404 Not Found');
  });

  it('plus de dix relances : 500 et la ligne du journal', async () => {
    const srv = await up('  location /loop { rewrite ^ /loop last; }\n');
    expect(status(await get(srv, '/loop'))).toBe('HTTP/1.1 500 Internal Server Error');
    expect(await sh(srv, 'cat /var/log/nginx/error.log')).toContain('rewrite or internal redirection cycle while processing "/loop"');
  });
});

describe('nginx -t', () => {
  it('une condition qui ne commence pas par « ( » ou une variable', async () => {
    expect(await config('  location / { if (bad) { return 403; } }\n')).toContain('invalid condition "bad"');
  });

  it('un operateur inconnu', async () => {
    expect(await config('  location / { if ($arg_x == 1) { return 403; } }\n')).toContain('unexpected "==" in condition');
  });

  it('un drapeau de rewrite inconnu', async () => {
    expect(await config('  location / { rewrite ^/a /b sideways; }\n')).toContain('invalid parameter "sideways"');
  });

  it('un rewrite sans remplacement', async () => {
    expect(await config('  location / { rewrite ^/a; }\n')).toContain('invalid number of arguments in "rewrite" directive');
  });

  it('set d\'une variable predefinie', async () => {
    expect(await config('  location / { set $host x; }\n')).toContain('the duplicate "host" variable');
  });

  it('if dans if', async () => {
    expect(await config('  location / { if ($arg_x) { if ($arg_y) { return 403; } } }\n')).toContain('"if" directive is not allowed here');
  });

  it('TEMOIN : une configuration valide passe', async () => {
    expect(await config('  location / { if ($arg_x = 1) { return 403; } rewrite ^/a /b last; set $v 1; }\n')).toContain('successful');
  });
});

describe('if : la configuration du bloc (add_header, root, proxy_pass) vaut pour la requete (ngx_http_rewrite_handler / ngx_http_script_if_code : r->loc_conf = le bloc)', () => {
  it('add_header dans un if vrai ; absent sinon', async () => {
    const srv = await up('  location / { if ($arg_cors) { add_header X-Cors yes; } }\n');
    expect(header(await get(srv, '/tiny.html?cors=1'), 'X-Cors')).toBe('yes');
    expect(header(await get(srv, '/tiny.html'), 'X-Cors')).toBeUndefined();
  });

  it('root dans un if change le fichier servi', async () => {
    const srv = await up('  location / { if ($arg_alt) { root /var/www/alt; } }\n');
    await sh(srv, 'mkdir -p /var/www/alt');
    await sh(srv, `sh -c 'printf "alt" > /var/www/alt/tiny.html'`);
    expect(body(await get(srv, '/tiny.html?alt=1'))).toBe('alt');
    expect(body(await get(srv, '/tiny.html'))).toBe('hi');
  });

  it('proxy_pass dans un if envoie la requete a l\'amont', async () => {
    const { labo, demarrer } = await import('./_nginxProxyLab');
    const { Http1ServerSession } = await import('@/network/http/http1/Http1ServerSession');
    const { createResponse } = await import('@/network/http/semantics/types');
    const lab = labo();
    new Http1ServerSession(lab.back.getTcpStack(), 9000, () => {
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode('depuis-l-amont');
      return res;
    }).start();
    await lab.front.executeCommand(`sh -c 'printf "local" > /var/www/html/tiny.html'`);
    await demarrer(lab, 'server {\n  listen 80;\n  root /var/www/html;\n  location / {\n    if ($arg_up) { proxy_pass http://10.0.0.2:9000; }\n  }\n}\n');
    expect(await lab.back.executeCommand('curl -s "http://10.0.0.1/tiny.html?up=1"')).toContain('depuis-l-amont');
    expect(await lab.back.executeCommand('curl -s "http://10.0.0.1/tiny.html"')).toContain('local');
  });

  it('au niveau server, la configuration d\'un if est refusee en le disant', async () => {
    expect(await config('  if ($arg_x) { add_header X-A b; }\n')).toContain('not supported inside "if" at server level');
  });
});
