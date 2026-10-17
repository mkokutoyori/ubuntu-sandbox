/*
 * ssh-keygen face aux jetons materiels (FIDO/U2F et PKCS#11) sur une machine
 * qui n'en possede aucun : Linux et Windows.
 *
 * L'AUTORITE : OpenSSH 8.9p1 (`ssh-keygen.c`, `ssh-sk.c`, `sk-usbhid.c`,
 * `ssh-pkcs11.c`, `ssherr.c`).
 * - `-t ed25519-sk|ecdsa-sk` sont des types valides ; la generation affiche
 *   « Generating public/private <type> key pair. » puis « You may need to
 *   touch your authenticator to authorize key generation. » (absent avec
 *   -q), demande le PIN si `resident` ou `verify-required`, puis
 *   `sshsk_enroll` : fournisseur « internal » sans peripherique (sk_probe ne
 *   trouve rien) → SSH_SK_ERR_DEVICE_NOT_FOUND → « Key enrollment failed:
 *   device not found » ; fournisseur de `-w` introuvable → « Provider "<p>"
 *   dlopen failed: <p>: cannot open shared object file: No such file or
 *   directory » puis « Key enrollment failed: invalid format » ;
 * - `-K` : « Enter PIN for authenticator: », « You may need to touch your
 *   authenticator to authorize key download. », « Provider "internal"
 *   returned failure -4 », « Unable to load resident keys: device not
 *   found » ;
 * - `-D <module>` : « dlopen <module> failed: <module>: cannot open shared
 *   object file: No such file or directory » puis « cannot read public key
 *   from pkcs11 » ; un fichier qui n'est pas un objet ELF : « file too short »
 *   ou « invalid ELF header » ;
 * - `-X` est un synonyme de `-i` (import), pas une option de modules DH.
 *
 * Ecrite contre ces sources, avant l'implantation. 14 des 16 cas tombent
 * avant (types -sk inconnus, -K/-D/-w refuses comme « not simulated », -X
 * pris pour les modules DH). Passent des deux cotes les deux TEMOINS : un
 * type d'ordinateur qui marche (ed25519) et l'absence de fichier cree.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function machine(kind: 'linux' | 'windows'): LinuxPC | WindowsPC {
  const device = kind === 'linux' ? new LinuxPC('linux-pc', 'PC1', 0, 0) : new WindowsPC('windows-pc', 'WIN');
  device.powerOn();
  return device;
}

const NO_SUCH = 'cannot open shared object file: No such file or directory';

for (const kind of ['linux', 'windows'] as const) {
  const key = kind === 'linux' ? '/tmp/sk' : 'C:\\sk';
  const module = kind === 'linux' ? '/usr/lib/libmissing.so' : 'C:/missing.dll';
  describe(kind, () => {
    it('TEMOIN: un type classique se genere', async () => {
      const pc = machine(kind);
      const out = await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${key}`);
      expect(out).toContain('Generating public/private ed25519 key pair.');
    }, 60_000);

    it('ed25519-sk : pas d\'authentificateur, l\'enrolement echoue et rien n\'est cree', async () => {
      const pc = machine(kind);
      const out = await pc.executeCommand(`ssh-keygen -t ed25519-sk -N "" -f ${key}`);
      expect(out).toContain('Generating public/private ed25519-sk key pair.');
      expect(out).toContain('You may need to touch your authenticator to authorize key generation.');
      expect(out).toContain('Key enrollment failed: device not found');
      const listing = await pc.executeCommand(kind === 'linux' ? 'ls /tmp' : 'dir C:\\');
      expect(listing).not.toContain('sk.pub');
    }, 60_000);

    it('-w avec un fournisseur introuvable', async () => {
      const pc = machine(kind);
      const out = await pc.executeCommand(`ssh-keygen -t ecdsa-sk -w ${module} -N "" -f ${key}`);
      expect(out).toContain(`Provider "${module}" dlopen failed: ${module}: ${NO_SUCH}`);
      expect(out).toContain('Key enrollment failed: invalid format');
    }, 60_000);

    it('-K sans authentificateur', async () => {
      const pc = machine(kind);
      const out = await pc.executeCommand('ssh-keygen -K');
      expect(out).toContain('Enter PIN for authenticator:');
      expect(out).toContain('You may need to touch your authenticator to authorize key download.');
      expect(out).toContain('Provider "internal" returned failure -4');
      expect(out).toContain('Unable to load resident keys: device not found');
    }, 60_000);

    it('-D avec un module PKCS#11 introuvable', async () => {
      const pc = machine(kind);
      const out = await pc.executeCommand(`ssh-keygen -D ${module}`);
      expect(out).toContain(`dlopen ${module} failed: ${module}: ${NO_SUCH}`);
      expect(out).toContain('cannot read public key from pkcs11');
    }, 60_000);
  });
}

describe('details communs', () => {
  it('-q supprime l\'invite de toucher l\'authentificateur', async () => {
    const out = await machine('linux').executeCommand("ssh-keygen -q -t ed25519-sk -N '' -f /tmp/sk");
    expect(out).not.toContain('You may need to touch');
    expect(out).toContain('Key enrollment failed: device not found');
  }, 60_000);

  it('resident demande le PIN avant l\'enrolement', async () => {
    const out = await machine('linux').executeCommand("ssh-keygen -t ed25519-sk -O resident -N '' -f /tmp/sk");
    expect(out).toContain('Enter PIN for authenticator:');
  }, 60_000);

  it('une option inconnue d\'enrolement est refusee', async () => {
    const out = await machine('linux').executeCommand("ssh-keygen -t ed25519-sk -O bogus -N '' -f /tmp/sk");
    expect(out).toContain('Option "bogus" is unsupported for FIDO authenticator enrollment');
  }, 60_000);

  it('-D sur un fichier qui n\'est pas un objet ELF', async () => {
    const pc = machine('linux');
    await pc.executeCommand("sh -c 'head -c 200 /dev/zero | tr \"\\0\" \"x\" > /tmp/fake.so'");
    expect(await pc.executeCommand('ssh-keygen -D /tmp/fake.so')).toContain('dlopen /tmp/fake.so failed: /tmp/fake.so: invalid ELF header');
    await pc.executeCommand("sh -c 'echo x > /tmp/tiny.so'");
    expect(await pc.executeCommand('ssh-keygen -D /tmp/tiny.so')).toContain('/tmp/tiny.so: file too short');
  }, 60_000);

  it('-s avec -D lit la cle publique puis echoue sans module', async () => {
    const pc = machine('linux');
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f /tmp/ca");
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f /tmp/id");
    const out = await pc.executeCommand('ssh-keygen -s /tmp/ca.pub -D /usr/lib/libmissing.so -I x -n bob /tmp/id.pub');
    expect(out).toContain('cannot read public key from pkcs11');
  }, 60_000);

  it('-X est l\'import (synonyme de -i), pas les modules DH', async () => {
    const pc = machine('linux');
    await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C who -f /tmp/k");
    await pc.executeCommand('ssh-keygen -e -f /tmp/k.pub > /tmp/rfc.pub');
    const imported = await pc.executeCommand('ssh-keygen -X -f /tmp/rfc.pub');
    const expected = (await pc.executeCommand('cut -d" " -f1,2 /tmp/k.pub')).trim();
    expect(imported.trim().startsWith(expected)).toBe(true);
  }, 60_000);
});
