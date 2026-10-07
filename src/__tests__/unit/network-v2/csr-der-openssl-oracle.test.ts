/**
 * Les demandes de certificat du simulateur sont du PKCS#10 réel (RFC 2986, attribut
 * extensionRequest de la RFC 2985 §5.4.2) : un openssl 3.x réel vérifie leur auto-signature et lit
 * leur sujet et leurs extensions, et le simulateur lit et VÉRIFIE celles qu'un openssl réel fabrique.
 *
 * MESURÉ avant correctif : la charge d'un bloc CERTIFICATE REQUEST était du JSON ; openssl répondait
 * « Unable to load X509 request » ; `x509 -req` du simulateur annonçait « Certificate request
 * self-signature ok » sans rien vérifier, et signait donc une demande falsifiée ; `req -in` n'existait
 * pas ; `x509 -text` affichait un module RSA de substitution. Avant correctif, les 9 cas tombent (mesuré par git stash) ; aucun n'est neutre, l'oracle étant un processus externe. Le cas WITNESS prouve le laboratoire sain : une demande réelle intacte est signée, la falsification est donc le seul écart du cas voisin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'csrder-'));
const real = (...args: string[]) => spawnSync('openssl', args, { encoding: 'utf8' });

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'C'); srv.powerOn();
  return srv;
}

async function exported(srv: LinuxServer, path: string, name: string): Promise<string> {
  const file = join(dir, name);
  writeFileSync(file, await srv.executeCommand(`cat ${path}`));
  return file;
}

async function imported(srv: LinuxServer, file: string, path: string): Promise<void> {
  await srv.executeCommand(`sh -c 'echo ${readFileSync(file).toString('base64')} | base64 -d > ${path}'`);
}

const SIM_SUBJECT = '/C=FR/O=Banque/CN=web.bank.test';

async function simRequest(srv: LinuxServer): Promise<string> {
  await srv.executeCommand('openssl genrsa -out /tmp/k.pem 1024');
  await srv.executeCommand(`openssl req -new -key /tmp/k.pem -subj ${SIM_SUBJECT} -addext subjectAltName=DNS:web.bank.test,IP:10.0.0.1 -out /tmp/r.csr`);
  return exported(srv, '/tmp/r.csr', 'sim.csr');
}

describe('demandes PKCS#10 ↔ openssl réel', () => {
  it('openssl vérifie l\'auto-signature d\'une demande du simulateur', async () => {
    const file = await simRequest(await lab());
    expect(readFileSync(file, 'utf8')).toContain('BEGIN CERTIFICATE REQUEST');
    const verdict = real('req', '-in', file, '-noout', '-verify');
    expect(verdict.stderr).toContain('self-signature verify OK');
    expect(verdict.status).toBe(0);
  });

  it('openssl lit le sujet et les extensions demandées', async () => {
    const file = await simRequest(await lab());
    expect(real('req', '-in', file, '-noout', '-subject').stdout.trim()).toBe('subject=C = FR, O = Banque, CN = web.bank.test');
    const text = real('req', '-in', file, '-noout', '-text').stdout;
    expect(text).toContain('Requested Extensions');
    expect(text).toContain('DNS:web.bank.test, IP Address:10.0.0.1');
  });

  it('openssl signe une demande du simulateur (il en a vérifié l\'auto-signature)', async () => {
    const srv = await lab();
    const file = await simRequest(srv);
    const key = await exported(srv, '/tmp/k.pem', 'sim.key');
    const out = join(dir, 'signed.pem');
    const result = real('x509', '-req', '-in', file, '-signkey', key, '-out', out, '-days', '30');
    expect(result.stderr).toContain('Certificate request self-signature ok');
    expect(result.status).toBe(0);
  });

  it('le simulateur relit sa propre demande : -verify, -subject', async () => {
    const srv = await lab();
    await simRequest(srv);
    const verdict = await srv.executeCommand('openssl req -in /tmp/r.csr -noout -verify 2>&1');
    expect(verdict).toContain('self-signature verify OK');
    expect((await srv.executeCommand('openssl req -in /tmp/r.csr -noout -subject')).trim()).toBe('subject=C = FR, O = Banque, CN = web.bank.test');
  });

  it('le simulateur lit une demande RSA fabriquée par openssl et en vérifie la signature', async () => {
    const key = join(dir, 'real-rsa.pem');
    const csr = join(dir, 'real-rsa.csr');
    real('genrsa', '-out', key, '2048');
    real('req', '-new', '-key', key, '-subj', '/C=FR/O=Banque/CN=real.bank.test', '-addext', 'subjectAltName=DNS:real.bank.test', '-out', csr);
    const srv = await lab();
    await imported(srv, csr, '/tmp/real.csr');
    expect(await srv.executeCommand('openssl req -in /tmp/real.csr -noout -verify 2>&1')).toContain('self-signature verify OK');
    expect((await srv.executeCommand('openssl req -in /tmp/real.csr -noout -modulus')).trim())
      .toBe(real('req', '-in', csr, '-noout', '-modulus').stdout.trim());
    expect(await srv.executeCommand('openssl req -in /tmp/real.csr -noout -text')).toContain('DNS:real.bank.test');
  });

  it('le simulateur lit une demande ECDSA P-256 fabriquée par openssl', async () => {
    const key = join(dir, 'real-ec.pem');
    const csr = join(dir, 'real-ec.csr');
    real('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key);
    real('req', '-new', '-key', key, '-subj', '/CN=ec.bank.test', '-out', csr);
    const srv = await lab();
    await imported(srv, csr, '/tmp/ec.csr');
    expect(await srv.executeCommand('openssl req -in /tmp/ec.csr -noout -verify 2>&1')).toContain('self-signature verify OK');
  });

  it('WITNESS — x509 -req signe une demande réelle intacte avec -signkey', async () => {
    const key = join(dir, 'w.pem');
    const csr = join(dir, 'w.csr');
    real('genrsa', '-out', key, '1024');
    real('req', '-new', '-key', key, '-subj', '/CN=w.bank.test', '-out', csr);
    const srv = await lab();
    await imported(srv, csr, '/tmp/w.csr');
    await imported(srv, key, '/tmp/w.key');
    const result = await srv.executeCommand('openssl x509 -req -in /tmp/w.csr -signkey /tmp/w.key -out /tmp/w.crt 2>&1');
    expect(result).toContain('self-signature ok');
    const crt = await exported(srv, '/tmp/w.crt', 'w.crt');
    expect(real('x509', '-in', crt, '-noout', '-subject').stdout).toContain('CN = w.bank.test');
  });

  it('une demande falsifiée est refusée : l\'auto-signature ne couvre plus le contenu', async () => {
    const key = join(dir, 'f.pem');
    const csr = join(dir, 'f.csr');
    real('genrsa', '-out', key, '1024');
    real('req', '-new', '-key', key, '-subj', '/CN=genuine.bank.test', '-out', csr);
    const pem = readFileSync(csr, 'utf8');
    const body = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const at = body.indexOf(Buffer.from('genuine'));
    body[at] = 'G'.charCodeAt(0);
    const forged = join(dir, 'forged.csr');
    writeFileSync(forged, `-----BEGIN CERTIFICATE REQUEST-----\n${body.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE REQUEST-----\n`);
    expect(real('req', '-in', forged, '-noout', '-verify').stderr).toContain('verify failure');

    const srv = await lab();
    await imported(srv, forged, '/tmp/forged.csr');
    await imported(srv, key, '/tmp/f.key');
    expect(await srv.executeCommand('openssl req -in /tmp/forged.csr -noout -verify 2>&1')).toContain('verify failure');
    const refused = await srv.executeCommand('openssl x509 -req -in /tmp/forged.csr -signkey /tmp/f.key -out /tmp/f.crt 2>&1');
    expect(refused).toContain('did not match the contents');
    expect(await srv.executeCommand('ls /tmp/f.crt 2>&1')).toContain('No such file');
  });

  it('x509 -text : le module et l\'exposant affichés sont ceux de la clé, comme openssl', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -out /tmp/k.pem 1024');
    await srv.executeCommand('openssl req -x509 -new -key /tmp/k.pem -subj /CN=t.bank.test -days 10 -out /tmp/c.pem');
    const file = await exported(srv, '/tmp/c.pem', 'c.pem');
    const expected = real('x509', '-in', file, '-noout', '-text').stdout;
    const shown = await srv.executeCommand('openssl x509 -in /tmp/c.pem -noout -text');
    const block = (text: string) => text.slice(text.indexOf('Public Key Algorithm'), text.indexOf('Exponent'));
    expect(block(shown)).toBe(block(expected));
    expect(shown).toContain('Exponent: 65537 (0x10001)');
    expect(shown).not.toContain('simulated key material');
  });
});
