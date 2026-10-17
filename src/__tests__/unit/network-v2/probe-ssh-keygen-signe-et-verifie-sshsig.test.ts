/*
 * `ssh-keygen -Y` signe et verifie comme OpenSSH 8.9p1 (SSHSIG).
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `PROTOCOL.sshsig` : la signature est un objet « SSHSIG »
 *   (version 1, cle publique, espace de noms, reserve, algorithme de
 *   hachage, signature) enrobe dans « -----BEGIN SSH SIGNATURE----- » ; le
 *   message signe est « SSHSIG » + espace de noms + reserve + algorithme +
 *   H(message) ; sha512 par defaut, sha256 admis ; RSA signe en
 *   rsa-sha2-512 ;
 * - `ssh-keygen.c` : `sign_one` ecrit sur la sortie d'erreur « Signing file
 *   <f> » puis « Write signature to <f>.sig » (hors `-q`), « Signing data on
 *   standard input » et la signature sur la sortie standard pour l'entree
 *   standard ; `sig_verify` ecrit sur la sortie standard « Good "<ns>"
 *   signature for <principal> with <TYPE> key <empreinte> » (sans
 *   principal avec `check-novalidate` : « Good "<ns>" signature with … »)
 *   ou « Could not verify signature. » et sort en 255 ; `find-principals`
 *   ecrit un principal par ligne ou « No principal matched. » ; les
 *   arguments manquants sortent en 1 (« Too few arguments for sign:
 *   missing namespace ») ;
 * - `sshsig.c` : « Couldn't verify signature: namespace does not match »,
 *   « Signature verification failed: incorrect signature », et, pour un
 *   fichier allowed_signers, « <f>:<n>: key has expired: verify time <t> >
 *   valid-before <t> » et « … key is not permitted for use in signature
 *   namespace "<ns>" », la ligne etant alors ignoree (la recherche
 *   continue) ; une option inconnue (« bad options: unknown key option »)
 *   arrete la recherche ; `-O hashalg=` n'admet que sha256 et sha512.
 *
 * Ecrite contre ces sources, avant l'implantation. 24 des 25 cas tombent
 * avant elle (« signatures are not simulated »). Passe des deux cotes le
 * TEMOIN `-D` : il garde le refus des jetons PKCS#11.
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

async function lab(type = 'ed25519'): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await pc.executeCommand(`ssh-keygen -q -t ${type} -N '' -C alice@lab -f ~/k`);
  await pc.executeCommand("printf 'hello world\\n' > ~/data");
  const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();
  await pc.executeCommand(`printf 'alice@lab ${publicKey}\\n' > ~/allowed`);
  return pc;
}

const SIGN = 'ssh-keygen -Y sign -f ~/k -n file ~/data';
const VERIFY = 'ssh-keygen -Y verify -f ~/allowed -I alice@lab -n file -s ~/data.sig < ~/data';

describe('ssh-keygen -Y sign', () => {
  it('TEMOIN: -D sans module PKCS#11 installe echoue comme par OpenSSH', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -D /usr/lib/libpkcs11.so')).toContain('cannot read public key from pkcs11');
  }, 60_000);

  it('ecrit <fichier>.sig armoure et l\'annonce sur la sortie d\'erreur', async () => {
    const pc = await lab();
    const out = await pc.executeCommand(SIGN);

    expect(out).toContain('Signing file /home/user/data');
    expect(out).toContain('Write signature to /home/user/data.sig');
    const armour = await pc.executeCommand('cat ~/data.sig');
    expect(armour.startsWith('-----BEGIN SSH SIGNATURE-----\n')).toBe(true);
    expect(armour.trimEnd().endsWith('-----END SSH SIGNATURE-----')).toBe(true);
    expect(armour.split('\n').slice(1, -2).every((line) => line.length <= 70)).toBe(true);
  }, 60_000);

  it('-q se tait', async () => {
    const pc = await lab();
    expect((await pc.executeCommand(`${SIGN.replace('-Y sign', '-q -Y sign')}`)).trim()).toBe('');
    expect(await pc.executeCommand('test -f ~/data.sig && echo there')).toContain('there');
  }, 60_000);

  it('sur l\'entree standard, la signature part sur la sortie standard', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('cat ~/data | ssh-keygen -Y sign -f ~/k -n file 2>/dev/null');

    expect(out.startsWith('-----BEGIN SSH SIGNATURE-----')).toBe(true);
    expect(out).not.toContain('Signing');
  }, 60_000);

  it('sans espace de noms, sort en 1', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -Y sign -f ~/k ~/data; echo "rc=$?"'))
      .toContain('Too few arguments for sign: missing namespace\nrc=1');
  }, 60_000);

  it('une option inconnue de -O est refusee', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -Y sign -O bogus -f ~/k -n file ~/data; echo "rc=$?"')).toContain('Invalid option "bogus"');
  }, 60_000);

  it('hashalg=md5 est refuse, sha256 est admis', async () => {
    const pc = await lab();
    expect(await pc.executeCommand(`ssh-keygen -Y sign -O hashalg=md5 -f ~/k -n file ~/data`))
      .toContain('unsupported hash algorithm "md5"');
    expect(await pc.executeCommand(`ssh-keygen -Y sign -O hashalg=sha256 -f ~/k -n file ~/data`))
      .toContain('Write signature to');
    expect(await pc.executeCommand(VERIFY)).toContain('Good "file" signature for alice@lab with ED25519 key SHA256:');
  }, 60_000);

  it('un fichier absent n\'est pas signe', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('ssh-keygen -Y sign -f ~/k -n file ~/nothing'))
      .toContain('Cannot open /home/user/nothing for signing: No such file or directory');
  }, 60_000);

  it('la cle publique d\'un autre jeu ne signe pas', async () => {
    const pc = await lab();
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/other");
    await pc.executeCommand('cp ~/other.pub ~/k.pub');
    expect(await pc.executeCommand(SIGN)).toContain("Public key /home/user/k doesn't match private /home/user/k");
  }, 60_000);

  it('une cle privee absente est fatale', async () => {
    const pc = await lab();
    await pc.executeCommand('rm ~/k');
    expect(await pc.executeCommand(SIGN)).toContain('Load key "/home/user/k": No such file or directory');
  }, 60_000);
});

describe('ssh-keygen -Y verify', () => {
  it('une bonne signature est reconnue avec l\'empreinte de la cle', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const fingerprint = (await pc.executeCommand('ssh-keygen -l -f ~/k.pub')).split(' ')[1];

    expect(await pc.executeCommand(VERIFY)).toContain(`Good "file" signature for alice@lab with ED25519 key ${fingerprint}`);
  }, 60_000);

  it('un message modifie est rejete', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    await pc.executeCommand("printf 'tampered\\n' > ~/data");
    const out = await pc.executeCommand(`${VERIFY}; echo "rc=$?"`);

    expect(out).toContain('Signature verification failed: incorrect signature');
    expect(out).toContain('Could not verify signature.');
    expect(out).toContain('rc=255');
  }, 60_000);

  it('un autre espace de noms est rejete', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    expect(await pc.executeCommand(VERIFY.replace('-n file', '-n git')))
      .toContain("Couldn't verify signature: namespace does not match");
  }, 60_000);

  it('un principal absent du fichier est rejete', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    expect(await pc.executeCommand(VERIFY.replace('alice@lab -n', 'mallory -n'))).toContain('Could not verify signature.');
  }, 60_000);

  it('une cle non listee est rejetee', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/other");
    const other = (await pc.executeCommand('cut -d" " -f1,2 ~/other.pub')).trim();
    await pc.executeCommand(`printf 'alice@lab ${other}\\n' > ~/allowed`);

    expect(await pc.executeCommand(VERIFY)).toContain('Could not verify signature.');
  }, 60_000);

  it('valid-before depasse : la ligne est ignoree et dite expiree', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();
    await pc.executeCommand(`printf 'alice@lab valid-before="20200101" ${publicKey}\\n' > ~/allowed`);
    const out = await pc.executeCommand(VERIFY);

    expect(out).toContain('/home/user/allowed:1: key has expired: verify time ');
    expect(out).toContain('> valid-before 2020-01-01T00:00:00');
    expect(out).toContain('Could not verify signature.');
  }, 60_000);

  it('verify-time ramene la cle dans sa validite', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();
    await pc.executeCommand(`printf 'alice@lab valid-before="20200101" ${publicKey}\\n' > ~/allowed`);

    expect(await pc.executeCommand(VERIFY.replace('-n file', '-O verify-time=20190601 -n file'))).toContain('Good "file" signature');
  }, 60_000);

  it('namespaces exclut un autre espace de noms', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();
    await pc.executeCommand(`printf 'alice@lab namespaces="git" ${publicKey}\\n' > ~/allowed`);
    const out = await pc.executeCommand(VERIFY);

    expect(out).toContain('key is not permitted for use in signature namespace "file"');
    expect(out).toContain('Could not verify signature.');
  }, 60_000);

  it('une option inconnue arrete la recherche', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();
    await pc.executeCommand(`printf 'alice@lab bogus ${publicKey}\\n' > ~/allowed`);

    expect(await pc.executeCommand(VERIFY)).toContain('bad options: unknown key option');
  }, 60_000);

  it('check-novalidate accepte sans fichier de signataires', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const out = await pc.executeCommand('ssh-keygen -Y check-novalidate -n file -s ~/data.sig < ~/data');

    expect(out).toMatch(/Good "file" signature with ED25519 key SHA256:/);
    expect(out).not.toContain(' for ');
  }, 60_000);

  it('print-pubkey ecrit la cle du signataire', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    const publicKey = (await pc.executeCommand('cut -d" " -f1,2 ~/k.pub')).trim();

    expect(await pc.executeCommand(VERIFY.replace('-n file', '-O print-pubkey -n file'))).toContain(publicKey);
  }, 60_000);

  it('une signature RSA et une signature ECDSA se verifient', async () => {
    for (const type of ['rsa', 'ecdsa']) {
      const pc = await lab(type);
      await pc.executeCommand(SIGN);
      expect(await pc.executeCommand(VERIFY), type).toContain('Good "file" signature for alice@lab with');
    }
  }, 120_000);

  it('un fichier de signature qui n\'en est pas un est refuse', async () => {
    const pc = await lab();
    await pc.executeCommand("printf 'not a signature\\n' > ~/data.sig");
    expect(await pc.executeCommand(VERIFY)).toContain("Couldn't parse signature: missing header");
  }, 60_000);
});

describe('ssh-keygen -Y find-principals', () => {
  it('ecrit le principal de la cle', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);

    expect((await pc.executeCommand('ssh-keygen -Y find-principals -f ~/allowed -s ~/data.sig')).trim()).toBe('alice@lab');
  }, 60_000);

  it('dit No principal matched. quand la cle est inconnue', async () => {
    const pc = await lab();
    await pc.executeCommand(SIGN);
    await pc.executeCommand("printf '# empty\\n' > ~/allowed");

    expect(await pc.executeCommand('ssh-keygen -Y find-principals -f ~/allowed -s ~/data.sig; echo "rc=$?"'))
      .toContain('No principal matched.\nrc=255');
  }, 60_000);
});
