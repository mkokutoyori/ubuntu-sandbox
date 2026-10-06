/**
 * `openssl enc` du simulateur chiffre octet pour octet comme openssl 3.0.13 pour chaque chiffrement
 * du fournisseur par défaut dont les primitives existent : AES (CBC, ECB, CTR, CFB, OFB), 3DES à 2 et
 * 3 clés (CBC et ECB, dont l'alias -des3) et ChaCha20. Le sel est fixé (-S, donc sans en-tête Salted__)
 * pour que la comparaison soit exacte, et le déchiffrement du binaire d'openssl par le simulateur est
 * vérifié dans l'autre sens. Les chiffrements du fournisseur « legacy » (RC4, DES, RC2, SEED, BF…)
 * sont refusés avec le texte que donne openssl 3.0 par défaut, et les AEAD par « AEAD ciphers not
 * supported ».
 *
 * MESURÉ avant correctif : seuls aes-*-cbc existaient ; des3, ECB, CTR, CFB, OFB et chacha20 répondaient
 * « not implemented in this simulator », le 3DES au motif que le déchiffrement manquait (il existe
 * depuis, dans crypto/cipher/des.ts) ; les refus legacy/AEAD n'avaient pas le texte d'openssl. Avant
 * correctif, tous les cas de chiffrement et de refus tombent ; le témoin aes-256-cbc (déjà couvert)
 * passe dans les deux états.
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

const dir = mkdtempSync(join(tmpdir(), 'encciph-'));
const PLAIN = 'Procès-verbal du comité des risques — séance du 12 mars, 37 octets+';
const SALT = ['-S', '0011223344556677', '-iter', '100'];
const real = (args: string[], input?: Buffer) => spawnSync('openssl', args, { cwd: dir, input });

function newServer(tag: string): LinuxServer {
  const srv = new LinuxServer('linux-server', tag); srv.powerOn();
  return srv;
}

const CIPHERS = [
  'aes-128-cbc', 'aes-256-cbc', 'aes-128-ecb', 'aes-192-ecb', 'aes-256-ecb',
  'aes-128-ctr', 'aes-256-ctr', 'aes-128-cfb', 'aes-256-cfb', 'aes-128-ofb', 'aes-192-ofb',
  'des-ede3-cbc', 'des3', 'des-ede3', 'des-ede', 'des-ede-cbc', 'chacha20',
];

describe('openssl enc : chiffrements ↔ openssl réel', () => {
  for (const cipher of CIPHERS) {
    it(`${cipher} : même chiffré qu'openssl, et le simulateur déchiffre celui d'openssl`, async () => {
      writeFileSync(join(dir, 'plain.txt'), PLAIN);
      const expected = real(['enc', `-${cipher}`, '-pbkdf2', ...SALT, '-pass', 'pass:motdepasse', '-in', 'plain.txt']);
      expect(expected.status).toBe(0);

      const srv = newServer(`E-${cipher}`);
      srv.writeTextFile('/tmp/plain.txt', PLAIN);
      await srv.executeCommand(`openssl enc -${cipher} -pbkdf2 ${SALT.join(' ')} -pass pass:motdepasse -in /tmp/plain.txt -out /tmp/sim.enc`);
      const produced = Buffer.from(fileTextToBytes(srv.readTextFile('/tmp/sim.enc') ?? ''));
      expect(produced.equals(expected.stdout)).toBe(true);

      srv.writeTextFile('/tmp/real.enc', bytesToFileText(expected.stdout));
      const clear = await srv.executeCommand(`openssl enc -d -${cipher} -pbkdf2 ${SALT.join(' ')} -pass pass:motdepasse -in /tmp/real.enc`);
      expect(clear).toBe(PLAIN);
    }, 30000);
  }

  it('-P : le sel, la clé et le vecteur dérivés sont ceux d\'openssl (pas de ligne iv pour ECB)', async () => {
    const srv = newServer('P');
    for (const cipher of ['aes-256-cbc', 'aes-128-ecb', 'des-ede3-cbc']) {
      const expected = real(['enc', `-${cipher}`, '-pbkdf2', ...SALT, '-pass', 'pass:x', '-P']).stdout.toString().trim();
      expect((await srv.executeCommand(`openssl enc -${cipher} -pbkdf2 ${SALT.join(' ')} -pass pass:x -P`)).trim()).toBe(expected);
    }
  });

  it('les chiffrements du fournisseur legacy sont refusés avec le texte d\'openssl 3.0', async () => {
    const srv = newServer('L');
    srv.writeTextFile('/tmp/p.txt', 'x');
    for (const cipher of ['rc4', 'des', 'rc2', 'seed', 'bf']) {
      const expected = real(['enc', `-${cipher}`, '-pbkdf2', '-pass', 'pass:x', '-in', 'plain.txt']).stderr.toString().split('\n');
      const shown = (await srv.executeCommand(`openssl enc -${cipher} -pbkdf2 -pass pass:x -in /tmp/p.txt 2>&1`)).split('\n');
      expect(shown[0]).toBe(expected[0]);
      expect(shown[1].replace(/^[0-9A-F]+:/, '')).toBe(expected[1].replace(/^[0-9A-F]+:/, ''));
    }
  });

  it('les AEAD sont refusés : « AEAD ciphers not supported »', async () => {
    const srv = newServer('A');
    srv.writeTextFile('/tmp/p.txt', 'x');
    const expected = real(['enc', '-aes-256-gcm', '-pass', 'pass:x', '-in', 'plain.txt']).stderr.toString();
    const shown = await srv.executeCommand('openssl enc -aes-256-gcm -pass pass:x -in /tmp/p.txt 2>&1');
    expect(shown).toBe(expected.trimEnd());
    expect(shown).toContain('AEAD ciphers not supported');
  });

  it('WITNESS — un aller-retour du simulateur sur chaque chiffrement conserve le texte', async () => {
    const srv = newServer('R');
    srv.writeTextFile('/tmp/p.txt', PLAIN);
    for (const cipher of CIPHERS) {
      await srv.executeCommand(`openssl enc -${cipher} -pbkdf2 -iter 10 -pass pass:x -in /tmp/p.txt -out /tmp/c.enc`);
      expect(await srv.executeCommand(`openssl enc -d -${cipher} -pbkdf2 -iter 10 -pass pass:x -in /tmp/c.enc`)).toBe(PLAIN);
    }
    expect(readFileSync(join(dir, 'plain.txt'), 'utf8')).toBe(PLAIN);
  }, 30000);
});
