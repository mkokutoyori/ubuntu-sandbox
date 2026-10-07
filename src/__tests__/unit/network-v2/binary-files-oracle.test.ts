/**
 * Le système de fichiers du simulateur conserve les octets sans perte (voir file-bytes-codec) : les
 * outils d'octets (xxd, base64, sha256sum, wc -c, openssl enc/dgst/base64) voient les mêmes octets que
 * les vrais, et `openssl enc` lit et écrit du binaire brut comme le vrai (Salted__ ‖ sel ‖ AES-CBC).
 *
 * MESURÉ avant correctif : « base64 -d » d'un DER donnait des U+FFFD (xxd montrait efbfbd), sha256sum
 * d'un fichier binaire différait de celui d'un vrai sha256sum, `wc -c` comptait les caractères, et
 * `openssl enc -out` sans -a refusait d'écrire (« raw binary output cannot be stored by this simulator's
 * filesystem »), si bien qu'un fichier chiffré par le simulateur ne pouvait pas être déchiffré par un
 * vrai openssl. Avant correctif, les 8 cas tombent ; le témoin (un texte ASCII garde son hachage)
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

const dir = mkdtempSync(join(tmpdir(), 'binfiles-'));
const real = (args: string[], input?: Buffer) => spawnSync('openssl', args, { cwd: dir, input });
const sample = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff));

function newServer(tag: string): LinuxServer {
  const srv = new LinuxServer('linux-server', tag); srv.powerOn();
  return srv;
}

function put(srv: LinuxServer, path: string, bytes: Uint8Array): void {
  srv.writeTextFile(path, bytesToFileText(bytes));
}

function get(srv: LinuxServer, path: string): Buffer {
  return Buffer.from(fileTextToBytes(srv.readTextFile(path) ?? ''));
}

describe('fichiers binaires ↔ outils d\'octets', () => {
  it('base64 -d écrit les octets exacts dans un fichier', async () => {
    const srv = newServer('B1');
    await srv.executeCommand(`sh -c 'echo ${sample.toString('base64')} | base64 -d > /tmp/b.bin'`);
    expect(get(srv, '/tmp/b.bin').equals(sample)).toBe(true);
  });

  it('xxd d\'un fichier binaire affiche les octets du fichier', async () => {
    const srv = newServer('B2');
    put(srv, '/tmp/b.bin', sample);
    const shown = (await srv.executeCommand('xxd /tmp/b.bin')).split('\n').slice(0, 2).join('\n');
    const dumpLine = (offset: number): string => {
      const chunk = sample.subarray(offset, offset + 16);
      const pairs = (chunk.toString('hex').match(/.{1,4}/g) ?? []).join(' ');
      const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      return `${offset.toString(16).padStart(8, '0')}: ${pairs.padEnd(39, ' ')}  ${ascii}`;
    };
    expect(shown).toBe(`${dumpLine(0)}\n${dumpLine(16)}`);
  });

  it('sha256sum et wc -c d\'un fichier binaire sont ceux du vrai système', async () => {
    const srv = newServer('B3');
    put(srv, '/tmp/b.bin', sample);
    const expected = spawnSync('sha256sum', [], { input: sample, encoding: 'utf8' }).stdout.split(' ')[0];
    expect(await srv.executeCommand('sha256sum /tmp/b.bin')).toContain(expected);
    expect((await srv.executeCommand('wc -c /tmp/b.bin')).trim().split(/\s+/)[0]).toBe(String(sample.length));
  });

  it('openssl dgst et openssl base64 lisent les octets d\'un fichier binaire', async () => {
    const srv = newServer('B4');
    put(srv, '/tmp/b.bin', sample);
    const digest = real(['dgst', '-sha256'], sample).stdout.toString().trim().split('= ')[1];
    expect(await srv.executeCommand('openssl dgst -sha256 /tmp/b.bin')).toContain(digest);
    expect((await srv.executeCommand('openssl base64 -A -in /tmp/b.bin')).trim()).toBe(sample.toString('base64'));
  });

  it('openssl enc écrit du binaire brut qu\'un openssl réel déchiffre', async () => {
    const srv = newServer('B5');
    await srv.executeCommand(`sh -c 'echo "Rapport d audit confidentiel" > /tmp/plain.txt'`);
    await srv.executeCommand('openssl enc -aes-256-cbc -pbkdf2 -pass pass:secret -in /tmp/plain.txt -out /tmp/plain.enc');
    const encrypted = get(srv, '/tmp/plain.enc');
    expect(encrypted.subarray(0, 8).toString('latin1')).toBe('Salted__');
    writeFileSync(join(dir, 'sim.enc'), encrypted);
    const opened = real(['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', 'pass:secret', '-in', 'sim.enc']);
    expect(opened.stdout.toString()).toBe('Rapport d audit confidentiel\n');
  });

  it('le simulateur déchiffre un fichier d\'un openssl réel (avec ou sans -S), et refuse un mauvais mot de passe', async () => {
    writeFileSync(join(dir, 'real.txt'), 'Plan de reprise d\'activité é\n');
    real(['enc', '-aes-256-cbc', '-pbkdf2', '-pass', 'pass:secret', '-in', 'real.txt', '-out', 'real.enc']);
    real(['enc', '-aes-256-cbc', '-pbkdf2', '-S', '0123456789abcdef', '-pass', 'pass:secret', '-in', 'real.txt', '-out', 'real-salted.enc']);
    const srv = newServer('B6');
    put(srv, '/tmp/real.enc', readFileSync(join(dir, 'real.enc')));
    put(srv, '/tmp/real-salted.enc', readFileSync(join(dir, 'real-salted.enc')));
    expect(await srv.executeCommand('openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:secret -in /tmp/real.enc')).toBe('Plan de reprise d\'activité é\n');
    expect(await srv.executeCommand('openssl enc -d -aes-256-cbc -pbkdf2 -S 0123456789abcdef -pass pass:secret -in /tmp/real-salted.enc')).toBe('Plan de reprise d\'activité é\n');
    expect(await srv.executeCommand('openssl enc -d -aes-256-cbc -pbkdf2 -S 0123456789abcdef -pass pass:mauvais -in /tmp/real-salted.enc 2>&1')).toContain('bad decrypt');
    expect(readFileSync(join(dir, 'real-salted.enc')).subarray(0, 8).toString('latin1')).not.toBe('Salted__');
  });

  it('openssl enc -a produit le même armour en lignes de 64 colonnes', async () => {
    const srv = newServer('B7');
    put(srv, '/tmp/b.bin', sample);
    await srv.executeCommand('openssl enc -aes-128-cbc -a -pbkdf2 -pass pass:x -in /tmp/b.bin -out /tmp/b.b64');
    const armoured = srv.readTextFile('/tmp/b.b64') ?? '';
    const lines = armoured.trimEnd().split('\n');
    expect(lines.slice(0, -1).every((line) => line.length === 64)).toBe(true);
    writeFileSync(join(dir, 'b.b64'), armoured);
    expect(real(['enc', '-d', '-aes-128-cbc', '-a', '-pbkdf2', '-pass', 'pass:x', '-in', 'b.b64']).stdout.equals(sample)).toBe(true);
  });

  it('un aller-retour chiffré/déchiffré du simulateur conserve les octets d\'un fichier binaire', async () => {
    const srv = newServer('B8');
    put(srv, '/tmp/b.bin', sample);
    await srv.executeCommand('openssl enc -aes-256-cbc -pbkdf2 -pass pass:x -in /tmp/b.bin -out /tmp/b.enc');
    await srv.executeCommand('openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:x -in /tmp/b.enc -out /tmp/b.out');
    expect(get(srv, '/tmp/b.out').equals(sample)).toBe(true);
  });

  it('WITNESS — le hachage d\'un texte ASCII est inchangé', async () => {
    const srv = newServer('B9');
    await srv.executeCommand(`sh -c 'printf hello > /tmp/h.txt'`);
    expect(await srv.executeCommand('sha256sum /tmp/h.txt')).toContain('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
