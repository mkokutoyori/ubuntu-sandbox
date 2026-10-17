/*
 * `ssh-keygen` de Win32-OpenSSH 8.6p1 signe (-Y), certifie (-s, -L), revoque
 * (-k, -Q) et ecrit des cles PEM/PKCS8 (-m) comme celui de Linux : c'est le
 * meme programme, les chemins Windows et cmd.exe en plus.
 *
 * L'AUTORITE : les memes sources OpenSSH (ssh-keygen.c, sshsig.c, krl.c,
 * PROTOCOL.certkeys) ; Win32-OpenSSH 8.6p1 les construit telles quelles. La
 * seule difference attendue est le repertoire de depart (C:\Users\User) et
 * le fuseau de la machine pour les dates.
 *
 * Ecrite contre ces sources. 1 des 8 cas tombe avant la correction de
 * WindowsPC : `ssh-keygen -Y verify < fichier` ignorait l'entree standard de
 * cmd.exe (« Signature verification failed »). Les 7 autres passent des deux
 * cotes par non-regression : le programme est le meme que sur Linux et les
 * chemins Windows ne changent rien aux resultats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  for (const [name, comment] of [['ca', 'ca@lab'], ['id', 'alice@lab'], ['other', 'bob@lab']]) {
    await pc.executeCommand(`ssh-keygen -q -t ed25519 -N "" -C ${comment} -f ${name}`);
  }
  await pc.executeCommand('echo hello> data.txt');
  return pc;
}

describe('ssh-keygen -Y sur Windows', () => {
  it('signe un fichier et le verifie avec allowed_signers', async () => {
    const pc = await lab();
    const signed = await pc.executeCommand('ssh-keygen -Y sign -f id -n file data.txt');
    expect(signed).toContain('Signing file data.txt');
    expect(signed).toContain('Write signature to data.txt.sig');
    expect((await pc.executeCommand('type data.txt.sig')).startsWith('-----BEGIN SSH SIGNATURE-----')).toBe(true);

    const publicKey = (await pc.executeCommand('type id.pub')).trim().split(' ').slice(0, 2).join(' ');
    await pc.executeCommand(`echo alice@lab ${publicKey}> allowed`);
    const verified = await pc.executeCommand('ssh-keygen -Y verify -f allowed -I alice@lab -n file -s data.txt.sig < data.txt');
    expect(verified).toMatch(/Good "file" signature for alice@lab with ED25519 key SHA256:/);
  }, 60_000);

  it('refuse une signature qui ne correspond plus au message', async () => {
    const pc = await lab();
    await pc.executeCommand('ssh-keygen -Y sign -q -f id -n file data.txt');
    await pc.executeCommand('echo tampered> data.txt');

    const out = await pc.executeCommand('ssh-keygen -Y check-novalidate -n file -s data.txt.sig < data.txt');
    expect(out).toContain('Signature verification failed: incorrect signature');
    expect(out).toContain('Could not verify signature.');
  }, 60_000);
});

describe('ssh-keygen -s, -L, -l sur Windows', () => {
  it('certifie une cle et affiche le certificat', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('ssh-keygen -s ca -I alice-key -n alice -z 4 id.pub');
    expect(out).toContain('Signed user key id-cert.pub: id "alice-key" serial 4 for alice valid forever');

    const shown = await pc.executeCommand('ssh-keygen -L -f id-cert.pub');
    expect(shown).toContain('Type: ssh-ed25519-cert-v01@openssh.com user certificate');
    expect(shown).toContain('Key ID: "alice-key"');
    expect(shown).toContain('Serial: 4');
    expect(await pc.executeCommand('ssh-keygen -l -f id-cert.pub')).toMatch(/\(ED25519-CERT\)$/m);
  }, 60_000);

  it('une validite relative donne des dates', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -s ca -I k -V +4w id.pub')).toMatch(/valid from \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} to /);
  }, 60_000);
});

describe('ssh-keygen -k et -Q sur Windows', () => {
  it('revoque une cle et un certificat', async () => {
    const pc = await lab();
    await pc.executeCommand('ssh-keygen -s ca -I k -z 8 id.pub');
    await pc.executeCommand('echo serial: 5-9> spec');
    expect(await pc.executeCommand('ssh-keygen -k -f list.krl -s ca.pub spec')).toContain('Revoking from spec');

    const out = await pc.executeCommand('ssh-keygen -Q -f list.krl id-cert.pub other.pub');
    expect(out).toContain('id-cert.pub (alice@lab): REVOKED');
    expect(out).toContain('other.pub (bob@lab): ok');
  }, 60_000);

  it('-Q -l donne le contenu', async () => {
    const pc = await lab();
    await pc.executeCommand('echo serial: 5 > spec');
    await pc.executeCommand('ssh-keygen -k -q -f list.krl -s none spec');
    expect(await pc.executeCommand('ssh-keygen -Q -l -f list.krl')).toContain('serial: 5');
  }, 60_000);
});

describe('ssh-keygen -m sur Windows', () => {
  it('ecrit une cle RSA PEM et la relit', async () => {
    const pc = await lab();
    await pc.executeCommand('ssh-keygen -q -t rsa -b 2048 -m PEM -N "" -f rsa');
    expect((await pc.executeCommand('type rsa')).startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(await pc.executeCommand('ssh-keygen -y -f rsa')).toMatch(/^ssh-rsa /);
  }, 60_000);

  it('ECDSA PKCS8 chiffre par phrase secrete', async () => {
    const pc = await lab();
    await pc.executeCommand('ssh-keygen -q -t ecdsa -m PKCS8 -N secret -f ec');
    expect((await pc.executeCommand('type ec')).startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
    expect(await pc.executeCommand('ssh-keygen -y -P secret -f ec')).toMatch(/^ecdsa-sha2-nistp256 /);
  }, 60_000);
});
