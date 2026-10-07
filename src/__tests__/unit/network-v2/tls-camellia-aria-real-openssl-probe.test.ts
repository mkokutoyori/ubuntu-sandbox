/**
 * Les suites TLS 1.2 Camellia (CBC) et ARIA (GCM) — celles qu'un openssl 3.0 propose et qu'une pile
 * sans ces chiffrements refusait — sont négociées avec un openssl réel dans les deux sens : le
 * simulateur serveur est interrogé par `s_client -cipher`, le simulateur client parle à `s_server`.
 * La liste `openssl ciphers -v` du simulateur est identique, ligne à ligne, à celle d'openssl pour
 * CAMELLIA et ARIA (les suites DSS/PSK/SRP/anonymes que la pile ne fournit pas mises à part).
 *
 * MESURÉ avant correctif : une énumération par python ssl contre un nginx simulé (relais TCP) acceptait 28 suites
 * sur les 48 que sait faire un certificat RSA ; les 16 refusées, hors NULL, étaient exactement les
 * ARIA et CAMELLIA. Avant correctif, 12 des 13 cas tombent ; le témoin AES128-GCM passe dans les deux états.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { realCertificate, startRealServer, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const SUITES = [
  'ECDHE-RSA-CAMELLIA128-SHA256', 'ECDHE-RSA-CAMELLIA256-SHA384', 'DHE-RSA-CAMELLIA256-SHA256', 'CAMELLIA128-SHA', 'CAMELLIA256-SHA256',
  'ECDHE-ARIA128-GCM-SHA256', 'ECDHE-ARIA256-GCM-SHA384', 'DHE-RSA-ARIA128-GCM-SHA256', 'ARIA256-GCM-SHA384',
];

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'camaria-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { ca, leaf, caPath };
}

describe('Camellia et ARIA ↔ openssl réel', () => {
  for (const suite of SUITES) {
    it(`${suite} : s_client réel négocie la suite avec le serveur du simulateur`, async () => {
      const pki = simPki();
      const bridge = await startSimServer(
        () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, cipherList: `${suite}:@SECLEVEL=0` } as never),
        () => 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok');
      const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_2', '-cipher', `${suite}:@SECLEVEL=0`]);
      bridge.stop();
      expect(run.stdout).toContain(`Cipher is ${suite}`);
      expect(run.stdout).toContain('Verify return code: 0 (ok)');
    }, 60000);
  }

  it('le client du simulateur négocie ECDHE-ARIA256-GCM-SHA384 avec un s_server réel et lit la page', async () => {
    const material = realCertificate('real.lab');
    const server = await startRealServer(material, ['-tls1_2', '-cipher', 'ECDHE-ARIA256-GCM-SHA384:@SECLEVEL=0']);
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.2'], cipherList: 'ECDHE-ARIA256-GCM-SHA384:@SECLEVEL=0' } as never);
    const run = await runSimClient(server.port, client);
    server.stop();
    expect(client.result).toBe('success');
    expect(client.negotiatedCipherSuite).toBe('TLS_ECDHE_RSA_WITH_ARIA_256_GCM_SHA384');
    expect(run.response).toContain('HTTP/1.0 200 ok');
  }, 60000);

  it('le client du simulateur négocie ECDHE-RSA-CAMELLIA256-SHA384 avec un s_server réel', async () => {
    const material = realCertificate('real.lab');
    const server = await startRealServer(material, ['-tls1_2', '-cipher', 'ECDHE-RSA-CAMELLIA256-SHA384:@SECLEVEL=0']);
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.2'], cipherList: 'ECDHE-RSA-CAMELLIA256-SHA384:@SECLEVEL=0' } as never);
    const run = await runSimClient(server.port, client);
    server.stop();
    expect(client.result).toBe('success');
    expect(client.negotiatedCipherSuite).toBe('TLS_ECDHE_RSA_WITH_CAMELLIA_256_CBC_SHA384');
    expect(run.response).toContain('HTTP/1.0 200 ok');
  }, 60000);

  it('openssl ciphers -v CAMELLIA et ARIA : même liste, même ordre que openssl', async () => {
    const srv = new LinuxServer('linux-server', 'C'); srv.powerOn();
    for (const spec of ['CAMELLIA', 'ARIA']) {
      const real = spawnSync('openssl', ['ciphers', '-v', spec], { encoding: 'utf8' }).stdout.trim().split('\n').filter((l) => !/Au=(DSS|PSK|None)|Kx=\w*PSK/.test(l));
      const shown = (await srv.executeCommand(`openssl ciphers -v ${spec}`)).trim().split('\n');
      expect(shown.map((l) => l.replace(/\s+/g, ' '))).toEqual(real.map((l) => l.replace(/\s+/g, ' ')));
    }
  });

  it('WITNESS — AES128-GCM reste négociée par un s_client réel', async () => {
    const pki = simPki();
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey } as never), () => 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok');
    const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_2', '-cipher', 'ECDHE-RSA-AES128-GCM-SHA256']);
    bridge.stop();
    expect(run.stdout).toContain('Cipher is ECDHE-RSA-AES128-GCM-SHA256');
  }, 60000);
});
