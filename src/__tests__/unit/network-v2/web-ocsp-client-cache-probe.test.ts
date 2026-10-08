/**
 * Le cache des réponses OCSP pour les certificats CLIENTS suit le serveur web. nginx 1.24 (ngx_event_openssl_stapling.c : ngx_ssl_ocsp_cache_lookup /
 * ngx_ssl_ocsp_cache_store) ne garde un statut que si `ssl_ocsp_cache shared:zone:taille` est configuré, jusqu'à nextUpdate (une heure faute de
 * nextUpdate) ; sans cache, ou avec `off`, chaque poignée de main interroge le répondeur. Apache httpd 2.4.58 (ssl_engine_ocsp.c, verify_ocsp_status)
 * n'a aucun cache pour les certificats clients : chaque connexion interroge le répondeur. Le répondeur est sur une seconde machine, que l'on ferme par
 * iptables.
 *
 * MESURÉ avant correctif : `ssl_ocsp_cache` était lu sans effet et le serveur nginx reconstruisait son vérificateur à chaque requête, si bien
 * qu'aucun statut n'était jamais gardé ; le client OCSP d'Apache, lui, mémorisait tout statut une heure alors que httpd interroge à chaque connexion.
 * Avant correctif (git stash de src/network) 2 cas sur 4 tombent (nginx AVEC cache, Apache) ; deux passent dans les deux états : le témoin (premier
 * client accepté) et nginx sans cache, où l'absence de cache était vraie par accident.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const CA = '/etc/ssl/CA';
const MASK = new SubnetMask('255.255.255.0');
const sh = (srv: LinuxServer, command: string): Promise<string> => srv.executeCommand(command);

async function lab(name: string) {
  const web = new LinuxServer('linux-server', `${name}W`); web.powerOn();
  const responder = new LinuxServer('linux-server', `${name}R`); responder.powerOn();
  new Cable(`${name}c`).connect(web.getPort('eth0')!, responder.getPort('eth0')!);
  web.getPort('eth0')!.configureIP(new IPAddress('10.9.0.1'), MASK);
  responder.getPort('eth0')!.configureIP(new IPAddress('10.9.0.2'), MASK);
  await sh(web, `mkdir -p ${CA}`);
  await sh(web, `openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  for (const who of ['good', 'srv']) {
    await sh(web, `sh -c 'printf "authorityInfoAccess=OCSP;URI:http://10.9.0.2:2560\\n" > /tmp/${who}.ext'`);
    await sh(web, `openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/${who}.key -out /tmp/${who}.csr -subj "/CN=${who}.lab"`);
    await sh(web, `openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/${who}.csr -extfile /tmp/${who}.ext -out /tmp/${who}.crt -days 30`);
  }
  await sh(responder, `mkdir -p ${CA}`);
  const source = (web as unknown as { executor: { vfs: { readFile(p: string): string | null } } }).executor.vfs;
  const target = (responder as unknown as { executor: { vfs: { writeFile(p: string, c: string, uid: number, gid: number, umask: number): void } } }).executor.vfs;
  for (const file of ['ca.key', 'ca.crt', 'index.txt']) target.writeFile(`${CA}/${file}`, source.readFile(`${CA}/${file}`)!, 0, 0, 0o22);
  await sh(responder, `openssl ocsp -index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key -port 2560 &`);
  return { web, responder };
}

async function nginx(srv: LinuxServer, extra: string): Promise<void> {
  const body = `server {\n listen 443 ssl;\n root /var/www/html;\n index index.nginx-debian.html;\n ssl_certificate /tmp/srv.crt;\n ssl_certificate_key /tmp/srv.key;\n ssl_verify_client on;\n ssl_client_certificate ${CA}/ca.crt;\n ssl_ocsp on;\n${extra}}\n`;
  await sh(srv, `sh -c 'printf "${body.replace(/\n/g, '\\n')}" > /etc/nginx/sites-available/default'`);
  await sh(srv, 'systemctl start nginx');
}

async function apache(srv: LinuxServer): Promise<void> {
  await sh(srv, 'a2enmod ssl');
  const body = `<VirtualHost *:443>\n DocumentRoot /var/www/html\n SSLEngine on\n SSLCertificateFile /tmp/srv.crt\n SSLCertificateKeyFile /tmp/srv.key\n SSLVerifyClient require\n SSLCACertificateFile ${CA}/ca.crt\n SSLOCSPEnable on\n</VirtualHost>\n`;
  await sh(srv, `sh -c 'printf "${body.replace(/\n/g, '\\n')}" > /etc/apache2/sites-available/lab.conf'`);
  await sh(srv, 'ln -sf ../sites-available/lab.conf /etc/apache2/sites-enabled/lab.conf');
  await sh(srv, 'systemctl start apache2');
}

const client = (srv: LinuxServer): Promise<string> => sh(srv, 'curl -sS -k --cert /tmp/good.crt --key /tmp/good.key https://127.0.0.1/');
const stopResponder = (responder: LinuxServer): Promise<string> => sh(responder, 'iptables -I INPUT -p tcp --dport 2560 -j REJECT --reject-with tcp-reset');

describe('cache OCSP des certificats clients', () => {
  it('témoin : le premier client est accepté (nginx, répondeur actif)', async () => {
    const { web: srv } = await lab('C1'); await nginx(srv, '');
    expect(await client(srv)).toContain('Welcome to nginx!');
  });

  it('nginx sans ssl_ocsp_cache : un répondeur arrêté refuse la connexion suivante', async () => {
    const { web: srv, responder } = await lab('C2'); await nginx(srv, '');
    expect(await client(srv)).toContain('Welcome to nginx!');
    await stopResponder(responder);
    expect(await client(srv)).toContain('400 The SSL certificate error');
  });

  it('nginx avec ssl_ocsp_cache shared:ocsp:1m : le statut en cache sert la connexion suivante', async () => {
    const { web: srv, responder } = await lab('C3'); await nginx(srv, ' ssl_ocsp_cache shared:ocsp:1m;\n');
    expect(await client(srv)).toContain('Welcome to nginx!');
    await stopResponder(responder);
    expect(await client(srv)).toContain('Welcome to nginx!');
  });

  it('Apache : aucun cache pour les certificats clients, un répondeur arrêté refuse la connexion suivante', async () => {
    const { web: srv, responder } = await lab('C4'); await apache(srv);
    expect(await client(srv)).toContain('It works!');
    await stopResponder(responder);
    expect(await client(srv)).toContain('curl: (');
  });
});
