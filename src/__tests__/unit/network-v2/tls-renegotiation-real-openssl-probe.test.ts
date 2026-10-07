/**
 * La renégociation sécurisée de TLS ≤ 1.2 (RFC 5746) traverse le fil : le client rouvre une poignée de main
 * complète DANS la connexion chiffrée (ClientHello scellé sous les clés courantes, renegotiation_info =
 * verify_data du Finished précédent), le serveur répond avec le verify_data concaténé, les deux côtés
 * changent de clés, puis les données applicatives reprennent à la séquence 0 sous les nouvelles clés.
 * `s_client` réel déclenche la renégociation par la commande « R ».
 *
 * MESURÉ avant correctif : le serveur du simulateur traitait le ClientHello chiffré comme des données applicatives et
 * répondait par la page, sans jamais renégocier (le compteur `renegotiations` de la session restait à zéro ; une
 * assertion sur « ok » seule aurait passé à tort, la réponse du laboratoire étant constante). Avant correctif (git stash de
 * src/network) 4 cas sur 4 tombent, le témoin lui-même pour une raison structurelle (la propriété `renegotiations`
 * n'existait pas) ; la valeur du témoin tient à ce qu'il prouve que le laboratoire sert une requête sans « R ».
 * Les détails du fil établis en mesurant : le ChangeCipherSpec de la renégociation est PROTÉGÉ par les clés courantes
 * (RFC 5246 §6.1), et le client réel envoie CKE et CCS/Finished en segments séparés.
 *
 * Côté client et HelloRequest (étape suivante) : le client du simulateur renégocie avec un vrai s_server lancé avec
 * -client_renegotiation, constate l'alerte no_renegotiation du défaut d'openssl 3, suit un HelloRequest lancé par la
 * commande R d'un vrai s_server, et le serveur du simulateur lance lui-même une renégociation qu'un vrai s_client suit.
 * Mesuré ensuite : renégocier une session qui a elle-même été reprise (abrégée) fonctionne déjà, ce cas est un témoin qui passe dans les
 * deux états. Avant ce second correctif (git stash de src/network et src/terminal) 5 cas sur 9 tombent dans ce fichier et 2 sur 8 dans
 * openssl-s-client-interactive ; les quatre cas de la première étape passent dans les deux états, déjà commités.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { LegacySessionStore } from '@/network/tls/legacy/legacySessions';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem } from '@/network/pki/pem';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { realCertificate, runSimClient, startSimServer } from './_realOpenssl';

const REPLY = 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok';

function simPki() {
  const now = Date.now();
  const ca = CertificateAuthority.generate('CN=sim.lab CA', { now, algorithm: 'rsa', keyBits: 2048 });
  const leaf = ca.issueCertificate({ subject: 'CN=sim.lab', subjectAltNames: ['sim.lab'], notBefore: now - 1000, notAfter: now + 30 * 86400_000, keyBits: 2048 });
  const dir = mkdtempSync(join(tmpdir(), 'reneg-'));
  const caPath = join(dir, 'ca.pem');
  writeFileSync(caPath, certToPem(ca.rootCertificate));
  return { ca, leaf, caPath };
}

async function interactive(port: number, caPath: string, lines: readonly string[], extra: readonly string[] = []): Promise<{ stdout: string; stderr: string }> {
  const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, '-servername', 'sim.lab', '-CAfile', caPath, '-tls1_2', ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => undefined);
  const closed = new Promise((resolve) => child.on('close', resolve));
  const timer = setTimeout(() => child.kill(), 12000);
  for (const line of lines) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    child.stdin.write(line);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  child.stdin.end();
  await closed;
  clearTimeout(timer);
  return { stdout, stderr };
}

let lastSession: TlsServerSession | null = null;

const server = (pki: ReturnType<typeof simPki>, extra: object = {}) =>
  () => { lastSession = new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey, ...extra } as never); return lastSession; };

describe('renégociation TLS ≤ 1.2 ↔ openssl réel', () => {
  it('témoin : une requête sans renégociation est servie', async () => {
    const pki = simPki();
    const bridge = await startSimServer(server(pki), () => REPLY);
    const run = await interactive(pki.leaf ? bridge.port : 0, pki.caPath, ['GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(run.stdout).toContain('ok');
    expect(lastSession!.renegotiations).toBe(0);
  }, 60000);

  it('R : le serveur mène la renégociation complète puis sert la requête sous les nouvelles clés', async () => {
    const pki = simPki();
    const bridge = await startSimServer(server(pki), () => REPLY);
    const run = await interactive(bridge.port, pki.caPath, ['R\n', 'GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(run.stderr + run.stdout).toContain('RENEGOTIATING');
    expect(lastSession!.renegotiations).toBe(1);
    expect(run.stdout).toContain('ok');
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 60000);

  it('deux renégociations de suite puis une requête', async () => {
    const pki = simPki();
    const bridge = await startSimServer(server(pki), () => REPLY);
    const run = await interactive(bridge.port, pki.caPath, ['R\n', 'R\n', 'GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(lastSession!.renegotiations).toBe(2);
    expect(run.stdout).toContain('ok');
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 60000);

  it('allowRenegotiation: false : le serveur répond no_renegotiation, que le vrai client traite comme une erreur', async () => {
    const pki = simPki();
    const bridge = await startSimServer(server(pki, { allowRenegotiation: false }), () => REPLY);
    const run = await interactive(bridge.port, pki.caPath, ['R\n', 'GET / HTTP/1.0\r\n\r\n']);
    bridge.stop();
    expect(run.stderr).toContain('no renegotiation');
    expect(lastSession!.renegotiations).toBe(0);
    expect(run.stdout).not.toContain('\nok');
  }, 60000);
});

describe('renégociation TLS ≤ 1.2 : côté client et HelloRequest', () => {
  it('le client du simulateur renégocie avec un vrai s_server, puis la requête est servie', async () => {
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', '-tls1_2', '-client_renegotiation'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.2'] } as never);
    const run = await runSimClient(port, client, 'GET / HTTP/1.0\r\n\r\n', 6000, { renegotiateBeforeRequest: true });
    child.kill();
    expect(client.result).toBe('success');
    expect(client.renegotiations).toBe(1);
    expect(run.response).toContain('HTTP/1.0 200 ok');
  }, 60000);

  it("un vrai s_server qui n'autorise pas la renégociation du client (défaut d'openssl 3) répond no_renegotiation : le client simulé le constate", async () => {
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', '-tls1_2'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.2'] } as never);
    await runSimClient(port, client, 'GET / HTTP/1.0\r\n\r\n', 6000, { renegotiateBeforeRequest: true });
    child.kill();
    expect(client.renegotiations).toBe(0);
    expect(client.peerAlert?.description).toBe('no_renegotiation');
  }, 60000);

  it("un vrai s_server lance la renégociation (commande R, HelloRequest) : le client simulé la suit et la poignée de main aboutit", async () => {
    const material = realCertificate('real.lab');
    const port = 14000 + Math.floor(Math.random() * 20000);
    const child = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-tls1_2'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const verifier = new CertificateVerifier({ trustAnchors: [material.certificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'real.lab', versions: ['1.2'] } as never);
    setTimeout(() => child.stdin.write('R\n'), 1800);
    const run = await runSimClient(port, client, 'GET / HTTP/1.0\r\n\r\n', 5000);
    child.kill();
    expect(client.result).toBe('success');
    expect(client.renegotiations).toBe(1);
    expect(run.steps).toContain('renegotiation completed');
  }, 60000);

  it('sim ↔ sim : le client renégocie, le serveur le suit, la requête passe sous les nouvelles clés', async () => {
    const pki = simPki();
    let session: TlsServerSession | null = null;
    const bridge = await startSimServer(() => { session = new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey } as never); return session; }, () => REPLY);
    const verifier = new CertificateVerifier({ trustAnchors: [pki.ca.rootCertificate], clock: () => Date.now() });
    const client = new TlsClientSession({ verifier, serverName: 'sim.lab', versions: ['1.2'] } as never);
    const run = await runSimClient(bridge.port, client, 'GET / HTTP/1.0\r\n\r\n', 6000, { renegotiateBeforeRequest: true });
    bridge.stop();
    expect(client.renegotiations).toBe(1);
    expect(session!.renegotiations).toBe(1);
    expect(run.response).toContain('HTTP/1.0 200 OK');
  }, 60000);

  it('le serveur du simulateur lance la renégociation (HelloRequest) et un vrai s_client la suit', async () => {
    const pki = simPki();
    let session: TlsServerSession | null = null;
    const bridge = await startSimServer(() => { session = new TlsServerSession({ serverCert: pki.leaf.cert, serverPrivateKey: pki.leaf.privateKey } as never); return session; }, () => REPLY);
    const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${bridge.port}`, '-servername', 'sim.lab', '-CAfile', pki.caPath, '-tls1_2'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.on('error', () => undefined);
    const closed = new Promise((resolve) => child.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(bridge.requestRenegotiation()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.stdin.write('GET / HTTP/1.0\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    child.stdin.end();
    await closed;
    bridge.stop();
    expect(session!.renegotiations).toBe(1);
    expect(out).toContain('ok');
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 60000);

  it("renégociation d'une session qui a elle-même été reprise (abrégée) : la poignée de main complète suit, la requête est servie", async () => {
    const pki = simPki();
    const bridge = await startSimServer(server(pki, { legacySessionStore: new LegacySessionStore() }), () => REPLY);
    const dir = mkdtempSync(join(tmpdir(), 'reneg-'));
    const file = join(dir, 'session.pem');
    await interactive(bridge.port, pki.caPath, ['GET / HTTP/1.0\r\n\r\n'], ['-sess_out', file]);
    const run = await interactive(bridge.port, pki.caPath, ['R\n', 'GET / HTTP/1.0\r\n\r\n'], ['-sess_in', file]);
    bridge.stop();
    expect(run.stdout).toContain('Reused, TLSv1.2');
    expect(run.stderr + run.stdout).toContain('RENEGOTIATING');
    expect(lastSession!.renegotiations).toBe(1);
    expect(run.stdout).toContain('ok');
    expect(bridge.steps.join('|')).not.toContain('bad_record_mac');
  }, 90000);
});
