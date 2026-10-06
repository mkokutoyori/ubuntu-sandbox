/**
 * Le chiffrement des clés privées suit le chiffrement demandé et les deux formats d'openssl : la forme
 * historique « Proc-Type: 4,ENCRYPTED / DEK-Info » (EVP_BytesToKey MD5 + AES-CBC ou 3DES-CBC, avec
 * -traditional) et PKCS#8 chiffré PBES2 (RFC 8018) avec le chiffrement choisi par -aes128/-aes192/
 * -aes256/-des3 ou par -v2. Un openssl 3.x réel lit ce que le simulateur écrit avec la phrase, et le
 * simulateur lit ce qu'openssl écrit.
 *
 * MESURÉ avant correctif : -aes128, -aes192 et -des3 étaient acceptés puis ignorés (la clé sortait
 * toujours en AES-256), -v2 n'était pas lu, -traditional avec un chiffrement sortait du PKCS#8, et la
 * forme Proc-Type/DEK-Info n'était ni écrite ni lue. Avant
 * correctif, 9 des 11 cas tombent (git stash) ; les deux autres passent dans les deux états et sont des TÉMOINS : la clé EC
 * chiffrée par `ec -aes256` (le PKCS#8 AES-256 était déjà fidèle) et le PKCS#8 aes-256 par défaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const dir = mkdtempSync(join(tmpdir(), 'keyenc-'));
const real = (...args: string[]) => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });

function newServer(tag: string): LinuxServer {
  const srv = new LinuxServer('linux-server', tag); srv.powerOn();
  return srv;
}

function exported(srv: LinuxServer, path: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, srv.readTextFile(path) ?? '');
  return file;
}

describe('clés chiffrées ↔ openssl réel', () => {
  for (const [flag, dek] of [['-aes128', 'AES-128-CBC'], ['-aes192', 'AES-192-CBC'], ['-aes256', 'AES-256-CBC'], ['-des3', 'DES-EDE3-CBC']] as const) {
    it(`genrsa -traditional ${flag} : en-tête DEK-Info ${dek}, déchiffrée par openssl avec la phrase`, async () => {
      const srv = newServer(`T${flag}`);
      await srv.executeCommand(`openssl genrsa -traditional ${flag} -passout pass:phrase1 -out /tmp/k.pem 1024`);
      const text = srv.readTextFile('/tmp/k.pem') ?? '';
      expect(text).toContain('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n');
      expect(text).toMatch(new RegExp(`DEK-Info: ${dek},[0-9A-F]{${dek === 'DES-EDE3-CBC' ? 16 : 32}}\\n`));
      const file = exported(srv, '/tmp/k.pem', `trad${flag}.pem`);
      expect(real('rsa', '-in', file, '-passin', 'pass:phrase1', '-check', '-noout').stdout).toContain('RSA key ok');
      expect(real('rsa', '-in', file, '-passin', 'pass:fausse', '-noout').status).not.toBe(0);
      const modulus = real('rsa', '-in', file, '-passin', 'pass:phrase1', '-noout', '-modulus').stdout.trim();
      expect((await srv.executeCommand('openssl rsa -in /tmp/k.pem -passin pass:phrase1 -noout -modulus')).trim()).toBe(modulus);
    }, 30000);
  }

  it('le simulateur lit une clé traditionnelle chiffrée par openssl (AES-128 et 3DES)', async () => {
    const plain = join(dir, 'r.pem');
    real('genrsa', '-traditional', '-out', plain, '1024');
    const expected = real('rsa', '-in', plain, '-noout', '-modulus').stdout.trim();
    const srv = newServer('TR');
    for (const cipher of ['aes128', 'des3']) {
      const encrypted = join(dir, `r-${cipher}.pem`);
      real('rsa', '-in', plain, '-traditional', `-${cipher}`, '-passout', 'pass:s3cret', '-out', encrypted);
      srv.writeTextFile(`/tmp/${cipher}.pem`, readFileSync(encrypted, 'utf8'));
      expect((await srv.executeCommand(`openssl rsa -in /tmp/${cipher}.pem -passin pass:s3cret -noout -modulus`)).trim()).toBe(expected);
      expect(await srv.executeCommand(`openssl rsa -in /tmp/${cipher}.pem -passin pass:fausse -noout 2>&1`)).toContain('unable to load');
    }
  }, 30000);

  it('genrsa -des3 -passout (PKCS#8) : PBES2 avec DES-EDE3-CBC, déchiffrée par openssl', async () => {
    const srv = newServer('P8');
    await srv.executeCommand('openssl genrsa -des3 -passout pass:phrase2 -out /tmp/k8.pem 1024');
    const file = exported(srv, '/tmp/k8.pem', 'k8-des3.pem');
    expect(readFileSync(file, 'utf8')).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(real('asn1parse', '-in', file).stdout).toContain('des-ede3-cbc');
    expect(real('rsa', '-in', file, '-passin', 'pass:phrase2', '-check', '-noout').stdout).toContain('RSA key ok');
  }, 30000);

  it('genrsa -aes128 -passout (PKCS#8) : PBES2 avec AES-128-CBC', async () => {
    const srv = newServer('P9');
    await srv.executeCommand('openssl genrsa -aes128 -passout pass:phrase3 -out /tmp/k9.pem 1024');
    const file = exported(srv, '/tmp/k9.pem', 'k9-aes128.pem');
    expect(real('asn1parse', '-in', file).stdout).toContain('aes-128-cbc');
    expect(real('rsa', '-in', file, '-passin', 'pass:phrase3', '-check', '-noout').stdout).toContain('RSA key ok');
  }, 30000);

  it('pkcs8 -topk8 -v2 : le chiffrement choisi est celui du fichier, et un nom inconnu est refusé', async () => {
    const srv = newServer('V2');
    await srv.executeCommand('openssl genrsa -traditional -out /tmp/k.pem 1024');
    await srv.executeCommand('openssl pkcs8 -topk8 -v2 aes-192-cbc -passout pass:phrase4 -in /tmp/k.pem -out /tmp/v2.pem');
    expect(real('asn1parse', '-in', exported(srv, '/tmp/v2.pem', 'v2.pem')).stdout).toContain('aes-192-cbc');
    expect(await srv.executeCommand('openssl pkcs8 -topk8 -v2 inconnu -passout pass:x -in /tmp/k.pem 2>&1')).toContain('Unknown cipher inconnu');
  }, 30000);

  it('le simulateur lit un PKCS#8 chiffré en 3DES par openssl', async () => {
    const plain = join(dir, 'p3.pem');
    real('genrsa', '-out', plain, '1024');
    const encrypted = join(dir, 'p3-enc.pem');
    real('pkcs8', '-topk8', '-v2', 'des3', '-passout', 'pass:triple', '-in', plain, '-out', encrypted);
    const expected = real('rsa', '-in', plain, '-noout', '-modulus').stdout.trim();
    const srv = newServer('P3');
    srv.writeTextFile('/tmp/p3.pem', readFileSync(encrypted, 'utf8'));
    expect((await srv.executeCommand('openssl rsa -in /tmp/p3.pem -passin pass:triple -noout -modulus')).trim()).toBe(expected);
  }, 30000);

  it('une clé EC chiffrée en traditionnel est lue par openssl', async () => {
    const srv = newServer('EC');
    await srv.executeCommand('openssl ecparam -name prime256v1 -genkey -noout -out /tmp/ec.pem');
    await srv.executeCommand('openssl ec -in /tmp/ec.pem -aes256 -passout pass:eckey -out /tmp/ec-enc.pem');
    const file = exported(srv, '/tmp/ec-enc.pem', 'ec-enc.pem');
    expect(real('ec', '-in', file, '-passin', 'pass:eckey', '-check', '-noout').stderr).toContain('EC Key valid');
  }, 30000);

  it('WITNESS — aes-256 PKCS#8 par défaut', async () => {
    const srv = newServer('W');
    await srv.executeCommand('openssl genrsa -aes256 -passout pass:phrase5 -out /tmp/w.pem 1024');
    const file = exported(srv, '/tmp/w.pem', 'w.pem');
    expect(real('rsa', '-in', file, '-passin', 'pass:phrase5', '-check', '-noout').stdout).toContain('RSA key ok');
  }, 30000);
});
