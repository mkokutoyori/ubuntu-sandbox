/**
 * Une machine a UN noyau, et toutes ses vues le nomment.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire, en
 * posant la MEME question a chaque vue :
 *
 * ```
 * uname -r         5.15.0-130-generic
 * /proc/version    5.15.0-130-generic
 * modinfo e1000    vermagic: 5.15.0-130-generic
 * cat /etc/motd    Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic)
 * last             reboot   system boot   5.15.0-91-generic
 * dmesg            Linux version 5.15.0-generic
 * ipsec version    Linux strongSwan U5.9.8/K5.15.0-generic
 * ```
 *
 * TROIS noyaux differents sur la meme machine au meme instant, et DEUX
 * versions d'Ubuntu : `lsb_release` et `/etc/os-release` disent 22.04.4,
 * la banniere dit 22.04.3. Un operateur qui ouvre une session lit une
 * banniere, tape `uname -a`, et voit deux machines.
 *
 * Ce n'est pas cosmetique. `modinfo` nomme
 * `/lib/modules/5.15.0-130-generic/kernel/...` alors que `/lib/modules/`
 * N'EXISTE PAS : un laboratoire qui fait `ls /lib/modules/$(uname -r)`,
 * le geste normal pour inspecter les modules, ne trouve rien. Et
 * `/etc/issue` — ce que getty imprime avant l'invite — manque alors que
 * le code le LIT deja, avec une banniere de repli ecrite en dur.
 *
 * ── Deux causes trouvees en chemin ─────────────────────────────────
 *
 * L'arbre des modules etait bien SEME, sous `/usr/lib/modules/…` — mais
 * `ls /lib/modules` echouait quand meme, `/lib` etant un lien vers
 * `usr/lib`. Deux defauts de resolution, tous deux dans le VFS :
 * `resolveInode(chemin, false)` cessait de suivre les liens
 * INTERMEDIAIRES alors que `lstat(2)` ne parle que du DERNIER composant ;
 * et `ls <lien>` decrivait le lien au lieu de lister ce qu'il designe,
 * alors que `ls -l <lien>` doit, lui, rendre la ligne du lien — les deux
 * releves sur la machine reelle.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 9 cas sur 12 tombent contre l'etat d'avant. Les TROIS
 * autres sont les TEMOINS, et c'est leur role : `uname -a` et
 * `/proc/version`, qui lisaient deja l'identite et servent de reference
 * a tout le reste, et `lsb_release`, qui donne la version d'Ubuntu que
 * la banniere doit rejoindre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Cmd {
  return createDevice('linux-pc', 0, 0) as unknown as Cmd;
}

async function noyau(pc: Cmd): Promise<string> {
  return (await pc.executeCommand('uname -r')).trim();
}

async function versionUbuntu(pc: Cmd): Promise<string> {
  return /Description:\s*(.*)/.exec(await pc.executeCommand('lsb_release -a'))?.[1].trim()
    ?? '<absente>';
}

describe('toutes les vues nomment le meme noyau', () => {
  it('la banniere du jour', async () => {
    const pc = poste();

    expect(await pc.executeCommand('cat /etc/motd')).toContain(await noyau(pc));
  });

  it('l enregistrement de demarrage de last', async () => {
    const pc = poste();

    const ligne = (await pc.executeCommand('last')).split('\n')
      .find((l) => l.startsWith('reboot')) ?? '';

    expect(ligne).toContain(await noyau(pc));
  });

  it('la premiere ligne de dmesg', async () => {
    const pc = poste();

    const ligne = (await pc.executeCommand('dmesg')).split('\n')[0];

    expect(ligne).toContain(`Linux version ${await noyau(pc)}`);
  });

  it('la ligne de demarrage du noyau nomme le meme vmlinuz', async () => {
    const pc = poste();

    expect(await pc.executeCommand('dmesg')).toContain(`BOOT_IMAGE=/vmlinuz-${await noyau(pc)}`);
  });

  it('strongSwan, qui annonce le noyau sous lequel il tourne', async () => {
    const pc = poste();

    expect(await pc.executeCommand('ipsec version')).toContain(`/K${await noyau(pc)}`);
  });
});

describe('la banniere nomme la version que porte la machine', () => {
  it('le motd et lsb_release s accordent', async () => {
    const pc = poste();

    expect(await pc.executeCommand('cat /etc/motd')).toContain(await versionUbuntu(pc));
  });

  it('/etc/issue existe et porte la meme version', async () => {
    const pc = poste();

    const issue = await pc.executeCommand('cat /etc/issue');

    expect(issue).not.toContain('No such file');
    expect(issue).toContain(await versionUbuntu(pc));
  });
});

describe('le chemin des modules mene quelque part', () => {
  it('/lib/modules porte le repertoire du noyau courant', async () => {
    const pc = poste();

    expect((await pc.executeCommand('ls /lib/modules/')).trim()).toBe(await noyau(pc));
  });

  it('et le fichier que modinfo nomme y est', async () => {
    const pc = poste();

    const chemin = /filename:\s*(\S+)/.exec(await pc.executeCommand('modinfo e1000'))?.[1] ?? '';

    expect(chemin).toContain(`/lib/modules/${await noyau(pc)}/`);
    expect(await pc.executeCommand(`test -e ${chemin}; echo rc=$?`)).toContain('rc=0');
  });
});

describe('TEMOINS', () => {
  it('uname -a nomme deja le bon noyau', async () => {
    const pc = poste();

    expect(await pc.executeCommand('uname -a')).toContain(await noyau(pc));
  });

  it('/proc/version aussi', async () => {
    const pc = poste();

    expect(await pc.executeCommand('cat /proc/version')).toContain(await noyau(pc));
  });

  it('lsb_release garde la version qu il annoncait', async () => {
    const pc = poste();

    expect(await versionUbuntu(pc)).toBe('Ubuntu 22.04.4 LTS');
  });
});
