/**
 * Le 0-RTT de TLS 1.3 (RFC 8446 §2.3, §4.2.10, §4.5) traverse le fil sous sa forme réelle : les données
 * précoces sont protégées par les clés issues du client_early_traffic_secret (HKDF « c e traffic » sur le
 * ClientHello complet), le client ferme la phase par un EndOfEarlyData scellé sous ces mêmes clés, puis son
 * Finished part sous les clés de poignée de main ; le serveur n'accepte que si l'âge du ticket concorde
 * (obfuscated_ticket_age, tolérance 10 s comme openssl) et que la suite est celle du ticket. Un openssl
 * réel envoie des données précoces au simulateur (`s_client -sess_in -early_data`) et le client du simulateur
 * en envoie à un `s_server -early_data` réel.
 *
 * MESURÉ avant correctif : les données précoces partaient en clair derrière le ClientHello (aucune clé précoce),
 * aucun EndOfEarlyData n'existait, un vrai serveur ne les déchiffrait pas et le simulateur ne comprenait pas celles
 * d'un vrai client. Avant correctif (git stash de src/network) 2 cas sur 5 tombent : les deux qui font intervenir un
 * openssl réel (s_client vers le simulateur, simulateur vers s_server). Les trois autres passent dans les deux
 * états : le témoin (reprise sans données précoces), le refus quand le serveur désactive early_data, et sim ↔ sim,
 * que la symétrie du « clair des deux côtés » faisait aboutir sans prouver la moindre protection.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';
import { realCertificate, runSimClient, startSimServer, runRealClient } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok';
const EARLY = 'GET /early HTTP/1.0\r\n\r\n';

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'early-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { ca, leaf, caPath, dir };
}

describe('0-RTT ↔ openssl réel', () => {
  it('témoin : un vrai client reprend la session du simulateur sans données précoces', async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store } as never), () => REPLY);
    const session = join(pki.dir, 'session.pem');
    const args = ['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_3'];
    await runRealClient([...args, '-sess_out', session]);
    const second = await runRealClient([...args, '-sess_in', session]);
    bridge.stop();
    expect(second.stdout).toContain('Reused, TLSv1.3');
  }, 60000);

  it("le simulateur déchiffre les données précoces d'un vrai s_client et la poignée de main aboutit", async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    let accepted: TlsServerSession | null = null;
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store } as never), () => REPLY,
      (session) => { accepted = session; });
    const session = join(pki.dir, 'session.pem');
    const earlyFile = join(pki.dir, 'early.txt');
    writeFileSync(earlyFile, EARLY);
    const args = ['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_3'];
    await runRealClient([...args, '-sess_out', session]);
    const second = await runRealClient([...args, '-sess_in', session, '-early_data', earlyFile]);
    bridge.stop();
    expect(second.stdout).toContain('Early data was accepted');
    expect(accepted).not.toBeNull();
    expect(bytesToUtf8((accepted as unknown as TlsServerSession).receivedEarlyData!)).toBe(EARLY);
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 60000);

  it('un ticket sans early_data (serveur qui le refuse) : la reprise aboutit, les données précoces sont ignorées', async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    let accepted: TlsServerSession | null = null;
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store, earlyData: false } as never), () => REPLY,
      (session) => { accepted = session; });
    const session = join(pki.dir, 'session.pem');
    const earlyFile = join(pki.dir, 'early.txt');
    writeFileSync(earlyFile, EARLY);
    const args = ['-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_3'];
    await runRealClient([...args, '-sess_out', session]);
    const second = await runRealClient([...args, '-sess_in', session, '-early_data', earlyFile]);
    bridge.stop();
    expect(second.stdout).toContain('Reused, TLSv1.3');
    expect(second.stdout).not.toContain('Early data was accepted');
    expect(accepted === null || (accepted as unknown as TlsServerSession).receivedEarlyData === null).toBe(true);
  }, 60000);

  it("le client du simulateur envoie ses données précoces à un vrai s_server -early_data, qui les lit", async () => {
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    let log = '';
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-tls1_3', '-early_data'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const first = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.3'] } as never);
    await runSimClient(port, first);
    expect(first.receivedTicket).not.toBeNull();
    const second = new TlsClientSession({
      verifier, serverName: 'real.lab', versions: ['1.3'], resumptionTicket: first.receivedTicket!, earlyData: utf8ToBytes('hello-zero-rtt'),
    } as never);
    const run = await runSimClient(port, second);
    child.kill();
    expect(second.result).toBe('success');
    expect(second.earlyDataAccepted).toBe(true);
    expect(run.steps.join('|')).not.toContain('error');
    expect(log).toContain('hello-zero-rtt');
  }, 60000);

  it('sim ↔ sim : le serveur reçoit les données précoces chiffrées sous les clés précoces', async () => {
    const pki = simPki();
    const store = new SessionTicketStore();
    let accepted: TlsServerSession | null = null;
    const bridge = await startSimServer(
      () => new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, sessionTicketStore: store } as never), () => REPLY,
      (session) => { accepted = session; });
    const verifier = new CertificateVerifier({ trustAnchors: [pki.ca.rootCertificate], clock: () => Date.now() });
    const first = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.3'] } as never);
    await runSimClient(bridge.port, first);
    const second = new TlsClientSession({
      verifier, serverName: 'sim.lab', versions: ['1.3'], resumptionTicket: first.receivedTicket!, earlyData: utf8ToBytes('zero-rtt-body'),
    } as never);
    await runSimClient(bridge.port, second);
    bridge.stop();
    expect(second.earlyDataAccepted).toBe(true);
    expect(bytesToUtf8((accepted as unknown as TlsServerSession).receivedEarlyData!)).toBe('zero-rtt-body');
  }, 60000);
});
