/**
 * Interopérabilité avec openssl 3.x RÉEL, dans les deux sens, par une vraie prise TCP :
 * le simulateur (TlsClientSession) parle à `openssl s_server`, et `openssl s_client` parle
 * au simulateur (TlsServerSession). Le moteur n'est plus seulement cohérent avec lui-même :
 * messages binaires (RFC 8446 §4, RFC 5246 §7.4), certificats DER, clés de trafic de
 * poignée de main, AEAD, RSA-PSS et ECDSA doivent être ceux qu'attend un vrai openssl.
 *
 * MESURÉ avant correctif : aucune de ces poignées de main n'aboutissait — le ClientHello était du
 * JSON que openssl ne peut pas lire, les certificats un JSON signé sur du JSON, le vol serveur
 * en clair. Avant correctif, les 12 cas tombent ; le témoin (un client dont le nom ne
 * correspond pas au certificat est refusé) ne parle à aucun processus externe et passe dans les
 * deux états.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { realCertificate, startRealServer, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello';

function simPki(algorithm: 'rsa' | 'ecdsa', name = 'sim.lab') {
  const now = Date.now();
  const ca = CertificateAuthority.generate(`CN=${name} CA`, { now, algorithm, keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: `CN=${name}`, subjectAltNames: [name], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'simpki-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { ca, leaf, caPath, dir };
}

async function simServer(algorithm: 'rsa' | 'ecdsa', config: Record<string, unknown> = {}) {
  const pki = simPki(algorithm);
  const bridge = await startSimServer(() => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, ...config } as never), () => REPLY);
  return { ...pki, bridge };
}

describe('simulateur (client) ↔ openssl réel (serveur)', () => {
  for (const [version, flag] of [['1.3', '-tls1_3'], ['1.2', '-tls1_2']] as const) {
    for (const algorithm of ['rsa', 'ec'] as const) {
      it(`TLS ${version}, certificat ${algorithm.toUpperCase()} : la poignée de main aboutit et la page est lue`, async () => {
        const material = realCertificate('real.lab', algorithm);
        const server = await startRealServer(material, [flag]);
        const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
        const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: [version] } as never);
        const run = await runSimClient(server.port, client);
        server.stop();
        expect(client.result).toBe('success');
        expect(client.negotiatedVersion).toBe(version);
        expect(run.response).toContain('HTTP/1.0 200 ok');
      }, 30000);
    }
  }

  it('témoin : un nom qui ne correspond pas au certificat est refusé avant toute donnée', async () => {
    const material = realCertificate('real.lab');
    const server = await startRealServer(material, ['-tls1_3']);
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'other.lab', versions: ['1.3'] } as never);
    const run = await runSimClient(server.port, client);
    server.stop();
    expect(client.result).toBe('failure');
    expect(run.response).toBe('');
  }, 30000);
});

describe('openssl réel (client) ↔ simulateur (serveur)', () => {
  for (const [version, flag] of [['1.3', '-tls1_3'], ['1.2', '-tls1_2']] as const) {
    for (const algorithm of ['rsa', 'ecdsa'] as const) {
      it(`TLS ${version}, certificat ${algorithm.toUpperCase()} : chaîne vérifiée (code 0) et page reçue`, async () => {
        const { bridge, caPath } = await simServer(algorithm);
        const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', caPath, flag, '-verify_hostname', 'sim.lab']);
        bridge.stop();
        expect(run.stdout).toContain('Verify return code: 0 (ok)');
        expect(run.stdout).toContain(version === '1.3' ? 'New, TLSv1.3' : 'New, TLSv1.2');
        expect(run.stdout).toContain('hello');
      }, 30000);
    }
  }

  it('ALPN : h2 est négocié et affiché par openssl', async () => {
    const { bridge, caPath } = await simServer('rsa', { alpnProtocols: ['h2', 'http/1.1'] });
    const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', caPath, '-alpn', 'h2,http/1.1']);
    bridge.stop();
    expect(run.stdout).toContain('ALPN protocol: h2');
  }, 30000);

  it('autorité inconnue : openssl refuse avec le code 20 (unable to get local issuer certificate)', async () => {
    const { bridge } = await simServer('rsa');
    const other = simPki('rsa', 'other.lab');
    const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', other.caPath, '-verify_return_error']);
    bridge.stop();
    expect(run.stderr).toContain('verify error:num=20');
  }, 30000);

  it('HelloRetryRequest : un serveur P-256 seul fait renvoyer un ClientHello, openssl s\'adapte', async () => {
    const { bridge, caPath } = await simServer('rsa', { supportedGroups: ['secp256r1'] });
    const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', caPath, '-tls1_3', '-groups', 'X25519:P-256']);
    bridge.stop();
    expect(run.stdout).toContain('hello');
    expect(run.stdout).toMatch(/Server Temp Key: ECDH, (P-256|prime256v1)/);
  }, 30000);

  it('authentification mutuelle : le certificat présenté par openssl est vu et vérifié par le simulateur', async () => {
    const pki = simPki('rsa');
    const real = realCertificate('real-client');
    let seen = '';
    let verified = false;
    const verifier = new CertificateVerifier({ trustAnchors: [real.certificate], clock: () => Date.now() });
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, requestClientCert: true, verifier } as never),
      () => REPLY,
      (session) => { seen = session.peerCertificate?.subject ?? ''; verified = session.peerVerified; },
    );
    const run = await runRealClient(['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_3', '-cert', real.certificatePath, '-key', real.keyPath]);
    bridge.stop();
    expect(run.stdout).toContain('hello');
    expect(seen).toBe('CN=real-client');
    expect(verified).toBe(true);
  }, 60000);
});
