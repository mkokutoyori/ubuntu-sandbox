/**
 * `-outform DER` / `-inform DER` : les commandes du simulateur écrivent et lisent les fichiers DER
 * binaires (x509, req, rsa, pkcs8, crl, dhparam), octet pour octet ceux d'un openssl 3.x réel, et le
 * format d'entrée est reconnu tout seul comme chez openssl 3.0 (FORMAT_UNDEF).
 *
 * MESURÉ avant correctif : `-outform` et `-inform` n'étaient pas lus (la sortie restait du PEM, ou
 * l'option avalait l'opérande suivant), et un fichier DER n'était lu par aucune commande
 * (« unable to load certificate »). Avant correctif, les 8 cas tombent ; le témoin (sans -outform la
 * sortie reste du PEM) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'derfiles-'));
const real = (...args: string[]) => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });

function newServer(tag: string): LinuxServer {
  const srv = new LinuxServer('linux-server', tag); srv.powerOn();
  return srv;
}

function exported(srv: LinuxServer, path: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.from(fileTextToBytes(srv.readTextFile(path) ?? '')));
  return file;
}

function imported(srv: LinuxServer, file: string, path: string): void {
  srv.writeTextFile(path, bytesToFileText(readFileSync(file)));
}

describe('fichiers DER ↔ openssl réel', () => {
  it('x509 -outform DER écrit le certificat que openssl relit et reconvertit en le même PEM', async () => {
    const srv = newServer('X1');
    await srv.executeCommand('openssl req -x509 -newkey rsa:1024 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 5 -subj /CN=der.lab');
    await srv.executeCommand('openssl x509 -in /tmp/c.pem -outform DER -out /tmp/c.der');
    const der = exported(srv, '/tmp/c.der', 'c.der');
    expect(readFileSync(der)[0]).toBe(0x30);
    expect(real('x509', '-inform', 'DER', '-in', der, '-noout', '-subject').stdout).toContain('CN = der.lab');
    const pem = exported(srv, '/tmp/c.pem', 'c.pem');
    expect(real('x509', '-inform', 'DER', '-in', der, '-outform', 'PEM').stdout).toBe(readFileSync(pem, 'utf8'));
  });

  it('le simulateur lit un certificat DER d\'openssl, avec -inform DER et sans', async () => {
    const key = join(dir, 'r.key');
    const crt = join(dir, 'r.crt');
    const der = join(dir, 'r.der');
    real('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '5', '-subj', '/CN=real-der.lab');
    real('x509', '-in', crt, '-outform', 'DER', '-out', der);
    const srv = newServer('X2');
    imported(srv, der, '/tmp/real.der');
    expect(await srv.executeCommand('openssl x509 -inform DER -in /tmp/real.der -noout -subject')).toContain('CN = real-der.lab');
    expect(await srv.executeCommand('openssl x509 -in /tmp/real.der -noout -subject')).toContain('CN = real-der.lab');
  });

  it('req -outform DER : openssl vérifie l\'auto-signature de la demande DER du simulateur', async () => {
    const srv = newServer('R1');
    await srv.executeCommand('openssl genrsa -out /tmp/k.pem 1024');
    await srv.executeCommand('openssl req -new -key /tmp/k.pem -subj /CN=req.lab -outform DER -out /tmp/r.der');
    const der = exported(srv, '/tmp/r.der', 'r1.der');
    const verdict = real('req', '-inform', 'DER', '-in', der, '-noout', '-verify');
    expect(verdict.stderr).toContain('verify OK');
  });

  it('genrsa -outform DER et rsa -inform DER : même clé, même module qu\'openssl', async () => {
    const srv = newServer('K1');
    await srv.executeCommand('openssl genrsa -outform DER -out /tmp/k.der 1024');
    const der = exported(srv, '/tmp/k.der', 'k.der');
    expect(real('rsa', '-inform', 'DER', '-in', der, '-check', '-noout').stdout).toContain('RSA key ok');
    const expected = real('rsa', '-inform', 'DER', '-in', der, '-noout', '-modulus').stdout.trim();
    expect((await srv.executeCommand('openssl rsa -inform DER -in /tmp/k.der -noout -modulus')).trim()).toBe(expected);
    expect((await srv.executeCommand('openssl rsa -in /tmp/k.der -noout -modulus')).trim()).toBe(expected);
  });

  it('le simulateur lit une clé DER d\'openssl (PKCS#8 et PKCS#1)', async () => {
    const pem = join(dir, 'rk.pem');
    real('genrsa', '-out', pem, '1024');
    const pkcs8 = join(dir, 'rk8.der');
    const pkcs1 = join(dir, 'rk1.der');
    real('rsa', '-in', pem, '-outform', 'DER', '-out', pkcs8);
    real('rsa', '-in', pem, '-traditional', '-outform', 'DER', '-out', pkcs1);
    const expected = real('rsa', '-in', pem, '-noout', '-modulus').stdout.trim();
    const srv = newServer('K2');
    imported(srv, pkcs8, '/tmp/p8.der');
    imported(srv, pkcs1, '/tmp/p1.der');
    expect((await srv.executeCommand('openssl rsa -inform DER -in /tmp/p8.der -noout -modulus')).trim()).toBe(expected);
    expect((await srv.executeCommand('openssl rsa -inform DER -in /tmp/p1.der -noout -modulus')).trim()).toBe(expected);
  });

  it('pkcs8 -topk8 -nocrypt -outform DER : openssl relit la clé PKCS#8 DER', async () => {
    const srv = newServer('P1');
    await srv.executeCommand('openssl genrsa -traditional -out /tmp/k.pem 1024');
    await srv.executeCommand('openssl pkcs8 -topk8 -nocrypt -in /tmp/k.pem -outform DER -out /tmp/k8.der');
    const der = exported(srv, '/tmp/k8.der', 'k8.der');
    expect(real('pkcs8', '-inform', 'DER', '-nocrypt', '-in', der, '-out', join(dir, 'k8.pem')).status).toBe(0);
    expect(readFileSync(join(dir, 'k8.pem'), 'utf8')).toContain('BEGIN PRIVATE KEY');
  });

  it('crl -outform DER : openssl lit la CRL DER du simulateur', async () => {
    const srv = newServer('L1');
    const CA = '/etc/ssl/CA';
    const sh = (c: string): Promise<string> => srv.executeCommand(c);
    await sh(`mkdir -p ${CA}`);
    await sh(`sh -c 'echo 1000 > ${CA}/serial; echo 1000 > ${CA}/crlnumber; : > ${CA}/index.txt'`);
    await sh(`openssl req -x509 -newkey rsa:1024 -nodes -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -subj "/CN=Lab CA"`);
    await sh(`openssl ca -config ca.cnf -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -gencrl -out /tmp/c.crl`);
    await sh('openssl crl -in /tmp/c.crl -outform DER -out /tmp/c.der');
    const der = exported(srv, '/tmp/c.der', 'c-crl.der');
    expect(real('crl', '-inform', 'DER', '-in', der, '-noout', '-issuer').stdout).toContain('CN = Lab CA');
  });

  it('dhparam -outform DER : openssl relit les paramètres DER', async () => {
    const srv = newServer('D1');
    await srv.executeCommand('openssl dhparam -outform DER -out /tmp/dh.der 2048');
    const der = exported(srv, '/tmp/dh.der', 'dh.der');
    expect(real('dhparam', '-inform', 'DER', '-in', der, '-noout', '-text').stdout).toContain('DH Parameters: (2048 bit)');
    expect(await srv.executeCommand('openssl dhparam -inform DER -in /tmp/dh.der -noout -text')).toContain('DH Parameters: (2048 bit)');
  });

  it('WITNESS — sans -outform la sortie reste du PEM', async () => {
    const srv = newServer('W1');
    await srv.executeCommand('openssl req -x509 -newkey rsa:1024 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 5 -subj /CN=pem.lab');
    expect(srv.readTextFile('/tmp/c.pem')).toContain('-----BEGIN CERTIFICATE-----');
  });
});
