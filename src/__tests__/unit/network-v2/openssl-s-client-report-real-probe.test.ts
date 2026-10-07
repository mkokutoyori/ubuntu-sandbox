/**
 * Le rapport de `openssl s_client` du simulateur est comparé, ligne à ligne, à celui du vrai openssl
 * 3.0 interrogeant le MÊME serveur simulé (relais TCP réel → pile simulée) : la chaîne de certificats
 * (s:, i:, a:, v:), le certificat serveur en PEM, sujet et émetteur, puis le bilan de poignée de main
 * (signature du pair, clé temporaire, vérification, suite, clé publique, renégociation, ALPN, code de vérification).
 *
 * MESURÉ avant correctif : le bilan (signature du pair, clé temporaire, octets, vérification, suite, clé publique,
 * renégociation, ALPN, code de vérification) était remplacé par quatre lignes, et ALPN http/1.1 était offert d'office
 * alors qu'openssl n'en offre pas sans -alpn. Avant correctif (stash de src/network) 3 cas sur 6 tombent : le bilan
 * TLS 1.3, -alpn et le bilan TLS 1.2. Les trois autres passent dans les deux états : le témoin (le vrai openssl atteint
 * le serveur), et la chaîne et le certificat serveur, déjà alignés par le commit précédent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh } from './_httpsLab';
import { startTcpRelay } from './_tcpRelay';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function realClient(port: number, extra: readonly string[] = ['-tls1_3']): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
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

  it('le bilan de poignée de main (hors octets échangés) est identique', async () => {
    const srv = await lab();
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const real = await realClient(relay.port);
    relay.stop();
    const sim = await sh(srv, 'openssl s_client -connect 127.0.0.1:443 </dev/null');
    const bilan = (report: string): string[] => section(report, 'No client certificate', 'Verify return code').filter((l) => !l.startsWith('SSL handshake has read'));
    expect(bilan(sim)).toEqual(bilan(real));
  }, 40000);

  it('avec -alpn, le protocole retenu est annoncé comme chez openssl', async () => {
    const srv = await lab();
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const real = await realClient(relay.port, ['-tls1_3', '-alpn', 'http/1.1']);
    relay.stop();
    const sim = await sh(srv, 'openssl s_client -connect 127.0.0.1:443 -alpn http/1.1 </dev/null');
    const alpn = (report: string): string[] => report.split('\n').filter((l) => l.includes('ALPN'));
    expect(alpn(real)).toEqual(['ALPN protocol: http/1.1']);
    expect(alpn(sim)).toEqual(alpn(real));
  }, 40000);

  it('en TLS 1.2, signature du pair, clé temporaire, suite, renégociation et code de vérification sont identiques', async () => {
    const srv = await lab();
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const real = await realClient(relay.port, ['-tls1_2']);
    relay.stop();
    const sim = await sh(srv, 'openssl s_client -connect 127.0.0.1:443 -tls1_2 </dev/null');
    const keep = (report: string): string[] => report.split('\n').filter((l) => /^\s*(Peer sign|Server Temp Key|Verification|New, |Server public key|Secure Reneg|Compression|Expansion|No ALPN|Verify return code|Extended master secret|Timeout)/.test(l));
    expect(keep(sim).length).toBeGreaterThan(8);
    expect(keep(sim)).toEqual(keep(real));
  }, 40000);
});
