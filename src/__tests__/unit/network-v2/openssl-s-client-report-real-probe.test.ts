/**
 * Le rapport de `openssl s_client` du simulateur est comparé, ligne à ligne, à celui du vrai openssl
 * 3.0 interrogeant le MÊME serveur simulé (relais TCP réel → pile simulée) : la chaîne de certificats
 * (s:, i:, a:, v:), le certificat serveur en PEM, puis sujet et émetteur.
 *
 * MESURÉ avant correctif : le simulateur n'affichait que « 0 s: / i: » sans les lignes a: et v:,
 * sans PEM ni sujet/émetteur. Avant correctif (stash de src/network) 2 cas sur 3 tombent ; le
 * témoin (le vrai openssl atteint le serveur et affiche une chaîne) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh } from './_httpsLab';
import { startTcpRelay } from './_tcpRelay';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function realClient(port: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, '-tls1_3'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
  });
}

function section(report: string, from: string, to: string): string[] {
  const lines = report.split('\n');
  const start = lines.findIndex((l) => l.startsWith(from));
  const end = lines.findIndex((l, i) => i > start && l.startsWith(to));
  return lines.slice(start, end + 1);
}

async function lab() {
  const srv = machine();
  await sh(srv, `mkdir -p ${PKI}`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/srv.key -out ${PKI}/srv.crt -days 365 -nodes -subj "/CN=lab.local"`);
  const body = `server {\\n  listen 443 ssl;\\n  server_name lab.local;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n  ssl_certificate ${PKI}/srv.crt;\\n  ssl_certificate_key ${PKI}/srv.key;\\n}\\n`;
  await sh(srv, `sh -c 'printf "${body}" > /etc/nginx/sites-available/default'`);
  await sh(srv, 'systemctl start nginx');
  return srv;
}

describe('rapport s_client ↔ openssl réel', () => {
  it('témoin : le vrai openssl atteint le serveur simulé', async () => {
    const srv = await lab();
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const real = await realClient(relay.port);
    relay.stop();
    expect(real).toContain('Certificate chain');
  }, 40000);

  it('la chaîne (s:, i:, a:, v:) est identique', async () => {
    const srv = await lab();
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const real = await realClient(relay.port);
    relay.stop();
    const sim = await sh(srv, 'openssl s_client -connect 127.0.0.1:443 </dev/null');
    expect(section(sim, 'Certificate chain', '---')).toEqual(section(real, 'Certificate chain', '---'));
  }, 40000);

  it('le certificat serveur, son sujet et son émetteur sont identiques', async () => {
    const srv = await lab();
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const real = await realClient(relay.port);
    relay.stop();
    const sim = await sh(srv, 'openssl s_client -connect 127.0.0.1:443 </dev/null');
    expect(section(sim, 'Server certificate', 'issuer=')).toEqual(section(real, 'Server certificate', 'issuer='));
  }, 40000);
});
