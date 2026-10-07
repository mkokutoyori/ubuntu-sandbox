/**
 * Le KeyUpdate de TLS 1.3 (RFC 8446 §4.6.3) échangé avec un openssl réel : `s_client` envoie `K`
 * (KeyUpdate avec update_requested), le serveur du simulateur ouvre le message sous l'ancien secret,
 * avance son secret de réception, répond par son propre KeyUpdate scellé sous l'ancien secret
 * d'émission, puis sert la requête suivante sous les nouvelles clés.
 *
 * MESURÉ avant correctif (git stash push -- src/network src/crypto) : 2 cas sur 3 tombent — le
 * serveur ignorait le KeyUpdate puis échouait en bad_record_mac ; le témoin (requête sans
 * KeyUpdate) passe dans les deux états.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimServer } from './_realOpenssl';

function pki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'keyupd-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { leaf, caPath };
}

async function interactive(port: number, caPath: string, lines: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, '-servername', 'sim.lab', '-CAfile', caPath, '-tls1_3', '-msg'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 9000);
  for (const line of lines) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    child.stdin.write(line);
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return { stdout, stderr };
}

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok';

describe('KeyUpdate TLS 1.3 ↔ openssl réel', () => {
  it('témoin : requête sans KeyUpdate', async () => {
    const material = pki();
    const bridge = await startSimServer(() => new TlsServerSession({ serverCert: material.leaf.cert, serverPrivateKey: material.leaf.privateKey } as never), () => REPLY);
    const run = await interactive(bridge.port, material.caPath, ['GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(run.stdout).toContain('ok');
  }, 30000);

  it('K puis requête : le serveur répond au KeyUpdate et sert sous les nouvelles clés', async () => {
    const material = pki();
    const bridge = await startSimServer(() => new TlsServerSession({ serverCert: material.leaf.cert, serverPrivateKey: material.leaf.privateKey } as never), () => REPLY);
    const run = await interactive(bridge.port, material.caPath, ['K\n', 'GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(run.stdout.match(/<<< TLS 1.3, Handshake \[length 0005\], KeyUpdate/g)).toHaveLength(1);
    expect(run.stdout).toContain('ok');
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 30000);

  it('deux KeyUpdate successifs puis requête', async () => {
    const material = pki();
    const bridge = await startSimServer(() => new TlsServerSession({ serverCert: material.leaf.cert, serverPrivateKey: material.leaf.privateKey } as never), () => REPLY);
    const run = await interactive(bridge.port, material.caPath, ['K\n', 'k\n', 'GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(run.stdout).toContain('ok');
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 30000);
});
