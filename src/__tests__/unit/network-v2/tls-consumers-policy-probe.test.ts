/**
 * La politique TLS atteint les outils qu'un auditeur tape : nginx
 * (`ssl_protocols`, `ssl_ciphers`, `ssl_prefer_server_ciphers`), curl
 * (`--tlsv1.x`, `--tls-max`, `--ciphers`), `openssl s_client`
 * (`-tls1_x`, `-cipher`) et `openssl ciphers`. RFC 8996 (1.0/1.1
 * retirés), RFC 7525 (suites), RFC 8446 §6 (une alerte part sur le fil).
 *
 * MESURÉ avant correctif : `ssl_protocols`/`ssl_ciphers` étaient refusées
 * (`not supported by this simulator`), `curl --tlsv1.2` était « not
 * implemented », `s_client` affichait « TLSv1.3 » en dur et
 * `openssl ciphers` ne listait que les cinq suites 1.3.
 *
 * Avant correctif (stash des sources suivies), 13 des 16 cas tombent. Les
 * trois qui passent dans les deux états : le témoin « sans directive,
 * nginx -t passe et curl négocie 1.3 » (non-régression) et les deux cas
 * de grammaire pure, qui n'appellent que `cipherString.ts`, module
 * nouveau donc non couvert par le stash.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { expandCipherString } from '@/network/tls/legacy/cipherString';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(tlsDirectives: string): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'TLS');
  srv.powerOn();
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:512 -keyout /etc/ssl/private/lab.key '
    + '-out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=lab.local"');
  const site = 'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
    + '  index index.nginx-debian.html;\\n'
    + '  ssl_certificate /etc/ssl/certs/lab.crt;\\n'
    + '  ssl_certificate_key /etc/ssl/private/lab.key;\\n'
    + tlsDirectives + '}\\n';
  await srv.executeCommand(`sh -c 'printf "${site}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
  return srv;
}

describe('openssl ciphers et la grammaire des listes', () => {
  it('une suite nommée, la négation et l\'intersection', () => {
    const named = expandCipherString('ECDHE-RSA-AES128-GCM-SHA256');
    expect(named.ok && named.suites.map((s) => s.opensslName)).toEqual(['ECDHE-RSA-AES128-GCM-SHA256']);
    const both = expandCipherString('ECDHE+AESGCM:!aECDSA');
    expect(both.ok && both.suites.every((s) => s.name.startsWith('TLS_ECDHE_RSA'))).toBe(true);
    const none = expandCipherString('RC4');
    expect(none.ok).toBe(false);
  });

  it('HIGH:!aNULL:!MD5 ne contient jamais RC4, et !x retire pour de bon', () => {
    const list = expandCipherString('HIGH:!aNULL:!MD5');
    expect(list.ok && list.suites.length).toBeGreaterThan(5);
    const killed = expandCipherString('ALL:!kRSA:kRSA');
    expect(killed.ok && killed.suites.some((s) => s.keyExchange === 'RSA')).toBe(false);
  });

  it('openssl ciphers -v décrit une suite en 1.2', async () => {
    const srv = await lab('');
    const out = await srv.executeCommand('openssl ciphers -v ECDHE-RSA-AES128-GCM-SHA256');
    expect(out).toContain('TLSv1.2');
    expect(out).toContain('Kx=ECDH');
    expect(out).toContain('Enc=AESGCM(128)');
  });

  it('openssl ciphers sans liste énumère aussi les suites ≤ 1.2', async () => {
    const srv = await lab('');
    expect(await srv.executeCommand('openssl ciphers')).toContain('ECDHE-RSA-AES256-GCM-SHA384');
  });

  it('une liste vide de correspondances est une erreur', async () => {
    const srv = await lab('');
    expect(await srv.executeCommand('openssl ciphers NOSUCHCIPHER')).toContain('Error in cipher list');
  });
});

describe('nginx — ssl_protocols', () => {
  it('témoin : sans directive, nginx -t passe et curl négocie 1.3', async () => {
    const srv = await lab('');
    expect(await srv.executeCommand('nginx -t')).toContain('test is successful');
    expect(await srv.executeCommand('curl -sS -k -v https://127.0.0.1/ 2>&1')).toContain('TLSv1.3');
  });

  it('ssl_protocols TLSv1.2 : le serveur négocie 1.2 avec un client 1.3', async () => {
    const srv = await lab('  ssl_protocols TLSv1.2;\\n');
    const out = await srv.executeCommand('curl -sS -k -v https://127.0.0.1/ 2>&1');
    expect(out).toContain('TLSv1.2');
    expect(out).toContain('Welcome to nginx!');
  });

  it('RFC 8996 : par défaut un client TLS 1.1 est refusé avec protocol_version', async () => {
    const srv = await lab('');
    const out = await srv.executeCommand('curl -sS -k --tlsv1.1 --tls-max 1.1 https://127.0.0.1/ 2>&1');
    expect(out).toContain('tlsv1 alert protocol version');
    expect(out).not.toContain('Welcome to nginx!');
  });

  it('ssl_protocols TLSv1 TLSv1.1 : un auditeur voit la faiblesse (1.1 accepté)', async () => {
    const srv = await lab('  ssl_protocols TLSv1 TLSv1.1 TLSv1.2;\\n');
    const out = await srv.executeCommand('curl -sS -k -v --tlsv1.1 --tls-max 1.1 https://127.0.0.1/ 2>&1');
    expect(out).toContain('TLSv1.1');
    expect(out).toContain('Welcome to nginx!');
  });

  it('une valeur inconnue est refusée avec les mots de nginx', async () => {
    const srv = await lab('  ssl_protocols TLSv9;\\n');
    expect(await srv.executeCommand('nginx -t')).toContain('invalid value "TLSv9"');
  });
});

describe('nginx — ssl_ciphers et ssl_prefer_server_ciphers', () => {
  it('ssl_ciphers restreint ce que le client peut obtenir', async () => {
    const srv = await lab('  ssl_protocols TLSv1.2;\\n  ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256;\\n');
    const out = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443 -tls1_2');
    expect(out).toContain('Cipher is ECDHE-RSA-AES128-GCM-SHA256');
    const refused = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443 -tls1_2 -cipher ECDHE-RSA-AES256-GCM-SHA384');
    expect(refused).toContain('sslv3 alert handshake failure');
  });

  it('une liste sans correspondance fait échouer nginx -t', async () => {
    const srv = await lab('  ssl_ciphers NOSUCHCIPHER;\\n');
    expect(await srv.executeCommand('nginx -t')).toContain('no cipher match');
  });

  it('ssl_prefer_server_ciphers on : l\'ordre du serveur l\'emporte', async () => {
    const ciphers = 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256';
    const off = await lab(`  ssl_protocols TLSv1.2;\\n  ssl_ciphers ${ciphers};\\n`);
    const clientFirst = await off.executeCommand(
      'openssl s_client -connect 127.0.0.1:443 -tls1_2 -cipher ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384');
    expect(clientFirst).toContain('Cipher is ECDHE-RSA-AES128-GCM-SHA256');
    EquipmentRegistry.getInstance().clear();
    const on = await lab(`  ssl_protocols TLSv1.2;\\n  ssl_ciphers ${ciphers};\\n  ssl_prefer_server_ciphers on;\\n`);
    const serverFirst = await on.executeCommand(
      'openssl s_client -connect 127.0.0.1:443 -tls1_2 -cipher ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384');
    expect(serverFirst).toContain('Cipher is ECDHE-RSA-AES256-GCM-SHA384');
  });
});

describe('curl et s_client', () => {
  it('curl --ciphers invalide : erreur 59 comme libcurl', async () => {
    const srv = await lab('');
    expect(await srv.executeCommand('curl -sS -k --ciphers NOSUCHCIPHER https://127.0.0.1/ 2>&1'))
      .toContain('curl: (59)');
  });

  it('s_client affiche la version négociée et non « TLSv1.3 » en dur', async () => {
    const srv = await lab('  ssl_protocols TLSv1.2;\\n');
    const out = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443');
    expect(out).toContain('New, TLSv1.2');
    expect(out).toContain('Protocol  : TLSv1.2');
  });

  it('s_client -tls1_1 contre un serveur par défaut : alerte protocol_version', async () => {
    const srv = await lab('');
    const out = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443 -tls1_1');
    expect(out).toContain('tlsv1 alert protocol version');
    expect(out).toContain('Cipher is (NONE)');
  });
});
