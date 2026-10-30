/**
 * nginx 1.24.0 : `proxy_redirect` et le `Location` que le client reçoit.
 *
 * Sources : src/http/modules/ngx_http_proxy_module.c
 * (`ngx_http_proxy_redirect`, `ngx_http_proxy_rewrite_redirect`,
 * `ngx_http_proxy_rewrite_complex_handler`, `..._regex_handler`,
 * `ngx_http_proxy_merge_loc_conf` pour la règle `default` implicite),
 * src/http/ngx_http_upstream.c (`ngx_http_upstream_rewrite_location`,
 * `..._refresh`) et src/http/ngx_http_header_filter_module.c (un
 * `Location` posé par nginx qui commence par `/` devient absolu, selon
 * `absolute_redirect`, `server_name_in_redirect`, `port_in_redirect`).
 *
 * Mesuré avant le correctif : le mandataire laissait traverser le
 * `Location` de l'amont tel quel (docs/PRD-Nginx.md §9.5, « `proxy_redirect`
 * n'est pas appliqué »), directive acceptée dans ACCEPTED_INERT. Le client
 * suivait donc une redirection vers `http://10.0.0.2:9000/…`, l'adresse
 * INTERNE de l'amont : exactement la fuite que la directive existe pour
 * empêcher. Pire, le défaut de nginx — réécrire sans qu'on l'écrive,
 * d'après le `proxy_pass` — n'existait pas non plus.
 *
 * Deux faits de la source gouvernent la forme des tests :
 *  - la règle `default` est AJOUTÉE par nginx quand aucune règle n'est
 *    écrite et que `proxy_pass` est une URL littérale ; dès qu'une règle
 *    est écrite, elle ne l'est plus ;
 *  - une réécriture qui réussit fait un `Location` RELATIF (`/landing`)
 *    que le filtre d'en-têtes rend absolu avec le `Host` de la requête ;
 *    un `Location` que rien n'a réécrit n'est jamais touché.
 *
 * Discrimination par `git stash` : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';
import { demarrer, labo, type Labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const UPSTREAM = 'http://10.0.0.2:9000';

const started = new WeakSet<Labo>();

function amont(lab: Labo): void {
  if (started.has(lab)) return;
  started.add(lab);
  new Http1ServerSession(lab.back.getTcpStack(), 9000, (req) => {
    const target = req.target ?? '/';
    const redirect = (location: string) => {
      const res = createResponse(302, 'Found');
      res.headers.set('Location', location);
      return res;
    };
    const table: Record<string, string> = {
      '/redir': `${UPSTREAM}/landing`,
      '/v1/redir': `${UPSTREAM}/v1/landing`,
      '/other': 'http://elsewhere.example/landing',
      '/rel': '/landing',
      '/upper': 'HTTP://10.0.0.2:9000/landing',
      '/port': 'http://10.0.0.2:9001/landing',
    };
    if (table[target] !== undefined) return redirect(table[target]);
    const res = createResponse(200, 'OK');
    res.headers.set('Content-Type', 'text/plain');
    if (target === '/refresh') res.headers.set('Refresh', `0; url=${UPSTREAM}/landing`);
    if (target === '/norefresh') res.headers.set('Refresh', '5');
    res.body = new TextEncoder().encode('corps-amont');
    return res;
  }).start();
}

const SERVER = (inside: string, listen = 80, outside = '') => `${outside}server {
  listen ${listen};
${inside}}
`;

const PASS = (extra = '', pass = UPSTREAM) => `  location / {
    proxy_pass ${pass};
${extra}  }
`;

async function headers(
  lab: Labo, conf: string, path: string, port = 80,
): Promise<string> {
  amont(lab);
  await demarrer(lab, conf);
  const authority = port === 80 ? '10.0.0.1' : `10.0.0.1:${port}`;
  await lab.back.executeCommand(`curl -s -D /tmp/h -o /dev/null http://${authority}${path}`);
  return lab.back.executeCommand('cat /tmp/h');
}

async function location(lab: Labo, conf: string, path: string, port = 80): Promise<string | null> {
  const line = (await headers(lab, conf, path, port)).split('\n').find((l) => l.startsWith('Location:'));
  return line === undefined ? null : line.slice('Location: '.length).trim();
}

describe('la règle `default`, ajoutée par nginx sans qu\'on l\'écrive', () => {
  it('http://amont/landing devient http://<Host>/landing', async () => {
    expect(await location(labo(), SERVER(PASS()), '/redir')).toBe('http://10.0.0.1/landing');
  });

  it('le port d\'écoute non standard figure dans le Location (port_in_redirect on)', async () => {
    expect(await location(labo(), SERVER(PASS(), 8080), '/redir', 8080))
      .toBe('http://10.0.0.1:8080/landing');
  });

  it('port_in_redirect off retire le port', async () => {
    expect(await location(labo(), SERVER('  port_in_redirect off;\n' + PASS(), 8080), '/redir', 8080))
      .toBe('http://10.0.0.1/landing');
  });

  it('server_name_in_redirect on met le premier server_name à la place du Host', async () => {
    const conf = SERVER('  server_name front.lan;\n  server_name_in_redirect on;\n' + PASS());
    expect(await location(labo(), conf, '/redir')).toBe('http://front.lan/landing');
  });

  it('absolute_redirect off laisse le Location relatif', async () => {
    expect(await location(labo(), SERVER('  absolute_redirect off;\n' + PASS()), '/redir')).toBe('/landing');
  });

  it('un proxy_pass avec URI : le préfixe de l\'amont est remplacé par celui de la location', async () => {
    const conf = SERVER('  location /app/ {\n    proxy_pass http://10.0.0.2:9000/v1/;\n  }\n');
    expect(await location(labo(), conf, '/app/redir')).toBe('http://10.0.0.1/app/landing');
  });

  it('un autre hôte n\'est pas touché', async () => {
    expect(await location(labo(), SERVER(PASS()), '/other')).toBe('http://elsewhere.example/landing');
  });

  it('un autre PORT du même hôte n\'est pas touché (le motif est l\'URL entière)', async () => {
    expect(await location(labo(), SERVER(PASS()), '/port')).toBe('http://10.0.0.2:9001/landing');
  });

  it('la comparaison est sensible à la casse (ngx_rstrncmp)', async () => {
    expect(await location(labo(), SERVER(PASS()), '/upper')).toBe('HTTP://10.0.0.2:9000/landing');
  });

  it('un Location RELATIF venant de l\'amont traverse tel quel, jamais rendu absolu', async () => {
    expect(await location(labo(), SERVER(PASS()), '/rel')).toBe('/landing');
  });

  it('WITNESS : un corps et un statut sans redirection traversent inchangés', async () => {
    const lab = labo();
    amont(lab);
    await demarrer(lab, SERVER(PASS()));
    const out = await lab.back.executeCommand('curl -s -i http://10.0.0.1/ok');
    expect(out).toContain('200 OK');
    expect(out).toContain('corps-amont');
    expect(out).not.toContain('Location:');
  });
});

describe('proxy_redirect off', () => {
  it('rend tous les Location tels que l\'amont les a écrits', async () => {
    const conf = SERVER(PASS('    proxy_redirect off;\n'));
    expect(await location(labo(), conf, '/redir')).toBe(`${UPSTREAM}/landing`);
  });
});

describe('proxy_redirect <motif> <remplacement>', () => {
  it('remplace le préfixe, puis le Location est rendu absolu', async () => {
    const conf = SERVER(PASS(`    proxy_redirect ${UPSTREAM}/ /portal/;\n`));
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/portal/landing');
  });

  it('un remplacement absolu est écrit tel quel', async () => {
    const conf = SERVER(PASS(`    proxy_redirect ${UPSTREAM}/ https://public.example/;\n`));
    expect(await location(labo(), conf, '/redir')).toBe('https://public.example/landing');
  });

  it('dès qu\'une règle est écrite, la règle par défaut n\'est PLUS ajoutée', async () => {
    const conf = SERVER(PASS('    proxy_redirect http://rien.example/ /x/;\n'));
    expect(await location(labo(), conf, '/redir')).toBe(`${UPSTREAM}/landing`);
  });

  it('la première règle qui correspond l\'emporte', async () => {
    const conf = SERVER(PASS(`    proxy_redirect ${UPSTREAM}/ /premiere/;\n    proxy_redirect ${UPSTREAM}/ /seconde/;\n`));
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/premiere/landing');
  });

  it('une règle qui ne correspond pas laisse la suivante essayer', async () => {
    const conf = SERVER(PASS(`    proxy_redirect http://rien.example/ /x/;\n    proxy_redirect ${UPSTREAM}/ /ok/;\n`));
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/ok/landing');
  });

  it('proxy_redirect default; rétablit la règle implicite à côté des autres', async () => {
    const conf = SERVER(PASS('    proxy_redirect http://elsewhere.example/ /ext/;\n    proxy_redirect default;\n'));
    const lab = labo();
    expect(await location(lab, conf, '/redir')).toBe('http://10.0.0.1/landing');
    expect(await location(lab, conf, '/other')).toBe('http://10.0.0.1/ext/landing');
  });

  it('une variable du remplacement est évaluée ($host)', async () => {
    const conf = SERVER(PASS(`    proxy_redirect ${UPSTREAM}/ https://$host/secure/;\n`));
    expect(await location(labo(), conf, '/redir')).toBe('https://10.0.0.1/secure/landing');
  });

  it('un motif PCRE (~) et ses captures $1 $2', async () => {
    const conf = SERVER(PASS('    proxy_redirect ~^http://10\\.0\\.0\\.2:(\\d+)/(.*)$ /via-$1/$2;\n'));
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/via-9000/landing');
  });

  it('une capture nommée', async () => {
    const conf = SERVER(PASS('    proxy_redirect ~^http://(?<h>[^:/]+):9000/(?<p>.*)$ /n-$h/$p;\n'));
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/n-10.0.0.2/landing');
  });

  it('~ est sensible à la casse, ~* ne l\'est pas', async () => {
    const motif = '^HTTP://10\\.0\\.0\\.2:9000/(.*)$';
    expect(await location(labo(), SERVER(PASS(`    proxy_redirect ~${motif} /ci/$1;\n`)), '/redir'))
      .toBe(`${UPSTREAM}/landing`);
    EquipmentRegistry.getInstance().clear();
    expect(await location(labo(), SERVER(PASS(`    proxy_redirect ~*${motif} /ci/$1;\n`)), '/redir'))
      .toBe('http://10.0.0.1/ci/landing');
  });
});

describe('héritage http → server → location', () => {
  it('une règle du server s\'applique à une location qui n\'en écrit pas', async () => {
    const conf = SERVER(`  proxy_redirect ${UPSTREAM}/ /hérité/;\n` + PASS());
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/hérité/landing');
  });

  it('une règle de la location REMPLACE celle du server', async () => {
    const conf = SERVER(`  proxy_redirect ${UPSTREAM}/ /server/;\n` + PASS(`    proxy_redirect ${UPSTREAM}/ /location/;\n`));
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/location/landing');
  });

  it('proxy_redirect off dans la location coupe la règle héritée', async () => {
    const conf = SERVER(`  proxy_redirect ${UPSTREAM}/ /server/;\n` + PASS('    proxy_redirect off;\n'));
    expect(await location(labo(), conf, '/redir')).toBe(`${UPSTREAM}/landing`);
  });

  it('une règle du bloc http s\'applique à tous les server', async () => {
    const conf = SERVER(PASS(), 80, `proxy_redirect ${UPSTREAM}/ /http/;\n`);
    expect(await location(labo(), conf, '/redir')).toBe('http://10.0.0.1/http/landing');
  });
});

describe('l\'en-tête Refresh (ngx_http_upstream_rewrite_refresh)', () => {
  it('seule la partie url= est réécrite, et reste RELATIVE (le filtre ne touche que Location)', async () => {
    const out = await headers(labo(), SERVER(PASS()), '/refresh');
    expect(out).toContain('Refresh: 0; url=/landing');
  });

  it('un Refresh sans url= traverse', async () => {
    expect(await headers(labo(), SERVER(PASS()), '/norefresh')).toContain('Refresh: 5');
  });

  it('proxy_redirect off laisse l\'url= de l\'amont', async () => {
    const out = await headers(labo(), SERVER(PASS('    proxy_redirect off;\n')), '/refresh');
    expect(out).toContain(`Refresh: 0; url=${UPSTREAM}/landing`);
  });
});

describe('return 30x : le même filtre d\'en-têtes rend le Location absolu', () => {
  const RETURN = (target: string) => SERVER(`  location /old { return 301 ${target}; }\n`);

  it('return 301 /nouveau → http://<Host>/nouveau', async () => {
    expect(await location(labo(), RETURN('/nouveau'), '/old')).toBe('http://10.0.0.1/nouveau');
  });

  it('return 301 avec une URL absolue est écrit tel quel', async () => {
    expect(await location(labo(), RETURN('http://ailleurs.example/x'), '/old')).toBe('http://ailleurs.example/x');
  });

  it('absolute_redirect off garde le chemin relatif', async () => {
    const conf = SERVER('  absolute_redirect off;\n  location /old { return 301 /nouveau; }\n');
    expect(await location(labo(), conf, '/old')).toBe('/nouveau');
  });
});

describe('nginx -t juge proxy_redirect et les directives de redirection', () => {
  const refused = async (inside: string, outside = ''): Promise<string> => {
    const lab = labo();
    const { ecrireConf } = await import('./_nginxProxyLab');
    await lab.front.executeCommand(ecrireConf(SERVER(inside, 80, outside)));
    return lab.front.executeCommand('nginx -t');
  };

  it('un seul mot qui n\'est ni off ni default → invalid parameter', async () => {
    expect(await refused(PASS('    proxy_redirect zorglub;\n'))).toContain('invalid parameter "zorglub"');
  });
  it('aucun argument → invalid number of arguments', async () => {
    expect(await refused(PASS('    proxy_redirect;\n'))).toContain('invalid number of arguments in "proxy_redirect" directive');
  });
  it('trois arguments → invalid number of arguments', async () => {
    expect(await refused(PASS('    proxy_redirect a b c;\n'))).toContain('invalid number of arguments in "proxy_redirect" directive');
  });
  it('default avant proxy_pass → should be placed after the "proxy_pass" directive', async () => {
    const conf = '  location / {\n    proxy_redirect default;\n    proxy_pass http://10.0.0.2:9000;\n  }\n';
    expect(await refused(conf)).toContain('"proxy_redirect default" should be placed after the "proxy_pass" directive');
  });
  it('default au niveau server (aucun proxy_pass) → même refus', async () => {
    expect(await refused('  proxy_redirect default;\n')).toContain('should be placed after the "proxy_pass" directive');
  });
  it('off après une règle → is duplicate', async () => {
    expect(await refused(PASS('    proxy_redirect a /b/;\n    proxy_redirect off;\n'))).toContain('"proxy_redirect" directive is duplicate');
  });
  it('une règle après off → is duplicate', async () => {
    expect(await refused(PASS('    proxy_redirect off;\n    proxy_redirect a /b/;\n'))).toContain('"proxy_redirect" directive is duplicate');
  });
  it('un motif PCRE invalide → pcre2_compile() failed', async () => {
    expect(await refused(PASS('    proxy_redirect ~( /x/;\n'))).toContain('pcre2_compile() failed');
  });
  it('une variable inconnue dans le remplacement → unknown "zorg" variable', async () => {
    expect(await refused(PASS('    proxy_redirect a $zorg;\n'))).toContain('unknown "zorg" variable');
  });
  it('port_in_redirect maybe → invalid value, it must be "on" or "off"', async () => {
    expect(await refused('  port_in_redirect maybe;\n')).toContain('invalid value "maybe" in "port_in_redirect" directive, it must be "on" or "off"');
  });
  it('absolute_redirect deux fois dans le même bloc → is duplicate', async () => {
    expect(await refused('  absolute_redirect on;\n  absolute_redirect off;\n')).toContain('"absolute_redirect" directive is duplicate');
  });
  it('WITNESS : une configuration valide passe', async () => {
    expect(await refused(PASS(`    proxy_redirect ${UPSTREAM}/ /x/;\n    proxy_redirect default;\n`))).toContain('successful');
  });
});
