/**
 * `ssh-keygen` — ecrit A L'AVEUGLE depuis OpenSSH, avant toute lecture de
 * l'implantation de ce depot.
 *
 * Sources, clonees pour ce lot (`github.com/openssh/openssh-portable`) :
 * `ssh-keygen.1` pour la grammaire — `-t ecdsa | ed25519 | rsa`, `-b bits`,
 * `-C comment`, `-f fichier`, `-N phrase`, `-l` (empreinte), `-y` (rendre
 * la publique depuis la privee), `-E hash`, `-F hote` et `-R hote` sur
 * `known_hosts` — et `ssh-keygen.c` pour les CINQ lignes que la generation
 * imprime, mot pour mot :
 *
 *   Generating public/private %s key pair.      (l. 3803)
 *   Your identification has been saved in %s    (l. 3922)
 *   Your public key has been saved in %s        (l. 3937)
 *   The key fingerprint is:                     (l. 3939)
 *   The key's randomart image is:               (l. 3941)
 *
 * Les noms d'algorithme sur le fil viennent des assignations IANA que le
 * format des cles publiques porte en premier champ : `ssh-ed25519`,
 * `ssh-rsa`, `ecdsa-sha2-nistp256`.
 *
 * Les memes cas tournent sur un poste Linux ET sur un poste Windows :
 * Windows 10 et Windows Server 2019 livrent le client OpenSSH, et
 * `ssh-keygen` y ecrit sous le profil de l'utilisateur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function linux(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

function windows(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  return pc;
}

const LINUX_KEY = '/root/.ssh/essai';

describe('ssh-keygen : la generation imprime les cinq lignes d OpenSSH', () => {
  it('Linux : les cinq lignes, dans l ordre', async () => {
    const pc = linux();
    const out = await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${LINUX_KEY}`);
    expect(out).toContain('Generating public/private ed25519 key pair.');
    expect(out).toContain(`Your identification has been saved in ${LINUX_KEY}`);
    expect(out).toContain(`Your public key has been saved in ${LINUX_KEY}.pub`);
    expect(out).toContain('The key fingerprint is:');
    expect(out).toContain("The key's randomart image is:");
  });

  it('Linux : les deux fichiers existent apres coup', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${LINUX_KEY}`);
    expect(await pc.executeCommand(`test -f ${LINUX_KEY} && echo OUI`)).toContain('OUI');
    expect(await pc.executeCommand(`test -f ${LINUX_KEY}.pub && echo OUI`)).toContain('OUI');
  });

  it('Windows : les memes cinq lignes', async () => {
    const pc = windows();
    const out = await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\essai');
    expect(out).toContain('Generating public/private ed25519 key pair.');
    expect(out).toContain('Your identification has been saved in');
    expect(out).toContain('Your public key has been saved in');
    expect(out).toContain('The key fingerprint is:');
    expect(out).toContain("The key's randomart image is:");
  });
});

describe('ssh-keygen : le type demande est le type ECRIT', () => {
  const cas: ReadonlyArray<readonly [string, string]> = [
    ['ed25519', 'ssh-ed25519 '],
    ['rsa', 'ssh-rsa '],
    ['ecdsa', 'ecdsa-sha2-nistp256 '],
  ];

  for (const [type, prefixe] of cas) {
    it(`Linux : -t ${type} rend une publique en « ${prefixe.trim()} »`, async () => {
      const pc = linux();
      await pc.executeCommand(`ssh-keygen -t ${type} -N "" -f ${LINUX_KEY}-${type}`);
      const pub = await pc.executeCommand(`cat ${LINUX_KEY}-${type}.pub`);
      expect(pub.trim().startsWith(prefixe)).toBe(true);
    });
  }

  it('Linux : un type inconnu est REFUSE', async () => {
    const pc = linux();
    const out = await pc.executeCommand(`ssh-keygen -t zorglub -N "" -f ${LINUX_KEY}-z`);
    expect(out.toLowerCase()).toContain('unknown key type');
    expect(out).toContain('zorglub');
  });

  it('Linux : `-b 2048` sur RSA se relit dans l empreinte', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t rsa -b 2048 -N "" -f ${LINUX_KEY}-r2048`);
    const empreinte = await pc.executeCommand(`ssh-keygen -l -f ${LINUX_KEY}-r2048.pub`);
    expect(empreinte.trim().startsWith('2048 ')).toBe(true);
  });
});

describe('ssh-keygen : le commentaire, l empreinte et la publique relue', () => {
  it('Linux : `-C` pose le commentaire en TROISIEME champ de la publique', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -C "alice@labo" -f ${LINUX_KEY}-c`);
    const pub = (await pc.executeCommand(`cat ${LINUX_KEY}-c.pub`)).trim();
    expect(pub.split(/\s+/)[2]).toBe('alice@labo');
  });

  it('Linux : `-l -f` rend « bits SHA256:… commentaire (TYPE) »', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -C "alice@labo" -f ${LINUX_KEY}-l`);
    const ligne = (await pc.executeCommand(`ssh-keygen -l -f ${LINUX_KEY}-l.pub`)).trim();
    expect(ligne).toMatch(/^256 SHA256:\S+ alice@labo \(ED25519\)$/);
  });

  it('Linux : `-E md5` change la forme de l empreinte', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${LINUX_KEY}-md5`);
    const ligne = (await pc.executeCommand(`ssh-keygen -E md5 -l -f ${LINUX_KEY}-md5.pub`)).trim();
    expect(ligne).toContain('MD5:');
    expect(ligne).toMatch(/MD5:([0-9a-f]{2}:){15}[0-9a-f]{2}/);
  });

  it('Linux : `-y -f <privee>` redonne EXACTEMENT la publique', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -C "alice@labo" -f ${LINUX_KEY}-y`);
    const surDisque = (await pc.executeCommand(`cat ${LINUX_KEY}-y.pub`)).trim();
    const recalculee = (await pc.executeCommand(`ssh-keygen -y -f ${LINUX_KEY}-y`)).trim();
    expect(recalculee.split(/\s+/).slice(0, 2).join(' '))
      .toBe(surDisque.split(/\s+/).slice(0, 2).join(' '));
  });

  it('Linux : deux generations ne rendent pas la MEME cle', async () => {
    const pc = linux();
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${LINUX_KEY}-a`);
    await pc.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${LINUX_KEY}-b`);
    const a = (await pc.executeCommand(`cat ${LINUX_KEY}-a.pub`)).trim();
    const b = (await pc.executeCommand(`cat ${LINUX_KEY}-b.pub`)).trim();
    expect(a).not.toBe(b);
  });
});

describe('ssh-keygen : `-F` et `-R` travaillent sur known_hosts', () => {
  const AJOUT = 'echo "10.0.0.9 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz0123456789AB" | sudo tee -a /root/.ssh/known_hosts';

  it('Linux : `-F` retrouve un hote present', async () => {
    const pc = linux();
    await pc.executeCommand('sudo mkdir -p /root/.ssh');
    await pc.executeCommand(AJOUT);
    const out = await pc.executeCommand('sudo ssh-keygen -F 10.0.0.9');
    expect(out).toContain('10.0.0.9');
    expect(out).toContain('ssh-ed25519');
  });

  it('Linux : `-F` sur un hote absent ne rend rien', async () => {
    const pc = linux();
    await pc.executeCommand('sudo mkdir -p /root/.ssh');
    await pc.executeCommand(AJOUT);
    expect((await pc.executeCommand('sudo ssh-keygen -F 10.0.0.99')).trim()).toBe('');
  });

  it('Linux : `-R` retire l hote, et `-F` ne le trouve plus', async () => {
    const pc = linux();
    await pc.executeCommand('sudo mkdir -p /root/.ssh');
    await pc.executeCommand(AJOUT);
    const retrait = await pc.executeCommand('sudo ssh-keygen -R 10.0.0.9');
    expect(retrait).toContain('10.0.0.9');
    expect((await pc.executeCommand('sudo ssh-keygen -F 10.0.0.9')).trim()).toBe('');
  });

  it('l outil lit le ~/.ssh de CELUI qui le lance, pas /root', async () => {
    const pc = linux();
    const foyer = (await pc.executeCommand('echo $HOME')).trim();
    await pc.executeCommand('mkdir -p $HOME/.ssh');
    await pc.executeCommand(
      'echo "10.0.0.8 ssh-ed25519 AAAAB3NzaC1lZDI1NTE5AAAAIzzzz" >> $HOME/.ssh/known_hosts');
    expect(foyer).not.toBe('/root');
    expect(await pc.executeCommand('ssh-keygen -F 10.0.0.8')).toContain('10.0.0.8');
  });
});
