/**
 * `SSLVerifyClient` dans un `<Location>` ou un `<Directory>` d'Apache : le certificat client n'est exigé qu'à l'accès au chemin, par une
 * renégociation TLS 1.2 que le serveur lance (HelloRequest) quand la requête arrive. Les clients sont de VRAIS clients (curl, s_client)
 * qui atteignent l'Apache simulé par un relais TCP : sans certificat le chemin protégé n'est pas servi, avec le certificat d'une
 * autorité de confiance il l'est, un chemin public ne déclenche aucune renégociation, et en TLS 1.3 où la renégociation n'existe
 * pas le critère échoue FERMÉ (403) au lieu de laisser passer.
 *
 * MESURÉ avant correctif : la directive était refusée à la lecture de la configuration (« needs a TLS renegotiation after the
 * handshake, which this simulator does not perform »). Avant correctif (git stash de src/network) 6 cas sur 6 tombent, le témoin lui-même pour une raison
 * structurelle : la configuration du laboratoire, qui porte la directive, était refusée et Apache ne démarrait pas.
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

async function lab(srv: LinuxServer, sections: string): Promise<{ relay: TcpRelay; dir: string }> {
  await sh(srv, `mkdir -p ${PKI}`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/ca.key -out ${PKI}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/srv.key -out ${PKI}/srv.crt -days 365 -nodes -subj "/CN=lab.local" -addext "subjectAltName=DNS:lab.local"`);
  await sh(srv, `openssl req -new -newkey rsa:2048 -nodes -keyout ${PKI}/alice.key -out ${PKI}/alice.csr -subj "/CN=alice"`);
  await sh(srv, `openssl x509 -req -in ${PKI}/alice.csr -CA ${PKI}/ca.crt -CAkey ${PKI}/ca.key -CAcreateserial -out ${PKI}/alice.crt -days 30`);
  await sh(srv, 'mkdir -p /var/www/html/secure');
  await sh(srv, `sh -c 'echo secret-report > /var/www/html/secure/index.html'`);
  await sh(srv, 'a2enmod ssl');
  const vhost = `<VirtualHost *:443>\n  ServerName lab.local\n  DocumentRoot /var/www/html\n  SSLEngine on\n  SSLCertificateFile ${PKI}/srv.crt\n  SSLCertificateKeyFile ${PKI}/srv.key\n  SSLCACertificateFile ${PKI}/ca.crt\n${sections}</VirtualHost>\n`;
  const text = vhost.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$');
  await sh(srv, `sh -c 'printf "${text}" > /etc/apache2/sites-available/lab.conf'`);
  await sh(srv, 'ln -sf ../sites-available/lab.conf /etc/apache2/sites-enabled/lab.conf');
  expect(await sh(srv, 'apachectl configtest 2>&1')).toContain('Syntax OK');
  await sh(srv, 'systemctl start apache2');
  const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
  const dir = mkdtempSync(join(tmpdir(), 'apdir-'));
  for (const name of ['srv', 'ca', 'alice']) writeFileSync(join(dir, `${name}.crt`), srv.readTextFile(`${PKI}/${name}.crt`) ?? '');
  writeFileSync(join(dir, 'alice.key'), srv.readTextFile(`${PKI}/alice.key`) ?? '');
  return { relay, dir };
}

interface Run { readonly status: number | null; readonly stdout: string; readonly stderr: string }

function curl(relay: TcpRelay, dir: string, path: string, extra: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sS', '-i', '--noproxy', '*', '--max-time', '20', '--resolve', `lab.local:${relay.port}:127.0.0.1`, '--cacert', join(dir, 'srv.crt'), ...extra, `https://lab.local:${relay.port}${path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const TLS12 = ['--tlsv1.2', '--tls-max', '1.2'];

describe('SSLVerifyClient par chemin ↔ clients réels', () => {
  it('témoin : un chemin public est servi sans certificat client', async () => {
    const srv = machine();
    const { relay, dir } = await lab(srv, '  <Location /secure>\n    SSLVerifyClient require\n  </Location>\n');
    const result = await curl(relay, dir, '/', TLS12);
    relay.stop();
    expect(result.stdout).toContain('Apache2 Ubuntu Default Page');
  }, 90000);

  it('<Location> : sans certificat, le chemin protégé n\'est pas servi', async () => {
    const srv = machine();
    const { relay, dir } = await lab(srv, '  <Location /secure>\n    SSLVerifyClient require\n  </Location>\n');
    const result = await curl(relay, dir, '/secure/', TLS12);
    relay.stop();
    expect(result.stdout).not.toContain('secret-report');
    expect(result.status).not.toBe(0);
  }, 90000);

  it('<Location> : avec le certificat de la CA, renégociation puis chemin protégé servi', async () => {
    const srv = machine();
    const { relay, dir } = await lab(srv, '  <Location /secure>\n    SSLVerifyClient require\n  </Location>\n');
    const result = await curl(relay, dir, '/secure/', [...TLS12, '--cert', join(dir, 'alice.crt'), '--key', join(dir, 'alice.key')]);
    relay.stop();
    expect(result.stdout).toContain('secret-report');
  }, 90000);

  it('<Directory> sous la racine documentaire : même effet', async () => {
    const srv = machine();
    const { relay, dir } = await lab(srv, '  <Directory /var/www/html/secure>\n    SSLVerifyClient require\n  </Directory>\n');
    const refused = await curl(relay, dir, '/secure/', TLS12);
    const accepted = await curl(relay, dir, '/secure/', [...TLS12, '--cert', join(dir, 'alice.crt'), '--key', join(dir, 'alice.key')]);
    relay.stop();
    expect(refused.stdout).not.toContain('secret-report');
    expect(accepted.stdout).toContain('secret-report');
  }, 120000);

  it('en TLS 1.3 la renégociation n\'existe pas : le critère échoue fermé, 403, même avec un certificat', async () => {
    const srv = machine();
    const { relay, dir } = await lab(srv, '  <Location /secure>\n    SSLVerifyClient require\n  </Location>\n');
    const result = await curl(relay, dir, '/secure/', ['--cert', join(dir, 'alice.crt'), '--key', join(dir, 'alice.key')]);
    relay.stop();
    expect(result.stdout).toContain('403');
    expect(result.stdout).not.toContain('secret-report');
  }, 90000);

  it('s_client réel en TLS 1.2 : la renégociation du chemin protégé se fait avec le certificat présenté', async () => {
    const srv = machine();
    const { relay, dir } = await lab(srv, '  <Location /secure>\n    SSLVerifyClient require\n  </Location>\n');
    const output = await new Promise<string>((resolve) => {
      const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${relay.port}`, '-servername', 'lab.local', '-CAfile', join(dir, 'srv.crt'), '-tls1_2', '-cert', join(dir, 'alice.crt'), '-key', join(dir, 'alice.key')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.stdin.on('error', () => undefined);
      child.stdin.write('GET /secure/ HTTP/1.1\r\nHost: lab.local\r\nConnection: close\r\n\r\n');
      setTimeout(() => child.stdin.end(), 2500);
      const timer = setTimeout(() => child.kill(), 15000);
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    relay.stop();
    expect(output).toContain('secret-report');
  }, 90000);
});
