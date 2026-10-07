/**
 * La reprise de session TLS 1.3 par PSK (RFC 8446 §2.2, §4.2.11) traverse le fil sous sa forme réelle :
 * ClientHello avec pre_shared_key (identité = ticket opaque, obfuscated_ticket_age = âge + ticket_age_add,
 * binder HMAC calculé sur le ClientHello tronqué avant la liste des binders), ServerHello portant
 * selected_identity, puis EncryptedExtensions et Finished SANS Certificate ni CertificateVerify.
 * Un openssl 3.x réel reprend une session auprès du simulateur (`s_client -sess_in`) et le client du
 * simulateur reprend la session d'un `s_server` réel.
 *
 * MESURÉ avant correctif : le binder était 32 octets de zéros et l'âge toujours 0 ; le serveur du
 * simulateur renvoyait un Certificate dans une poignée de main reprise, ce que le vrai client
 * rejetait (« unexpected message ») ; le client du simulateur exigeait un Certificate de la
 * poignée de main reprise d'un vrai serveur. Avant correctif, 4 des 5 cas tombent (git stash) ; le
 * cas TLS 1.2 passait déjà et sert de TÉMOIN (la reprise ≤ 1.2 interopérait). Le cas du binder falsifié tombait avant pour une
 * raison structurelle (la propriété pskResumed n'existait pas) : son verdict de fond, le refus par decrypt_error, n'était pas
 * démontrable puisque le serveur n'évaluait aucun binder.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { realCertificate, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok';
const TICKET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { ca, leaf, caPath, dir };
}

describe('reprise de session ↔ openssl réel', () => {
  for (const [version, flag] of [['1.3', '-tls1_3'], ['1.2', '-tls1_2']] as const) {
    it(`TLS ${version} : s_client -sess_in reprend la session du simulateur (Reused)`, async () => {
      const pki = simPki();
      const store = new SessionTicketStore();
      const bridge = await startSimServer(
        () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store, sessionTicketKey: TICKET_KEY } as never), () => REPLY);
      const session = join(pki.dir, 'session.pem');
      const args = ['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, flag];
      const first = await runRealClient([...args, '-sess_out', session]);
      expect(first.stdout).toContain('New, TLSv1.');
      expect(existsSync(session)).toBe(true);
      const second = await runRealClient([...args, '-sess_in', session]);
      bridge.stop();
      expect(second.stdout).toContain('Reused, TLSv1.');
      expect(second.stderr).not.toContain('error');
    }, 60000);
  }

  it('le client du simulateur reprend la session d\'un s_server réel : binder accepté, pas de Certificate', async () => {
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', '-tls1_3'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const first = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.3'] } as never);
    await runSimClient(port, first);
    expect(first.result).toBe('success');
    expect(first.receivedTicket).not.toBeNull();
    expect(first.pskResumed).toBe(false);

    const second = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.3'], resumptionTicket: first.receivedTicket! } as never);
    const run = await runSimClient(port, second);
    child.kill();
    expect(second.result).toBe('success');
    expect(second.pskResumed).toBe(true);
    expect(run.response).toContain('HTTP/1.0 200 ok');
  }, 60000);

  it('sim ↔ sim : la reprise garde son verdict et le certificat du serveur reste connu du client', async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    const make = () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store } as never);
    const bridge = await startSimServer(make, () => REPLY);
    const verifier = new CertificateVerifier({ trustAnchors: [pki.ca.rootCertificate], clock: () => Date.now() });
    const first = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.3'] } as never);
    await runSimClient(bridge.port, first);
    const second = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.3'], resumptionTicket: first.receivedTicket! } as never);
    await runSimClient(bridge.port, second);
    bridge.stop();
    expect(second.pskResumed).toBe(true);
    expect(second.peerCertificate?.subject).toContain('sim.lab');
  }, 60000);

  it('témoin : un binder falsifié est refusé (decrypt_error), jamais accepté', async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    const make = () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store } as never);
    const bridge = await startSimServer(make, () => REPLY);
    const verifier = new CertificateVerifier({ trustAnchors: [pki.ca.rootCertificate], clock: () => Date.now() });
    const first = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.3'] } as never);
    await runSimClient(bridge.port, first);
    const forged = { ...first.receivedTicket!, resumptionMasterSecret: '11'.repeat(32) };
    const second = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.3'], resumptionTicket: forged } as never);
    await runSimClient(bridge.port, second);
    bridge.stop();
    expect(second.pskResumed).toBe(false);
    expect(second.result).toBe('failure');
  }, 60000);
});
