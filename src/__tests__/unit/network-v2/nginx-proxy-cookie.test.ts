/**
 * nginx 1.24.0 : `proxy_cookie_domain` et `proxy_cookie_path` (ngx_http_proxy_module.c : `ngx_http_proxy_rewrite_cookie`,
 * `ngx_http_proxy_rewrite_domain_handler`, `ngx_http_proxy_rewrite_complex_handler`, `ngx_http_proxy_rewrite_regex_handler`,
 * `ngx_http_proxy_rewrite`, `ngx_http_proxy_cookie_domain`, `ngx_http_proxy_cookie_path`).
 *
 * Ce que la source fixe : seuls les attributs `Domain` et `Path` d'un `Set-Cookie` de l'AMONT sont lus ; la premiere regle qui
 * correspond gagne ; le domaine se compare en entier et sans casse, un point de tete (dans le cookie, le motif et le remplacement)
 * etant ignore et conserve ; le chemin se compare par PREFIXE, avec casse ; `~` et `~*` sont des expressions regulieres qui
 * remplacent la valeur ENTIERE ; un cookie dont rien ne correspond est laisse tel quel, un cookie reecrit est recompose avec
 * « ; » comme separateur ; `off` coupe la reecriture ; une seule forme `off` par niveau, deux arguments sinon.
 *
 * Mesure de depart : les deux directives etaient refusees ou ignorees, le cookie de l'amont traversait inchange.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';
import { demarrer, labo, ecrireConf, type Labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const started = new WeakSet<Labo>();

function amont(lab: Labo): void {
  if (started.has(lab)) return;
  started.add(lab);
  new Http1ServerSession(lab.back.getTcpStack(), 9000, () => {
    const res = createResponse(200, 'OK');
    res.headers.set('Content-Type', 'text/plain');
    res.headers.append('Set-Cookie', 'sid=abc; Domain=.backend.local; Path=/app/x; HttpOnly');
    res.headers.append('Set-Cookie', 'lang=fr; Path=/Other');
    res.body = new TextEncoder().encode('corps-amont');
    return res;
  }).start();
}

const SITE = (inside: string): string => `server {
  listen 80;
  location /app/ {
${inside}    proxy_pass http://10.0.0.2:9000;
  }
}
`;

async function cookies(inside: string): Promise<string[]> {
  const lab = labo();
  amont(lab);
  await demarrer(lab, SITE(inside));
  const out = await lab.back.executeCommand('curl -s -i http://10.0.0.1/app/p');
  return out.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().startsWith('set-cookie:')).map((l) => l.slice(11).trim());
}

describe('proxy_cookie_domain', () => {
  it('remplace le domaine en entier et garde le point de tete', async () => {
    const out = await cookies('    proxy_cookie_domain backend.local front.example;\n');
    expect(out[0]).toBe('sid=abc; Domain=.front.example; Path=/app/x; HttpOnly');
  });

  it('la comparaison ignore la casse', async () => {
    const out = await cookies('    proxy_cookie_domain BACKEND.LOCAL front.example;\n');
    expect(out[0]).toContain('Domain=.front.example');
  });

  it('un domaine qui ne correspond pas laisse le cookie intact', async () => {
    const out = await cookies('    proxy_cookie_domain other.local front.example;\n');
    expect(out[0]).toBe('sid=abc; Domain=.backend.local; Path=/app/x; HttpOnly');
  });

  it('une expression reguliere remplace la valeur entiere', async () => {
    const out = await cookies('    proxy_cookie_domain ~\\.(\\w+)\\.local$ edge-$1.example;\n');
    expect(out[0]).toContain('Domain=edge-backend.example');
  });

  it('la premiere regle qui correspond gagne', async () => {
    const out = await cookies('    proxy_cookie_domain backend.local first.example;\n    proxy_cookie_domain backend.local second.example;\n');
    expect(out[0]).toContain('Domain=.first.example');
  });
});

describe('proxy_cookie_path', () => {
  it('remplace le PREFIXE du chemin', async () => {
    const out = await cookies('    proxy_cookie_path /app/ /;\n');
    expect(out[0]).toBe('sid=abc; Domain=.backend.local; Path=/x; HttpOnly');
  });

  it('la comparaison du chemin tient compte de la casse', async () => {
    const out = await cookies('    proxy_cookie_path /other /replaced;\n');
    expect(out[1]).toBe('lang=fr; Path=/Other');
    const sensible = await cookies('    proxy_cookie_path /Other /replaced;\n');
    expect(sensible[1]).toBe('lang=fr; Path=/replaced');
  });

  it('~* ignore la casse et remplace la valeur entiere', async () => {
    const out = await cookies('    proxy_cookie_path ~*^/other /gone;\n');
    expect(out[1]).toBe('lang=fr; Path=/gone');
  });
});

describe('off et validation', () => {
  it("off seul coupe la reecriture", async () => {
    const out = await cookies('    proxy_cookie_domain off;\n');
    expect(out[0]).toContain('Domain=.backend.local');
  });

  it('off apres une regle est un doublon, comme dans la source', async () => {
    const lab = labo();
    await lab.front.executeCommand(ecrireConf(SITE('    proxy_cookie_domain a b;\n    proxy_cookie_domain off;\n')));
    expect(await lab.front.executeCommand('nginx -t')).toContain('"proxy_cookie_domain" directive is duplicate');
  });

  it('un seul argument autre que off est refuse', async () => {
    const lab = labo();
    await lab.front.executeCommand(ecrireConf(SITE('    proxy_cookie_path whatever;\n')));
    expect(await lab.front.executeCommand('nginx -t')).toContain('invalid parameter "whatever"');
  });

  it('TEMOIN : sans directive, le cookie traverse inchange', async () => {
    const out = await cookies('');
    expect(out[0]).toBe('sid=abc; Domain=.backend.local; Path=/app/x; HttpOnly');
    expect(out).toHaveLength(2);
  });
});
