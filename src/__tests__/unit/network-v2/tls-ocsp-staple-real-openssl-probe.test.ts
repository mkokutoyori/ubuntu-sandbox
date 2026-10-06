/**
 * L'agrafe OCSP (RFC 6066 §8 status_request, RFC 6960) traverse la poignée de main TLS sous sa forme
 * réelle : CertificateStatus porte un OCSPResponse DER, et un openssl 3.x réel la lit, dans les deux
 * sens, par une vraie prise TCP — `s_client -status` affiche l'agrafe du simulateur (TLS 1.2 et 1.3),
 * et le client du simulateur lit, vérifie et exploite l'agrafe d'un `s_server -status_file` réel.
 *
 * MESURÉ avant correctif : l'agrafe était un JSON signé sur du JSON, que s_client ne pouvait pas lire
 * (« OCSP response: no response sent » ou erreur d'analyse) et que le client du simulateur ne pouvait
 * pas lire dans le fichier d'un vrai répondeur. Avant correctif, les 3 cas tombent ; le témoin (une
 * agrafe d'un autre émetteur est refusée par le client du simulateur) passe dans les deux états.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { OcspResponder } from '@/network/pki/OcspResponder';
import { certToPem } from '@/network/pki/pem';
import { realCertificate, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello';

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'ocspstaple-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { ca, leaf, caPath, now };
}

describe('agrafe OCSP ↔ openssl réel', () => {
  for (const [version, flag] of [['1.3', '-tls1_3'], ['1.2', '-tls1_2']] as const) {
    it(`TLS ${version} : s_client -status lit l'agrafe du simulateur (OCSP Response Status: successful, good)`, async () => {
      const pki = simPki();
      const staple = new OcspResponder(pki.ca).respond(pki.leaf.cert, pki.now);
      const bridge = await startSimServer(
        () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, ocspStaple: staple } as never), () => REPLY);
      const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, flag, '-status']);
      bridge.stop();
      expect(run.stdout + run.stderr).toContain('OCSP Response Status: successful (0x0)');
      expect(run.stdout + run.stderr).toContain('Cert Status: good');
      expect(run.stdout + run.stderr).toContain('Responder Id: CN = sim.lab CA');
    }, 30000);
  }

  it('le client du simulateur lit, vérifie et exploite l\'agrafe d\'un s_server réel (-status_file)', async () => {
    const material = realCertificate('real.lab');
    const dir = mkdtempSync(join(tmpdir(), 'realstaple-'));
    const serial = material.certificate.serialNumber.toUpperCase();
    const expiry = new Date(Date.now() + 5 * 86400_000).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
    writeFileSync(join(dir, 'index.txt'), `V\t${expiry}\t\t${serial}\tunknown\t/CN=real.lab\n`);
    const run = (...args: string[]) => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    run('ocsp', '-issuer', material.certificatePath, '-cert', material.certificatePath, '-no_nonce', '-reqout', 'q.der');
    const made = run('ocsp', '-reqin', 'q.der', '-index', 'index.txt', '-CA', material.certificatePath, '-rsigner', material.certificatePath, '-rkey', material.keyPath, '-ndays', '3', '-respout', 'r.der');
    expect(made.status).toBe(0);

    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', '-tls1_3', '-status_file', join(dir, 'r.der')], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.3'], requestOcspStaple: true } as never);
    await runSimClient(port, client);
    child.kill();
    expect(client.result).toBe('success');
    expect(client.receivedStaple).not.toBeNull();
    expect(client.receivedStaple!.singles[0].status).toBe('good');
  }, 30000);

  it('témoin : une agrafe signée par un autre émetteur est refusée par le client du simulateur', async () => {
    const pki = simPki();
    const other = CertificateAuthority.generate('CN=other CA', { now: pki.now, algorithm: 'rsa', keyBits: 2048 });
    const foreign = other.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: pki.now - 1000, notAfter: pki.now + 86400_000, keyBits: 2048 });
    const staple = new OcspResponder(other).respond(foreign.cert, pki.now);
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, ocspStaple: staple } as never), () => REPLY);
    const verifier = new CertificateVerifier({ trustAnchors: [pki.ca.rootCertificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.3'], requestOcspStaple: true } as never);
    await runSimClient(bridge.port, client);
    bridge.stop();
    expect(client.result).toBe('failure');
  }, 30000);
});
