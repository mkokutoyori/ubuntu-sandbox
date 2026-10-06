/**
 * Les clés du simulateur sont du DER réel (RFC 5208 PKCS#8, RFC 8017 PKCS#1, RFC 5915 SEC1,
 * RFC 5280 SPKI, RFC 8018 PBES2 pour les clés chiffrées) : un openssl 3.x réel lit et contrôle
 * ce que `openssl genrsa`/`ecparam`/`pkcs8`/`rsa` du simulateur écrivent, et le simulateur lit
 * ce qu'un openssl réel fabrique.
 *
 * MESURÉ avant correctif : la charge d'un bloc PRIVATE KEY était du JSON (`{"algorithm":"rsa",
 * "material":"rsa-priv:…"}`) ; openssl répondait « Could not read private key » ; la clé chiffrée
 * était un JSON AES maison. Avant correctif, les 8 cas tombent (aucun témoin : l'oracle est un
 * processus externe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'keyder-'));
const real = (...args: string[]) => spawnSync('openssl', args, { encoding: 'utf8' });

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'K'); srv.powerOn();
  return srv;
}

async function exported(srv: LinuxServer, path: string, name: string): Promise<string> {
  const file = join(dir, name);
  writeFileSync(file, await srv.executeCommand(`cat ${path}`));
  return file;
}

describe('clés ↔ openssl réel', () => {
  it('genrsa : openssl valide la clé (RSA key ok) et en donne le même module', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -out /tmp/k.pem 1024');
    const file = await exported(srv, '/tmp/k.pem', 'rsa.pem');
    expect(real('rsa', '-in', file, '-check', '-noout').stdout).toContain('RSA key ok');
    const expected = real('rsa', '-in', file, '-noout', '-modulus').stdout.trim();
    expect((await srv.executeCommand('openssl rsa -in /tmp/k.pem -noout -modulus')).trim()).toBe(expected);
  });

  it('genrsa -traditional : la forme PKCS#1 « RSA PRIVATE KEY » se lit aussi', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -traditional -out /tmp/k.pem 1024');
    const file = await exported(srv, '/tmp/k.pem', 'rsa-trad.pem');
    expect(readFileSync(file, 'utf8')).toContain('BEGIN RSA PRIVATE KEY');
    expect(real('rsa', '-in', file, '-check', '-noout').stdout).toContain('RSA key ok');
  });

  it('rsa -pubout : une clé publique SPKI que openssl lit', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -out /tmp/k.pem 1024');
    await srv.executeCommand('openssl rsa -in /tmp/k.pem -pubout -out /tmp/pub.pem');
    const file = await exported(srv, '/tmp/pub.pem', 'pub.pem');
    expect(real('pkey', '-pubin', '-in', file, '-noout', '-text').stdout).toContain('Public-Key: (1024 bit)');
  });

  it('genrsa -aes256 -passout : PKCS#8 chiffré en PBES2, déchiffré par openssl avec la même phrase', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -aes256 -passout pass:secret1 -out /tmp/enc.pem 1024');
    const file = await exported(srv, '/tmp/enc.pem', 'enc.pem');
    expect(readFileSync(file, 'utf8')).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(real('rsa', '-in', file, '-passin', 'pass:secret1', '-check', '-noout').stdout).toContain('RSA key ok');
    expect(real('rsa', '-in', file, '-passin', 'pass:mauvaise', '-noout').status).not.toBe(0);
  });

  it('une clé EC du simulateur est une clé SEC1/PKCS#8 valide pour openssl', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl ecparam -name prime256v1 -genkey -noout -out /tmp/ec.pem');
    const file = await exported(srv, '/tmp/ec.pem', 'ec.pem');
    expect(real('ec', '-in', file, '-check', '-noout').stderr).toContain('EC Key valid');
  });

  it('le simulateur lit une clé RSA PKCS#8 fabriquée par openssl et en donne le même module', async () => {
    const file = join(dir, 'real-rsa.pem');
    real('genrsa', '-out', file, '2048');
    const expected = real('rsa', '-in', file, '-noout', '-modulus').stdout.trim();
    const srv = await lab();
    await srv.executeCommand(`sh -c 'echo ${readFileSync(file).toString('base64')} | base64 -d > /tmp/real.pem'`);
    expect((await srv.executeCommand('openssl rsa -in /tmp/real.pem -noout -modulus')).trim()).toBe(expected);
  });

  it('le simulateur lit une clé chiffrée par openssl (PBES2, AES-256-CBC, PBKDF2-SHA256)', async () => {
    const plain = join(dir, 'p.pem');
    const enc = join(dir, 'e.pem');
    real('genrsa', '-out', plain, '1024');
    real('pkcs8', '-topk8', '-in', plain, '-out', enc, '-v2', 'aes-256-cbc', '-passout', 'pass:hunter2');
    const expected = real('rsa', '-in', plain, '-noout', '-modulus').stdout.trim();
    const srv = await lab();
    await srv.executeCommand(`sh -c 'echo ${readFileSync(enc).toString('base64')} | base64 -d > /tmp/enc.pem'`);
    expect((await srv.executeCommand('openssl rsa -in /tmp/enc.pem -passin pass:hunter2 -noout -modulus')).trim()).toBe(expected);
  });

  it('le simulateur lit une clé EC fabriquée par openssl', async () => {
    const file = join(dir, 'real-ec.pem');
    real('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file);
    const srv = await lab();
    await srv.executeCommand(`sh -c 'echo ${readFileSync(file).toString('base64')} | base64 -d > /tmp/real-ec.pem'`);
    const out = await srv.executeCommand('openssl ec -in /tmp/real-ec.pem -noout -text');
    expect(out).toContain('prime256v1');
  });
});
