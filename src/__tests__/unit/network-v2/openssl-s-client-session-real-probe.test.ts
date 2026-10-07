/**
 * `openssl s_client -sess_out / -sess_in / -early_data` échange le VRAI format de fichier d'openssl : une structure DER SSL_SESSION
 * (ssl/ssl_asn1.c) en armure « SSL SESSION PARAMETERS ». Le fichier écrit par le simulateur est relu par le vrai `openssl sess_id` et
 * rejoué par un vrai s_client contre le serveur simulé ; le fichier écrit par un vrai s_client est rejoué par celui du simulateur. Le
 * rapport suit openssl : « Reused, » au lieu de « New, », « Early data was accepted | rejected | not sent » (les données précoces ne
 * partent que si le ticket annonce un Max Early Data non nul), et le serveur nginx simulé décide par `ssl_early_data`.
 *
 * MESURÉ avant correctif : -sess_out, -sess_in et -early_data n'étaient pas des options de s_client du simulateur (ignorées sans
 * rien écrire), le rapport disait toujours « New » et « Early data was not sent ». Avant correctif (git stash de src/network) 7 cas
 * sur 8 tombent ; le témoin (le vrai openssl reprend sa propre session sur le serveur simulé) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh } from './_httpsLab';
import { startTcpRelay } from './_tcpRelay';
import { sslSessionFromPem, sslSessionToPem } from '@/network/tls/sslSession';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function real(args: readonly string[], input = 'GET / HTTP/1.0\r\n\r\n'): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('openssl', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.write(input);
    setTimeout(() => child.stdin.end(), 700);
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
  });
}

async function lab(earlyData: boolean) {
  const srv = machine();
  await sh(srv, `mkdir -p ${PKI}`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/srv.key -out ${PKI}/srv.crt -days 365 -nodes -subj "/CN=lab.local"`);
  const body = `server {\\n  listen 443 ssl;\\n  server_name lab.local;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n  ssl_certificate ${PKI}/srv.crt;\\n  ssl_certificate_key ${PKI}/srv.key;\\n  ssl_early_data ${earlyData ? 'on' : 'off'};\\n}\\n`;
  await sh(srv, `sh -c 'printf "${body}" > /etc/nginx/sites-available/default'`);
  await sh(srv, 'systemctl start nginx');
  return srv;
}

const SESSION = '/tmp/sim-session.pem';
const EARLY = '/tmp/early.txt';

async function simSession(srv: Awaited<ReturnType<typeof lab>>, version = '-tls1_3'): Promise<string> {
  await sh(srv, `openssl s_client -connect 127.0.0.1:443 ${version} -sess_out ${SESSION} </dev/null`);
  return sh(srv, `cat ${SESSION}`);
}

describe('s_client -sess_out / -sess_in ↔ openssl réel', () => {
  it('témoin : le vrai openssl reprend sa propre session sur le serveur simulé', async () => {
    const srv = await lab(true);
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    const file = join(dir, 'real.pem');
    const args = ['s_client', '-connect', `127.0.0.1:${relay.port}`, '-tls1_3'];
    await real([...args, '-sess_out', file]);
    const second = await real([...args, '-sess_in', file]);
    relay.stop();
    expect(second.stdout).toContain('Reused, TLSv1.3');
  }, 60000);

  it("le fichier écrit par le simulateur est une SSL_SESSION que le vrai `openssl sess_id` lit", async () => {
    const srv = await lab(true);
    const pem = await simSession(srv);
    expect(pem).toContain('-----BEGIN SSL SESSION PARAMETERS-----');
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    const file = join(dir, 'sim.pem');
    writeFileSync(file, pem.endsWith('\n') ? pem : `${pem}\n`);
    const text = await real(['sess_id', '-inform', 'PEM', '-in', file, '-noout', '-text'], '');
    expect(text.stdout).toContain('Protocol  : TLSv1.3');
    expect(text.stdout).toContain('Max Early Data: 16384');
    expect(text.stdout).toContain('TLS session ticket lifetime hint');
  }, 60000);

  it('un vrai s_client rejoue le fichier du simulateur : Reused', async () => {
    const srv = await lab(true);
    const pem = await simSession(srv);
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    const file = join(dir, 'sim.pem');
    writeFileSync(file, pem.endsWith('\n') ? pem : `${pem}\n`);
    const second = await real(['s_client', '-connect', `127.0.0.1:${relay.port}`, '-tls1_3', '-sess_in', file]);
    relay.stop();
    expect(second.stdout).toContain('Reused, TLSv1.3');
  }, 60000);

  it('le s_client du simulateur rejoue le fichier d\'un vrai s_client : Reused', async () => {
    const srv = await lab(true);
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 443);
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    const file = join(dir, 'real.pem');
    await real(['s_client', '-connect', `127.0.0.1:${relay.port}`, '-tls1_3', '-sess_out', file]);
    relay.stop();
    const encoded = readFileSync(file).toString('base64');
    await sh(srv, `sh -c 'echo ${encoded} | base64 -d > ${SESSION}'`);
    const report = await sh(srv, `openssl s_client -connect 127.0.0.1:443 -tls1_3 -sess_in ${SESSION} </dev/null`);
    expect(report).toContain('Reused, TLSv1.3');
    expect(report).toContain('Early data was not sent');
  }, 60000);

  it('données précoces : acceptées quand nginx a ssl_early_data on', async () => {
    const srv = await lab(true);
    await simSession(srv);
    await sh(srv, `sh -c 'printf "GET / HTTP/1.0\\r\\n\\r\\n" > ${EARLY}'`);
    const report = await sh(srv, `openssl s_client -connect 127.0.0.1:443 -tls1_3 -sess_in ${SESSION} -early_data ${EARLY} </dev/null`);
    expect(report).toContain('Reused, TLSv1.3');
    expect(report).toContain('Early data was accepted');
  }, 60000);

  it("ticket sans Max Early Data (serveur en ssl_early_data off) : rien n'est envoyé, comme le vrai client", async () => {
    const srv = await lab(false);
    await simSession(srv);
    await sh(srv, `sh -c 'printf "GET / HTTP/1.0\\r\\n\\r\\n" > ${EARLY}'`);
    const report = await sh(srv, `openssl s_client -connect 127.0.0.1:443 -tls1_3 -sess_in ${SESSION} -early_data ${EARLY} </dev/null`);
    expect(report).toContain('Reused, TLSv1.3');
    expect(report).toContain('Early data was not sent');
  }, 60000);

  it("données précoces dont l'âge de ticket est incohérent avec celui du serveur : Early data was rejected, la session est reprise", async () => {
    const srv = await lab(true);
    const pem = await simSession(srv);
    const aged = sslSessionFromPem(pem)!;
    const stale = sslSessionToPem({ ...aged, time: aged.time - 60 });
    await sh(srv, `sh -c 'echo ${Buffer.from(stale).toString('base64')} | base64 -d > ${SESSION}'`);
    await sh(srv, `sh -c 'printf "GET / HTTP/1.0\\r\\n\\r\\n" > ${EARLY}'`);
    const report = await sh(srv, `openssl s_client -connect 127.0.0.1:443 -tls1_3 -sess_in ${SESSION} -early_data ${EARLY} </dev/null`);
    expect(report).toContain('Reused, TLSv1.3');
    expect(report).toContain('Early data was rejected');
  }, 60000);

  it('TLS 1.2 : le fichier du simulateur est lu par sess_id et la session est reprise', async () => {
    const srv = await lab(true);
    const pem = await simSession(srv, '-tls1_2');
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    const file = join(dir, 'sim12.pem');
    writeFileSync(file, pem.endsWith('\n') ? pem : `${pem}\n`);
    const text = await real(['sess_id', '-inform', 'PEM', '-in', file, '-noout', '-text'], '');
    expect(text.stdout).toContain('Protocol  : TLSv1.2');
    const report = await sh(srv, `openssl s_client -connect 127.0.0.1:443 -tls1_2 -sess_in ${SESSION} </dev/null`);
    expect(report).toContain('Reused, TLSv1.2');
  }, 60000);
});
