/**
 * Invites de mot de passe d'openssl : `enc` (apps/enc.c : « enter AES-256-CBC encryption
 * password: », confirmation à l'encodage seulement), `passwd` (apps/passwd.c : « Password: »,
 * confirmation sauf avec -salt), `genrsa -aes256` (PEM_def_callback : « Enter PEM pass phrase: »,
 * ≥ 4 caractères), `pkcs8 -topk8` (apps/pkcs8.c : « Enter Encryption Password: »), et la lecture
 * d'une clé chiffrée (ui_lib.c : « Enter pass phrase for <fichier>: »). Les textes sont ceux des
 * sources d'OpenSSL 3.0.13 (ces invites vont sur /dev/tty : un oracle par entrée standard ne
 * les voit pas) ; le condensé de `passwd` est comparé à un openssl réel.
 *
 * MESURÉ avant correctif : ces commandes sans source de mot de passe répondaient « a password
 * is required » ou écrivaient une clé en clair ; aucune n'avait de plan d'interaction. Avant
 * correctif, 7 des 8 cas tombent ; le témoin (`enc -k`, aucun dialogue) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { play } from './_opensslPlan';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
  await srv.executeCommand("sh -c 'echo secret data > /tmp/plain.txt'");
  return srv;
}

describe('openssl : invites de mot de passe', () => {
  it('témoin : avec -k aucun dialogue', async () => {
    expect(await play(await lab(), 'openssl enc -aes-256-cbc -k x -in /tmp/plain.txt -out /tmp/c.enc', [])).toBeNull();
  });

  it('enc : chiffrement = invite + confirmation, le fichier se déchiffre avec ce mot de passe', async () => {
    const srv = await lab();
    const played = await play(srv, 'openssl enc -aes-256-cbc -a -in /tmp/plain.txt -out /tmp/c.enc', ['hunter2', 'hunter2']);
    expect(played?.prompts).toEqual(['enter AES-256-CBC encryption password:', 'Verifying - enter AES-256-CBC encryption password:']);
    expect(await srv.executeCommand('openssl enc -d -a -aes-256-cbc -k hunter2 -in /tmp/c.enc')).toContain('secret data');
  });

  it('enc : déchiffrement = une seule invite ; confirmation différente = « Verify failure »', async () => {
    const srv = await lab();
    const decrypt = await play(srv, 'openssl enc -d -aes-128-cbc -in /tmp/c.enc', ['x']);
    expect(decrypt?.prompts).toEqual(['enter AES-128-CBC decryption password:']);
    const mismatch = await play(srv, 'openssl enc -aes-128-cbc -in /tmp/plain.txt', ['a', 'b']);
    expect(mismatch?.aborted).toContain('Verify failure');
  });

  it('passwd : invite + confirmation ; avec -salt, une seule invite ; condensé identique à openssl réel', async () => {
    const srv = await lab();
    const asked = await play(srv, 'openssl passwd -6', ['secret', 'secret']);
    expect(asked?.prompts).toEqual(['Password: ', 'Verifying - Password: ']);
    const salted = await play(srv, 'openssl passwd -1 -salt abcdefgh', ['secret']);
    expect(salted?.prompts).toEqual(['Password: ']);
    const real = spawnSync('openssl', ['passwd', '-1', '-salt', 'abcdefgh', 'secret'], { encoding: 'utf8' }).stdout.trim();
    expect(salted?.output.join('\n').trim()).toBe(real);
  });

  it('genrsa -aes256 : phrase de passe de 4 caractères minimum, clé écrite chiffrée', async () => {
    const srv = await lab();
    const played = await play(srv, 'openssl genrsa -aes256 -out /tmp/enc.key 1024', ['abc', 'secret1', 'secret1']);
    expect(played?.prompts).toEqual(['Enter PEM pass phrase:', 'Verifying - Enter PEM pass phrase:']);
    expect(played?.output).toContain('phrase is too short, needs to be at least 4 chars');
    expect(await srv.executeCommand('cat /tmp/enc.key')).toContain('BEGIN ENCRYPTED PRIVATE KEY');
  });

  it('lecture d\'une clé chiffrée : « Enter pass phrase for <fichier>: » puis la commande réussit', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -aes256 -passout pass:secret1 -out /tmp/enc.key 1024');
    const played = await play(srv, 'openssl rsa -in /tmp/enc.key -noout -check', ['secret1']);
    expect(played?.prompts).toEqual(['Enter pass phrase for /tmp/enc.key:']);
    expect(played?.output.join('\n')).toContain('RSA key ok');
  });

  it('pkcs8 -topk8 : « Enter Encryption Password: » deux fois, clé de sortie chiffrée', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -out /tmp/plain.key 1024');
    const played = await play(srv, 'openssl pkcs8 -topk8 -in /tmp/plain.key -out /tmp/p8.key', ['pw1234', 'pw1234']);
    expect(played?.prompts).toEqual(['Enter Encryption Password:', 'Verifying - Enter Encryption Password:']);
    expect(await srv.executeCommand('cat /tmp/p8.key')).toContain('BEGIN ENCRYPTED PRIVATE KEY');
  });

  it('x509 -signkey avec une clé chiffrée : l\'invite précède la signature', async () => {
    const srv = await lab();
    await srv.executeCommand('openssl genrsa -aes256 -passout pass:secret1 -out /tmp/enc.key 1024');
    await srv.executeCommand('openssl req -new -key /tmp/enc.key -passin pass:secret1 -subj /CN=k.lab -out /tmp/k.csr');
    const played = await play(srv, 'openssl x509 -req -in /tmp/k.csr -signkey /tmp/enc.key -out /tmp/k.crt -days 5', ['secret1']);
    expect(played?.prompts).toEqual(['Enter pass phrase for /tmp/enc.key:']);
    expect(await srv.executeCommand('openssl x509 -in /tmp/k.crt -noout -subject')).toContain('CN = k.lab');
  });
});
