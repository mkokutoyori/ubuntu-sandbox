/**
 * Les échanges DHE à corps fini au-delà de 2048 bits (RFC 3526 groupes 15 et 16, soit 3072 et 4096 bits)
 * traversent le fil avec un openssl réel dans les deux sens : un vrai `s_client` négocie DHE-RSA contre le
 * serveur du simulateur configuré avec ce groupe, et le client du simulateur négocie contre un vrai
 * `s_server -dhparam` de la même taille.
 *
 * MESURÉ : la limite « DHE au-delà de 2048 bits » figurait encore dans l'état des RFC alors que les groupes MODP 15 et 16 étaient
 * déjà câblés. Les 4 cas passent dès leur écriture, avec ou sans le travail de cette session (aucun cas ne tombe au git stash) :
 * ils gardent l'interopérabilité mesurée contre un vrai openssl et ferment la limite par la preuve plutôt que par l'assertion.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { realCertificate, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok';
const SUITE = 'DHE-RSA-AES256-GCM-SHA384';

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'dhe-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { leaf, caPath, dir };
}

describe('DHE au-delà de 2048 bits ↔ openssl réel', () => {
  for (const [groupId, bits] of [[14, 2048], [15, 3072], [16, 4096]] as const) {
    it(`${bits} bits : s_client réel négocie ${SUITE} avec le serveur du simulateur`, async () => {
      const pki = simPki();
      const bridge = await startSimServer(
        () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, cipherList: `${SUITE}:@SECLEVEL=0`, dhGroupId: groupId } as never), () => REPLY);
      const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_2', '-cipher', `${SUITE}:@SECLEVEL=0`]);
      bridge.stop();
      expect(run.stdout).toContain(`Cipher is ${SUITE}`);
      expect(run.stdout).toContain(`Server Temp Key: DH, ${bits} bits`);
      expect(run.stdout).toContain('Verify return code: 0 (ok)');
    }, 120000);
  }

  it('le client du simulateur négocie DHE-RSA avec un vrai s_server -dhparam de 3072 bits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dhparam-'));
    const dh = join(dir, 'dh.pem');
    const generated = spawnSync('openssl', ['dhparam', '-out', dh, '-5', '3072']);
    if (generated.status !== 0) {
      const named = spawnSync('openssl', ['genpkey', '-genparam', '-algorithm', 'DH', '-pkeyopt', 'group:ffdhe3072', '-out', dh]);
      expect(named.status).toBe(0);
    }
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', '-tls1_2', '-cipher', `${SUITE}:@SECLEVEL=0`, '-dhparam', dh], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.2'], cipherList: `${SUITE}:@SECLEVEL=0` } as never);
    const run = await runSimClient(port, client);
    child.kill();
    expect(client.result).toBe('success');
    expect(client.serverTempKey).toBe('DH, 3072 bits');
    expect(run.response).toContain('HTTP/1.0 200 ok');
  }, 180000);
});
