/**
 * nginx 1.24.0 : les variables des valeurs complexes (`proxy_set_header`,
 * remplacement de `proxy_redirect`) — ngx_http_script.c, ngx_http_variables.c.
 *
 * Mesuré avant le correctif : `expandProxyVariables` enchaînait des
 * `.replace(/\$host/g, …)` dans le désordre. `$hostname`, que le simulateur
 * ne connaît pas, devenait `10.0.0.1name` (le préfixe `$host` mangé), et
 * `$scheme` valait toujours `http`, TLS compris. Une seule table, lue par un
 * seul découpage en jetons (`$nom` ou `${nom}`), répond maintenant.
 *
 * Discrimination par `git stash -u` de src/network : le module n'existe pas,
 * les 14 cas tombent (échec de chargement). Aucun ne passe des deux côtés.
 */
import { describe, it, expect } from 'vitest';
import { createRequest } from '@/network/http/semantics/types';
import {
  expandNginxVariables, hostWithoutPort, isKnownNginxVariable, unknownNginxVariable,
  type NginxVariableContext,
} from '@/network/devices/linux/http/nginx/NginxVariables';

function context(overrides: Partial<NginxVariableContext> = {}, headers: Record<string, string> = {}): NginxVariableContext {
  const request = createRequest('GET', '/a/b?x=1');
  request.headers.set('Host', 'www.example:8080');
  for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
  return {
    request, clientIp: '10.1.1.1', secure: false, serverName: 'front.lan', serverPort: 8080,
    upstream: { host: '10.0.0.2', port: 9000 }, ...overrides,
  };
}

describe('découpage en jetons', () => {
  it('$host est le Host SANS port, $http_host l\'est AVEC', () => {
    expect(expandNginxVariables('$host|$http_host', context())).toBe('www.example|www.example:8080');
  });
  it('${host} délimite le nom', () => {
    expect(expandNginxVariables('${host}name', context())).toBe('www.examplename');
  });
  it('une variable inconnue est laissée telle quelle, sans manger le préfixe d\'une connue', () => {
    expect(expandNginxVariables('$hostname', context())).toBe('$hostname');
  });
  it('un texte sans $ est rendu inchangé', () => {
    expect(expandNginxVariables('rien', context())).toBe('rien');
  });
});

describe('les variables', () => {
  it('$scheme suit TLS', () => {
    expect(expandNginxVariables('$scheme', context())).toBe('http');
    expect(expandNginxVariables('$scheme', context({ secure: true }))).toBe('https');
  });
  it('$request_uri garde la requête, $uri la coupe', () => {
    expect(expandNginxVariables('$request_uri $uri', context())).toBe('/a/b?x=1 /a/b');
  });
  it('$server_name, $server_port, $remote_addr, $request_method', () => {
    expect(expandNginxVariables('$server_name:$server_port $remote_addr $request_method', context()))
      .toBe('front.lan:8080 10.1.1.1 GET');
  });
  it('$http_<en-tête> : les soulignés valent des tirets, absent = vide', () => {
    const ctx = context({}, { 'User-Agent': 'curl/8.5.0' });
    expect(expandNginxVariables('[$http_user_agent][$http_referer]', ctx)).toBe('[curl/8.5.0][]');
  });
  it('$proxy_host et $proxy_port décrivent l\'amont', () => {
    expect(expandNginxVariables('$proxy_host $proxy_port', context())).toBe('10.0.0.2:9000 9000');
  });
  it('$proxy_add_x_forwarded_for empile le client derrière la chaîne reçue', () => {
    expect(expandNginxVariables('$proxy_add_x_forwarded_for', context())).toBe('10.1.1.1');
    expect(expandNginxVariables('$proxy_add_x_forwarded_for', context({}, { 'X-Forwarded-For': '1.2.3.4' })))
      .toBe('1.2.3.4, 10.1.1.1');
  });
  it('les captures priment, une capture absente est vide', () => {
    const captures = new Map([['1', 'un'], ['name', 'valeur']]);
    expect(expandNginxVariables('$1|$name|$2', context({ captures }))).toBe('un|valeur|');
  });
});

describe('validation à la lecture de la configuration', () => {
  it('connues : fixes, http_*, chiffres', () => {
    for (const name of ['host', 'http_x_y', '1', 'server_name']) expect(isKnownNginxVariable(name)).toBe(true);
    expect(isKnownNginxVariable('zorg')).toBe(false);
  });
  it('unknownNginxVariable rend la première inconnue, hors captures déclarées', () => {
    expect(unknownNginxVariable('/a/$host/$zorg')).toBe('zorg');
    expect(unknownNginxVariable('/a/$zorg', new Set(['zorg']))).toBeNull();
  });
  it('hostWithoutPort gère IPv6 entre crochets', () => {
    expect(hostWithoutPort('[::1]:80')).toBe('[::1]');
    expect(hostWithoutPort('a.b')).toBe('a.b');
  });
});
