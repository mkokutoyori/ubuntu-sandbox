import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCompleteRecords, encodeRecords } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';
import type { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsServerSession } from '@/network/tls/TlsServerSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { pemToCert } from '@/network/pki/pem';
import type { X509Certificate } from '@/network/pki/X509Certificate';

export interface RealKeyMaterial {
  readonly dir: string;
  readonly certificatePath: string;
  readonly keyPath: string;
  readonly certificate: X509Certificate;
}

export function realCertificate(subject: string, algorithm: 'rsa' | 'ec' = 'rsa'): RealKeyMaterial {
  const dir = mkdtempSync(join(tmpdir(), 'interop-'));
  const certificatePath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const keyArgs = algorithm === 'rsa' ? ['-newkey', 'rsa:2048'] : ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
  spawnSync('openssl', ['req', '-x509', ...keyArgs, '-nodes', '-keyout', keyPath, '-out', certificatePath, '-days', '5', '-subj', `/CN=${subject}`, '-addext', `subjectAltName=DNS:${subject}`]);
  return { dir, certificatePath, keyPath, certificate: pemToCert(readFileSync(certificatePath, 'utf8'))! };
}

export interface RealServer {
  readonly port: number;
  readonly material: RealKeyMaterial;
  output(): string;
  stop(): void;
}

export async function startRealServer(material: RealKeyMaterial, extraArgs: string[] = []): Promise<RealServer> {
  const port = 14000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn('openssl', ['s_server', '-accept', String(port), '-cert', material.certificatePath, '-key', material.keyPath, '-www', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (d) => { log += d; });
  child.stderr!.on('data', (d) => { log += d; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { port, material, output: () => log, stop: () => { child.kill(); } };
}

export interface ClientRun {
  readonly steps: string[];
  readonly response: string;
}

export async function runSimClient(port: number, client: TlsClientSession, request = 'GET / HTTP/1.0\r\n\r\n', timeoutMs = 4000): Promise<ClientRun> {
  const steps: string[] = [];
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
  let pending = new Uint8Array(0);
  let serverSequence = 0;
  let response = '';
  let sentRequest = false;
  const outcome = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = (): void => { clearTimeout(timer); resolve(); };
    socket.on('data', (data) => {
      const joined = new Uint8Array(pending.length + data.length);
      joined.set(pending); joined.set(data, pending.length);
      const { records, bytesConsumed } = decodeCompleteRecords(joined);
      pending = joined.slice(bytesConsumed);
      if (records.length === 0) return;
      if (client.result === null) {
        const out = client.handle(records);
        steps.push(`handshake: result=${client.result} alert=${client.lastAlert?.description ?? '-'}`);
        if (out && out.length > 0) socket.write(encodeRecords(out));
        if (client.result === 'failure') return done();
        if (client.result === 'success' && !sentRequest) {
          sentRequest = true;
          socket.write(encodeRecords(encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes(request)).records));
        }
        return;
      }
      const consumed = client.receivedTicket === null ? client.receiveSessionTicket(records) : 0;
      const applicationRecords = records.slice(consumed).filter((record: TlsRecord) => record.contentType === 'application_data');
      if (applicationRecords.length === 0) return;
      try {
        const opened = decryptApplicationData(client.serverTraffic(), serverSequence, applicationRecords);
        serverSequence = opened.nextSeq;
        response += bytesToUtf8(opened.plaintext);
        steps.push(`application data: ${opened.plaintext.length} bytes`);
      } catch (error) {
        steps.push(`application error: ${(error as Error).message}`);
      }
    });
    socket.on('close', done);
  });
  socket.write(encodeRecords(client.start()));
  await outcome;
  socket.destroy();
  return { steps, response };
}

export interface BridgedServer {
  readonly port: number;
  readonly steps: string[];
  stop(): void;
}

export async function startSimServer(
  makeServer: () => TlsServerSession, respond: (request: string) => string,
  onAccepted?: (session: TlsServerSession) => void,
): Promise<BridgedServer> {
  const steps: string[] = [];
  const server = net.createServer((socket) => {
    const tls = makeServer();
    let pending = new Uint8Array(0);
    let clientSequence = 0;
    let serverSequence = 0;
    socket.on('data', (data) => {
      const joined = new Uint8Array(pending.length + data.length);
      joined.set(pending); joined.set(data, pending.length);
      const { records, bytesConsumed } = decodeCompleteRecords(joined);
      pending = joined.slice(bytesConsumed);
      if (records.length === 0) return;
      if (tls.result === null || tls.result === undefined) {
        steps.push(`recv ${records.map((r) => `${r.contentType}:${r.fragment.length}`).join(',')}`);
        const out = tls.handle(records);
        steps.push(`handshake: result=${tls.result} alert=${tls.lastAlert?.description ?? '-'}`);
        if (out && out.length > 0) socket.write(encodeRecords(out));
        if (tls.result === 'reject') socket.end();
        if (tls.result !== 'accept') return;
        onAccepted?.(tls);
        const trailing = tls.takeTrailingRecords();
        if (trailing.length === 0) return;
        records.splice(0, records.length, ...trailing);
      }
      const applicationRecords = records.filter((record: TlsRecord) => record.contentType === 'application_data');
      if (applicationRecords.length === 0) return;
      try {
        const opened = decryptApplicationData(tls.clientTraffic(), clientSequence, applicationRecords);
        clientSequence = opened.nextSeq;
        if (opened.peerKeyUpdates) {
          const reply = tls.applyPeerKeyUpdates(opened.peerKeyUpdates, opened.peerRequestedKeyUpdate === true, serverSequence);
          if (reply.length > 0) { socket.write(encodeRecords([...reply])); serverSequence = 0; }
          if (opened.plaintext.length === 0) return;
        }
        const answer = utf8ToBytes(respond(bytesToUtf8(opened.plaintext)));
        const sealed = encryptApplicationData(tls.serverTraffic(), serverSequence, answer);
        serverSequence = sealed.nextSeq;
        socket.write(encodeRecords(sealed.records));
        steps.push(`served ${answer.length} bytes`);
      } catch (error) {
        steps.push(`server error: ${(error as Error).message}`);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, steps, stop: () => { server.close(); } };
}

export interface RealClientRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export async function runRealClient(args: string[], input = 'GET / HTTP/1.0\r\n\r\n', timeoutMs = 8000): Promise<RealClientRun> {
  const child = spawn('openssl', ['s_client', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.write(input);
  setTimeout(() => child.stdin.end(), 700);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
  clearTimeout(timer);
  return { stdout, stderr, code };
}
