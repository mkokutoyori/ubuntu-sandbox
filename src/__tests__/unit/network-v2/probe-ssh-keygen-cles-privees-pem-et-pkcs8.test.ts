/*
 * `ssh-keygen -m PEM|PKCS8` ecrit et relit des cles privees comme OpenSSH 8.9p1.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `ssh-keygen.c` : `-m` fixe aussi le format de la cle
 *   privee (`private_key_format`) pour PEM et PKCS8 ; `sshkey.c`
 *   (`sshkey_private_to_fileblob`) : une cle Ed25519 s'ecrit TOUJOURS au
 *   format OpenSSH, quel que soit `-m` ; RSA et ECDSA passent par
 *   `sshkey_private_to_blob_pem_pkcs8`, avec AES-128-CBC quand une
 *   phrase secrete est donnee ;
 * - PKCS#1 (RFC 8017 annexe A.1.2) « RSA PRIVATE KEY », SEC1 (RFC 5915)
 *   « EC PRIVATE KEY », PKCS#8 (RFC 5958) « PRIVATE KEY », PKCS#8 chiffre
 *   (RFC 8018 PBES2) « ENCRYPTED PRIVATE KEY », et le PEM chiffre
 *   traditionnel d'OpenSSL (« Proc-Type: 4,ENCRYPTED » + « DEK-Info »,
 *   EVP_BytesToKey MD5 a une iteration) ;
 * - `ssh-keygen.c` (`do_change_comment`) : « Comments are only supported
 *   for keys stored in the new format (-o). » pour une cle non Ed25519
 *   quand le format prive demande n'est pas OpenSSH, sortie 1.
 *
 * Ecrite contre ces sources, avant l'implantation. 11 des 13 cas tombent
 * avant elle (« private keys in the PEM format are not simulated »). Passent
 * des deux cotes le PEM mal forme (le chargeur disait deja « invalid
 * format ») et `-m` inconnu (non-regression du refus).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

function lab(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  return pc;
}

const firstLine = async (pc: LinuxPC, path: string): Promise<string> => (await pc.executeCommand(`head -1 ${path}`)).trim();

describe('private key formats', () => {
  it('Ed25519 reste au format OpenSSH, meme avec -m PEM', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -m PEM -N '' -f ~/e");
    expect(await firstLine(pc, '~/e')).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
  }, 60_000);

  it('RSA -m PEM : RSA PRIVATE KEY', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -f ~/r");
    expect(await firstLine(pc, '~/r')).toBe('-----BEGIN RSA PRIVATE KEY-----');
  }, 60_000);

  it('ECDSA -m PEM : EC PRIVATE KEY', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t ecdsa -m PEM -N '' -f ~/c");
    expect(await firstLine(pc, '~/c')).toBe('-----BEGIN EC PRIVATE KEY-----');
  }, 60_000);

  it('RSA et ECDSA -m PKCS8 : PRIVATE KEY', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t rsa -b 2048 -m PKCS8 -N '' -f ~/r");
    await pc.executeCommand("ssh-keygen -q -t ecdsa -m PKCS8 -N '' -f ~/c");
    expect(await firstLine(pc, '~/r')).toBe('-----BEGIN PRIVATE KEY-----');
    expect(await firstLine(pc, '~/c')).toBe('-----BEGIN PRIVATE KEY-----');
  }, 60_000);

  it('la cle publique d\'un fichier PEM est celle qui a ete ecrite', async () => {
    const pc = lab();
    for (const [type, format] of [['rsa', 'PEM'], ['rsa', 'PKCS8'], ['ecdsa', 'PEM'], ['ecdsa', 'PKCS8']]) {
      await pc.executeCommand(`ssh-keygen -q -t ${type} -b ${type === 'rsa' ? 2048 : 256} -m ${format} -N '' -f ~/k`);
      const written = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();
      const derived = (await pc.executeCommand('ssh-keygen -y -f ~/k')).trim().split(' ').slice(0, 2).join(' ');
      expect(derived, `${type} ${format}`).toBe(written);
    }
  }, 120_000);

  it('une phrase secrete chiffre le PEM traditionnel en AES-128-CBC', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t rsa -b 2048 -m PEM -N 'secret' -f ~/r");
    const text = await pc.executeCommand('head -4 ~/r');

    expect(text).toContain('Proc-Type: 4,ENCRYPTED');
    expect(text).toMatch(/DEK-Info: AES-128-CBC,[0-9A-F]{32}/);
    expect(await pc.executeCommand("ssh-keygen -y -P 'secret' -f ~/r")).toMatch(/^ssh-rsa /);
    expect(await pc.executeCommand("ssh-keygen -y -P 'wrong' -f ~/r")).toContain('incorrect passphrase supplied to decrypt private key');
  }, 60_000);

  it('une phrase secrete chiffre le PKCS8 : ENCRYPTED PRIVATE KEY', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t ecdsa -m PKCS8 -N 'secret' -f ~/c");

    expect(await firstLine(pc, '~/c')).toBe('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(await pc.executeCommand("ssh-keygen -y -P 'secret' -f ~/c")).toMatch(/^ecdsa-sha2-nistp256 /);
    expect(await pc.executeCommand("ssh-keygen -y -P 'wrong' -f ~/c")).toContain('incorrect passphrase supplied to decrypt private key');
  }, 60_000);

  it('-p -m PEM convertit une cle OpenSSH, -p sans -m la ramene', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t rsa -b 2048 -N '' -f ~/r");
    const before = (await pc.executeCommand('ssh-keygen -y -f ~/r')).trim();
    expect(await firstLine(pc, '~/r')).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');

    await pc.executeCommand("ssh-keygen -q -p -m PEM -P '' -N '' -f ~/r");
    expect(await firstLine(pc, '~/r')).toBe('-----BEGIN RSA PRIVATE KEY-----');
    expect((await pc.executeCommand('ssh-keygen -y -f ~/r')).trim().split(' ').slice(0, 2)).toEqual(before.split(' ').slice(0, 2));

    await pc.executeCommand("ssh-keygen -q -p -P '' -N '' -f ~/r");
    expect(await firstLine(pc, '~/r')).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
  }, 60_000);

  it('-c sur une cle non Ed25519 en PEM est refuse', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -f ~/r");
    expect(await pc.executeCommand("ssh-keygen -c -m PEM -C new -P '' -f ~/r"))
      .toContain('Comments are only supported for keys stored in the new format (-o).');
  }, 60_000);

  it('un fichier PEM signe et authentifie comme une cle OpenSSH', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -f ~/r");
    await pc.executeCommand("printf 'x\\n' > ~/d");
    await pc.executeCommand('ssh-keygen -q -Y sign -f ~/r -n file ~/d');
    const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/r.pub')).trim();
    await pc.executeCommand(`printf 'me ${publicKey}\\n' > ~/allowed`);

    expect(await pc.executeCommand('ssh-keygen -Y verify -f ~/allowed -I me -n file -s ~/d.sig < ~/d'))
      .toContain('Good "file" signature for me with RSA key SHA256:');
  }, 60_000);

  it('-l lit l\'empreinte d\'un fichier PEM non chiffre', async () => {
    const pc = lab();
    await pc.executeCommand("ssh-keygen -q -t ecdsa -m PEM -N '' -f ~/c");
    expect(await pc.executeCommand('ssh-keygen -l -f ~/c')).toMatch(/^256 SHA256:[A-Za-z0-9+/]{43} .*\(ECDSA\)$/);
  }, 60_000);

  it('un PEM mal forme est refuse', async () => {
    const pc = lab();
    await pc.executeCommand("printf -- '-----BEGIN RSA PRIVATE KEY-----\\nAAAA\\n-----END RSA PRIVATE KEY-----\\n' > ~/bad");
    expect(await pc.executeCommand('ssh-keygen -y -f ~/bad')).toContain('invalid format');
  }, 60_000);

  it('-m inconnu est refuse comme avant', async () => {
    const pc = lab();
    expect(await pc.executeCommand("ssh-keygen -q -m BOGUS -N '' -f ~/k")).toContain('Unsupported conversion format "BOGUS"');
  }, 60_000);
});
