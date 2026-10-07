/**
 * HelloRetryRequest avec reprise PSK (RFC 8446 §4.1.4, §4.2.11.2) : quand le serveur demande un autre groupe,
 * le client renvoie son ClientHello avec un binder recalculé sur la transcription « message_hash(CH1) ‖ HRR ‖
 * CH2 tronqué », et le serveur doit reconnaître ce binder pour poursuivre la reprise.
 *
 * MESURÉ avant correctif : le serveur du simulateur ignorait la PSK du second ClientHello et refaisait une poignée de
 * main complète (« Reused » n'apparaissait jamais), et le client du simulateur échouait en unexpected_message devant le
 * ChangeCipherSpec de compatibilité qu'un vrai serveur envoie après le HelloRetryRequest. Avant correctif (git stash de
 * src/network) 2 cas sur 3 tombent ; le témoin (HRR sans reprise, un vrai client change de groupe) passe dans les deux états.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { spawn } from 'node:child_process';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { realCertificate, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok';

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'hrrpsk-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { leaf, caPath, dir };
}

describe('HelloRetryRequest + PSK ↔ openssl réel', () => {
  it('témoin : un HRR sans reprise aboutit (le vrai client change de groupe)', async () => {
    const pki = simPki();
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, supportedGroups: ['x25519'] } as never), () => REPLY);
    const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_3', '-groups', 'P-256:X25519']);
    bridge.stop();
    expect(run.stdout).toContain('New, TLSv1.3');
    expect(run.stdout).toContain('Verify return code: 0 (ok)');
  }, 60000);

  it('la reprise survit au HelloRetryRequest : le binder du second ClientHello est reconnu', async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store, supportedGroups: ['x25519'] } as never), () => REPLY);
    const session = join(pki.dir, 'session.pem');
    const args = ['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_3', '-groups', 'P-256:X25519'];
    await runRealClient([...args, '-sess_out', session]);
    const second = await runRealClient([...args, '-sess_in', session]);
    bridge.stop();
    expect(second.stdout).toContain('Reused, TLSv1.3');
  }, 60000);

  it('le client du simulateur reprend la session d\'un vrai s_server qui impose un autre groupe (HRR)', async () => {
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', '-tls1_3', '-groups', 'P-256'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const config = { verifier, serverName: 'real.lab', versions: ['1.3'], supportedGroups: ['x25519', 'secp256r1'] };
    const first = new TlsClientSession(config as never);
    await runSimClient(port, first);
    expect(first.result).toBe('success');
    expect(first.receivedTicket).not.toBeNull();
    const second = new TlsClientSession({ ...config, resumptionTicket: first.receivedTicket! } as never);
    await runSimClient(port, second);
    child.kill();
    expect(second.result).toBe('success');
    expect(second.pskResumed).toBe(true);
  }, 60000);
});
