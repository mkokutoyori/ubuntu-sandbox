/**
 * Un corps HTTPS binaire traverse TLS octet pour octet, dans les deux sens (requête POST et réponse) : la couche HTTP/1.1 manipule une
 * chaîne d'octets (un caractère par octet, comme la voie en clair) et HttpsClientSession/HttpsServerSession doivent la convertir sans
 * UTF-8, sinon tout octet ≥ 0x80 (DER, archive, image) est remplacé ou doublé.
 *
 * MESURÉ avant correctif : les deux sessions passaient par TextEncoder/TextDecoder. Entre deux sessions du simulateur le double
 * encodage est symétrique et ne se voit pas ; face à un vrai curl, chaque octet ≥ 0x80 était doublé en UTF-8. Avant correctif
 * (git stash de src/network) 2 cas sur 5 tombent : les deux qui font intervenir un vrai curl (téléchargement et envoi). Les trois cas
 * sim ↔ sim passent dans les deux états (témoins : l'ASCII, et la symétrie du double encodage qui masquait le défaut).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTcpRelay } from './_tcpRelay';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { createRequest, createResponse } from '@/network/http/semantics/types';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const NOW = Date.now();
const BINARY = Uint8Array.from({ length: 256 }, (_, index) => index);
const ASCII = new TextEncoder().encode('plain ascii body');

function lab() {
  const server = new LinuxPC('linux-pc', 'BSRV');
  const client = new LinuxPC('linux-pc', 'BCLI');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.96.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.96.20'), mask);
  const ca = CertificateAuthority.generate('CN=bin-ca', { now: NOW });
  const leaf = ca.issueCertificate({ subject: 'CN=example.test', subjectAltNames: ['example.test'], notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const trust = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const received: Uint8Array[] = [];
  new HttpsServerSession((server as unknown as EndHost).getTcpStack(), 8470, { serverCert: leaf.cert, serverPrivateKey: leaf.privateKey } as never, (request) => {
    if (request.body) received.push(request.body);
    const response = createResponse(200, 'OK');
    response.body = request.method === 'POST' ? ASCII : BINARY;
    return response;
  }).start();
  const session = new HttpsClientSession((client as unknown as EndHost).getTcpStack(), '192.168.96.10', 8470, { verifier: trust, serverName: 'example.test' } as never);
  return { session, received, server };
}

function realCurl(args: readonly string[]): Promise<{ stdout: Buffer; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sk', '--noproxy', '*', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => { chunks.push(d); });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(chunks), code }); });
  });
}

describe('corps HTTPS binaires face à un vrai curl', () => {
  it('un vrai curl télécharge 256 octets distincts du serveur simulé sans altération', async () => {
    const { server } = lab();
    const relay = await startTcpRelay(server.getTcpStack(), '192.168.96.10', 8470);
    const got = await realCurl([`https://127.0.0.1:${relay.port}/down`]);
    relay.stop();
    expect(got.code).toBe(0);
    expect(Array.from(got.stdout)).toEqual(Array.from(BINARY));
  }, 40000);

  it('un vrai curl envoie 256 octets distincts au serveur simulé, qui les reçoit sans altération', async () => {
    const { server, received } = lab();
    const relay = await startTcpRelay(server.getTcpStack(), '192.168.96.10', 8470);
    const dir = mkdtempSync(join(tmpdir(), 'bin-'));
    const file = join(dir, 'payload.bin');
    writeFileSync(file, Buffer.from(BINARY));
    const got = await realCurl(['--data-binary', `@${file}`, '-H', 'Content-Type: application/octet-stream', `https://127.0.0.1:${relay.port}/up`]);
    relay.stop();
    expect(got.code).toBe(0);
    expect(received.map((body) => Array.from(body))).toEqual([Array.from(BINARY)]);
  }, 40000);
});

describe('corps HTTPS binaires', () => {
  it('témoin : un corps ASCII passe', () => {
    const { session } = lab();
    const request = createRequest('POST', '/up');
    request.body = ASCII;
    request.headers.set('Content-Length', String(ASCII.length));
    const result = session.send(request);
    expect(result.ok).toBe(true);
    expect(Array.from(result.response!.body ?? [])).toEqual(Array.from(ASCII));
  });

  it('la réponse de 256 octets distincts arrive intacte', () => {
    const { session } = lab();
    const result = session.send(createRequest('GET', '/down'));
    expect(result.ok).toBe(true);
    expect(Array.from(result.response!.body ?? [])).toEqual(Array.from(BINARY));
  });

  it('la requête POST de 256 octets distincts arrive intacte', () => {
    const { session, received } = lab();
    const request = createRequest('POST', '/up');
    request.body = BINARY;
    request.headers.set('Content-Length', String(BINARY.length));
    expect(session.send(request).ok).toBe(true);
    expect(received.map((body) => Array.from(body))).toEqual([Array.from(BINARY)]);
  });
});
