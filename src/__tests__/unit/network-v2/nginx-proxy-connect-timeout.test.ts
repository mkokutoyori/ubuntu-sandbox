/**
 * nginx 1.24.0 : un amont qui NE REPOND PAS donne 504, un amont qui refuse donne 502 (ngx_http_upstream.c :
 * `ngx_http_upstream_connect` / `ngx_http_upstream_next`, `ngx_http_upstream_connect_error` ->
 * NGX_HTTP_UPSTREAM_FT_TIMEOUT -> NGX_HTTP_GATEWAY_TIME_OUT ; NGX_HTTP_UPSTREAM_FT_ERROR -> NGX_HTTP_BAD_GATEWAY).
 *
 * Les lignes d'error.log sont celles de la source : « upstream timed out (110: Connection timed out) while connecting to upstream »,
 * « connect() failed (111: Connection refused) while connecting to upstream », « connect() failed (113: No route to host)
 * while connecting to upstream ». `proxy_connect_timeout` (ngx_conf_set_msec_slot, defaut 60s) refuse un temps invalide.
 *
 * Mesure de depart : tout echec de connexion donnait 502, y compris le silence d'un pare-feu qui DROP ; et la directive etait acceptee
 * sans etre lue.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { labo, demarrer, ecrireConf } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const PROXY = (extra = ''): string =>
  `server {\n  listen 80;\n  location / {\n${extra}    proxy_pass http://10.0.0.2:8080;\n  }\n}\n`;

describe('refus et silence', () => {
  it('un amont qui refuse (RST) : 502 et « connect() failed (111: Connection refused) »', async () => {
    const lab = labo();
    await demarrer(lab, PROXY());
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('502 Bad Gateway');
    const journal = await lab.front.executeCommand('cat /var/log/nginx/error.log');
    expect(journal).toContain('connect() failed (111: Connection refused) while connecting to upstream');
  });

  it('un amont muet (DROP) : 504 et « upstream timed out (110: Connection timed out) »', async () => {
    const lab = labo();
    await lab.back.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j DROP');
    await demarrer(lab, PROXY());
    const page = await lab.back.executeCommand('curl -s http://10.0.0.1/');
    expect(page).toContain('504 Gateway Time-out');
    const journal = await lab.front.executeCommand('cat /var/log/nginx/error.log');
    expect(journal).toContain('upstream timed out (110: Connection timed out) while connecting to upstream');
  });

  it('TEMOIN : un amont qui repond passe toujours', async () => {
    const lab = labo();
    await lab.back.executeCommand(ecrireConf('server {\n  listen 8080;\n  root /var/www/html;\n}\n'));
    await lab.back.executeCommand(`sh -c 'printf "PAGE-AMONT" > /var/www/html/index.html'`);
    await lab.back.executeCommand('systemctl start nginx');
    await demarrer(lab, PROXY());
    expect(await lab.back.executeCommand('curl -s http://10.0.0.1/')).toContain('PAGE-AMONT');
  });
});

describe('proxy_connect_timeout', () => {
  it('un temps valide est accepte', async () => {
    const lab = labo();
    await demarrer(lab, PROXY('    proxy_connect_timeout 5s;\n'));
    expect(await lab.front.executeCommand('nginx -t')).toContain('successful');
  });

  it('un temps invalide est refuse', async () => {
    const lab = labo();
    await lab.front.executeCommand(ecrireConf(PROXY('    proxy_connect_timeout soon;\n')));
    expect(await lab.front.executeCommand('nginx -t')).toContain('"proxy_connect_timeout" directive invalid value');
  });
});
