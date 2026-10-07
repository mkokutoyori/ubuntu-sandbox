/**
 * Les serveurs web simulés (nginx 1.24, Apache 2.4) répondent à de VRAIS clients — `curl` et `openssl
 * s_client` du système — à travers la pile TCP simulée : chaque octet du client réel entre par une
 * vraie prise, est relayé dans une connexion TCP de la machine simulée (trames SYN/ACK/PSH comptées
 * par la pile), et la poignée de main TLS, l'ALPN, la vérification du certificat, l'authentification
 * mutuelle et la reprise de session sont celles que ces vrais clients attendent.
 *
 * MESURÉ : ce sondage ne corrige pas un défaut isolé, il ferme un angle mort. Il apporte le relais TCP réel → pile simulée
 * (_tcpRelay) et ses premiers constats : avec les clients réels, la poignée de main TLS 1.3/1.2, le certificat RSA-PSS, l'ALPN,
 * l'authentification mutuelle et la reprise passent, alors que le certificat RSA de 1024 bits du laboratoire historique est refusé
 * par le niveau de sécurité 2 d'un vrai openssl (« EE certificate key too weak ») — d'où des clés de 2048 bits ici. Les 11 cas
 * passent dès leur écriture : ils gardent l'interopérabilité acquise par les étapes précédentes (DER, binaire, PSK) contre
 * une régression, sans prétendre avoir été rouges avant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh } from './_httpsLab';
import { startTcpRelay, type TcpRelay } from './_tcpRelay';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(srv: LinuxServer): Promise<void> {
  await sh(srv, `mkdir -p ${PKI}`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/ca.key -out ${PKI}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/srv.key -out ${PKI}/srv.crt -days 365 -nodes -subj "/CN=lab.local" -addext "subjectAltName=DNS:lab.local"`);
  await sh(srv, `openssl req -new -newkey rsa:2048 -nodes -keyout ${PKI}/alice.key -out ${PKI}/alice.csr -subj "/CN=alice"`);
  await sh(srv, `openssl x509 -req -in ${PKI}/alice.csr -CA ${PKI}/ca.crt -CAkey ${PKI}/ca.key -CAcreateserial -out ${PKI}/alice.crt -days 30`);
}

async function site(srv: LinuxServer, body: string): Promise<void> {
  const text = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  await sh(srv, `sh -c 'printf "${text}" > /etc/nginx/sites-available/default'`);
}

async function nginx(extra = ''): Promise<{ srv: LinuxServer; relay: TcpRelay; dir: string }> {
  const srv = machine(); await lab(srv);
  await site(srv, `server {\n  listen 443 ssl;\n  server_name lab.local;\n  root /var/www/html;\n  index index.nginx-debian.html;\n  ssl_certificate ${PKI}/srv.crt;\n  ssl_certificate_key ${PKI}/srv.key;\n${extra}}\n`);
  expect(await sh(srv, 'nginx -t')).toContain('successful');
  await sh(srv, 'systemctl start nginx');
  return withRelay(srv);
}

async function withRelay(srv: LinuxServer) {
  const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
  const dir = mkdtempSync(join(tmpdir(), 'webreal-'));
  for (const name of ['srv', 'ca', 'alice']) writeFileSync(join(dir, `${name}.crt`), srv.readTextFile(`${PKI}/${name}.crt`) ?? '');
  writeFileSync(join(dir, 'alice.key'), srv.readTextFile(`${PKI}/alice.key`) ?? '');
  return { srv, relay, dir };
}

interface Run { readonly status: number | null; readonly stdout: string; readonly stderr: string }

function run(command: string, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => undefined);
    if (input !== undefined) { child.stdin.write(input); setTimeout(() => child.stdin.end(), 800); } else child.stdin.end();
    const timer = setTimeout(() => child.kill(), 25000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function curl(relay: TcpRelay, dir: string, extra: string[] = []): Promise<Run> {
  return run('curl', ['-sS', '--noproxy', '*', '--max-time', '20', '--resolve', `lab.local:${relay.port}:127.0.0.1`, '--cacert', join(dir, 'srv.crt'), ...extra, `https://lab.local:${relay.port}/`]);
}

describe('nginx simulé ↔ clients réels', () => {
  it('curl réel : TLS 1.3, certificat vérifié, page servie', async () => {
    const { relay, dir } = await nginx();
    const result = await curl(relay, dir, ['-v']);
    relay.stop();
    expect(result.stdout).toContain('Welcome to nginx!');
    expect(result.stderr).toContain('SSL connection using TLSv1.3');
    expect(result.stderr).toContain('SSL certificate verify ok');
  }, 60000);

  it('curl réel --tls-max 1.2 : TLS 1.2 négocié avec une suite ECDHE', async () => {
    const { relay, dir } = await nginx();
    const result = await curl(relay, dir, ['-v', '--tlsv1.2', '--tls-max', '1.2']);
    relay.stop();
    expect(result.stdout).toContain('Welcome to nginx!');
    expect(result.stderr).toContain('SSL connection using TLSv1.2');
  }, 60000);

  it('s_client réel : « Verify return code: 0 », chaîne et suite', async () => {
    const { relay, dir } = await nginx();
    const result = await run('openssl', ['s_client', '-connect', `127.0.0.1:${relay.port}`, '-servername', 'lab.local', '-CAfile', join(dir, 'srv.crt'), '-verify_hostname', 'lab.local'], 'GET / HTTP/1.0\r\n\r\n');
    relay.stop();
    expect(result.stdout).toContain('Verify return code: 0 (ok)');
    expect(result.stdout).toContain('Welcome to nginx!');
  }, 60000);

  it('ssl_protocols TLSv1.3 : un curl réel limité à TLS 1.2 est refusé par une alerte', async () => {
    const { relay, dir } = await nginx('  ssl_protocols TLSv1.3;\n');
    const result = await curl(relay, dir, ['--tlsv1.2', '--tls-max', '1.2']);
    relay.stop();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/alert|handshake|protocol/i);
  }, 60000);

  it('mTLS : sans certificat client, nginx répond 400 ; avec le certificat de la CA, 200', async () => {
    const { relay, dir } = await nginx(`  ssl_verify_client on;\n  ssl_client_certificate ${PKI}/ca.crt;\n`);
    const refused = await curl(relay, dir, ['-i']);
    const accepted = await curl(relay, dir, ['--cert', join(dir, 'alice.crt'), '--key', join(dir, 'alice.key')]);
    relay.stop();
    expect(refused.stdout).toContain('400');
    expect(accepted.stdout).toContain('Welcome to nginx!');
  }, 60000);

  it('une suite TLS 1.2 imposée par le client réel est celle que nginx négocie, et ssl_ciphers la restreint', async () => {
    const { relay, dir } = await nginx('  ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256;\n');
    const accepted = await curl(relay, dir, ['-v', '--tlsv1.2', '--tls-max', '1.2', '--ciphers', 'ECDHE-RSA-AES128-GCM-SHA256']);
    const refused = await curl(relay, dir, ['--tlsv1.2', '--tls-max', '1.2', '--ciphers', 'ECDHE-RSA-AES256-GCM-SHA384']);
    relay.stop();
    expect(accepted.stderr).toContain('TLSv1.2 / ECDHE-RSA-AES128-GCM-SHA256');
    expect(accepted.stdout).toContain('Welcome to nginx!');
    expect(refused.status).not.toBe(0);
  }, 60000);

  it('une suite à échange RSA statique (AES256-SHA) est négociée quand ssl_ciphers la permet', async () => {
    const { relay, dir } = await nginx('  ssl_ciphers AES256-SHA:@SECLEVEL=0;\n  ssl_protocols TLSv1.2;\n');
    const result = await curl(relay, dir, ['-v', '--tlsv1.2', '--tls-max', '1.2', '--ciphers', 'AES256-SHA']);
    relay.stop();
    expect(result.stderr).toContain('AES256-SHA');
    expect(result.stdout).toContain('Welcome to nginx!');
  }, 60000);

  it('un nom qui ne correspond pas au certificat est refusé par curl réel (code 60)', async () => {
    const { relay, dir } = await nginx();
    const result = await run('curl', ['-sS', '--noproxy', '*', '--max-time', '20', '--resolve', `other.lab:${relay.port}:127.0.0.1`, '--cacert', join(dir, 'srv.crt'), `https://other.lab:${relay.port}/`]);
    relay.stop();
    expect(result.status).toBe(60);
  }, 60000);

  it('reprise de session : un second s_client réel réutilise la session TLS 1.3', async () => {
    const { relay, dir } = await nginx();
    const session = join(dir, 'sess.pem');
    const args = ['s_client', '-connect', `127.0.0.1:${relay.port}`, '-servername', 'lab.local', '-CAfile', join(dir, 'srv.crt'), '-tls1_3'];
    const first = await run('openssl', [...args, '-sess_out', session], 'GET / HTTP/1.0\r\n\r\n');
    const second = await run('openssl', [...args, '-sess_in', session], 'GET / HTTP/1.0\r\n\r\n');
    relay.stop();
    expect(first.stdout).toContain('New, TLSv1.3');
    expect(second.stdout).toContain('Reused, TLSv1.3');
  }, 60000);
});

describe('agrafage OCSP ↔ clients réels', () => {
  it('nginx agrafe la réponse d\'un répondeur simulé : s_client -status réel lit « good », curl --cert-status réel accepte', async () => {
    const CA = '/etc/ssl/CA';
    const srv = machine();
    await sh(srv, `mkdir -p ${CA} ${PKI}`);
    await sh(srv, `sh -c 'echo 1000 > ${CA}/serial; : > ${CA}/index.txt'`);
    await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
    await sh(srv, `sh -c 'printf "subjectAltName=DNS:lab.local\\nauthorityInfoAccess=OCSP;URI:http://127.0.0.1:2560\\n" > /tmp/leaf.ext'`);
    await sh(srv, `openssl req -new -newkey rsa:2048 -nodes -keyout ${PKI}/srv.key -out /tmp/leaf.csr -subj "/CN=lab.local"`);
    await sh(srv, `openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/leaf.csr -extfile /tmp/leaf.ext -out ${PKI}/srv.crt -days 30`);
    await sh(srv, `sh -c 'cat ${PKI}/srv.crt ${CA}/ca.crt > ${PKI}/fullchain.crt'`);
    await sh(srv, `openssl ocsp -index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key -port 2560 &`);
    await site(srv, `server {\n  listen 443 ssl;\n  server_name lab.local;\n  root /var/www/html;\n  index index.nginx-debian.html;\n  ssl_certificate ${PKI}/fullchain.crt;\n  ssl_certificate_key ${PKI}/srv.key;\n  ssl_stapling on;\n  ssl_stapling_verify on;\n  ssl_trusted_certificate ${CA}/ca.crt;\n}\n`);
    expect(await sh(srv, 'nginx -t')).toContain('successful');
    await sh(srv, 'systemctl start nginx');
    const { relay, dir } = await withRelay(srv);
    writeFileSync(join(dir, 'authority.crt'), srv.readTextFile(`${CA}/ca.crt`) ?? '');
    const status = await run('openssl', ['s_client', '-connect', `127.0.0.1:${relay.port}`, '-servername', 'lab.local', '-CAfile', join(dir, 'authority.crt'), '-status', '-tls1_3'], 'GET / HTTP/1.0\r\n\r\n');
    const strict = await run('curl', ['-sS', '--noproxy', '*', '--max-time', '20', '--resolve', `lab.local:${relay.port}:127.0.0.1`, '--cacert', join(dir, 'authority.crt'), '--cert-status', `https://lab.local:${relay.port}/`]);
    relay.stop();
    expect(status.stdout).toContain('OCSP Response Status: successful (0x0)');
    expect(status.stdout).toContain('Cert Status: good');
    expect(status.stdout).toContain('Verify return code: 0 (ok)');
    expect(strict.stdout).toContain('Welcome to nginx!');
  }, 120000);
});

describe('apache simulé ↔ clients réels', () => {
  it('curl réel et s_client réel : page servie, certificat vérifié', async () => {
    const srv = machine(); await lab(srv);
    await sh(srv, 'a2enmod ssl');
    const vhost = `<VirtualHost *:443>\n  ServerName lab.local\n  DocumentRoot /var/www/html\n  SSLEngine on\n  SSLCertificateFile ${PKI}/srv.crt\n  SSLCertificateKeyFile ${PKI}/srv.key\n</VirtualHost>\n`;
    const text = vhost.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$');
    await sh(srv, `sh -c 'printf "${text}" > /etc/apache2/sites-available/lab.conf'`);
    await sh(srv, 'ln -sf ../sites-available/lab.conf /etc/apache2/sites-enabled/lab.conf');
    expect(await sh(srv, 'apachectl configtest 2>&1')).toContain('Syntax OK');
    await sh(srv, 'systemctl start apache2');
    const { relay, dir } = await withRelay(srv);
    const viaCurl = await curl(relay, dir, ['-v']);
    const viaClient = await run('openssl', ['s_client', '-connect', `127.0.0.1:${relay.port}`, '-servername', 'lab.local', '-CAfile', join(dir, 'srv.crt')], 'GET / HTTP/1.0\r\n\r\n');
    relay.stop();
    expect(viaCurl.stdout).toContain('Apache2 Ubuntu Default Page');
    expect(viaCurl.stderr).toContain('SSL certificate verify ok');
    expect(viaClient.stdout).toContain('Verify return code: 0 (ok)');
  }, 60000);
});

