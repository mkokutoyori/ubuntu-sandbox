/**
 * Une machine a UN agencement de disques, et `df` le lit comme les
 * autres.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire, en
 * posant la MEME question a cinq vues de la meme machine :
 *
 * ```
 * lsblk         sda 50G  ├─sda1 48G /   ├─sda2 2G /boot        (pas de sdb)
 * mount         /dev/sda1 on /   /dev/sda2 on /boot            (pas de sdb1)
 * findmnt       idem                                           (pas de sdb1)
 * /proc/mounts  idem                                           (pas de sdb1)
 * df -h         /dev/sda1 50G /   /dev/sda2 976M /boot   /dev/sdb1 100G /u01
 * ```
 *
 * Quatre vues disent que la machine n'a qu'un disque, la cinquieme en
 * invente un second et se trompe en plus sur la taille des deux
 * partitions qui existent. La cause est que `dfTable()` etait une
 * LISTE ECRITE EN DUR, alors que `lsblk` lit `HardwareProfile.storage`
 * et que `mount`/`findmnt`/`/proc/mounts` lisent la `MountTable`, que
 * `MountTable.fromHardware()` derive du meme inventaire.
 *
 * La consequence n'est pas cosmetique : sur un poste sans second
 * disque, `df` annonce 100 Go de libre sur un point de montage qui
 * n'existe pas, et `df -h /boot` annonce 976 Mo la ou la partition en
 * fait 2 Gio. Un laboratoire qui remplit un disque, qui compare avant
 * et apres, ou qui apprend a lire `df` part donc d'un chiffre faux.
 *
 * ── `/etc/fstab` n'existait pas ─────────────────────────────────────
 *
 * `cat /etc/fstab` repondait `No such file or directory` sur une
 * machine qui monte pourtant deux systemes de fichiers. C'est le
 * fichier qui DECIDE de ce qui est monte au demarrage ; une machine qui
 * ne l'a pas ne peut pas etre reparee ni expliquee. Le format est celui
 * que documente Ubuntu (`help.ubuntu.com/community/Fstab`) : six
 * champs, la racine en `UUID=` avec `relatime,errors=remount-ro 0 1`.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 8 cas sur 11 tombent contre l'etat d'avant. Les TROIS qui
 * passent des deux cotes, et pourquoi :
 *
 *  - « un serveur, qui en a un, l affiche » — NON-REGRESSION. La table
 *    ecrite en dur contenait justement la paire `/dev/sdb1 /u01` ; elle
 *    la rendait donc sur un serveur comme sur un poste, ce qui est le
 *    defaut mesure. Le cas garde que ce qui etait juste pour la mauvaise
 *    raison le reste pour la bonne.
 *  - « mount et findmnt lisent toujours le meme inventaire » — TEMOIN.
 *    Ces deux vues lisaient deja la `MountTable` ; leur role est de
 *    prouver que `df` a rejoint la bonne source sans la deplacer.
 *  - « la racine rend toujours son usage REEL » — TEMOIN. Il prouve que
 *    le laboratoire est sain : une ecriture de 64 Mio fait bouger le
 *    chiffre, donc la ligne `/` n'est pas devenue une constante en
 *    passant par la table de montage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Cmd {
  return createDevice('linux-pc', 0, 0) as unknown as Cmd;
}

function serveur(): Cmd {
  return createDevice('linux-server', 0, 0) as unknown as Cmd;
}

/** Les paires (source, point de montage) que `df` rend. */
function montagesDeDf(sortie: string): Array<[string, string]> {
  return sortie.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6)
    .map((c) => [c[0], c[c.length - 1]] as [string, string]);
}

describe('df decrit les disques de LA machine', () => {
  it('un poste sans second disque n a pas de /u01', async () => {
    const pc = poste();

    const sortie = await taper(pc, 'df -h');

    expect(sortie).not.toContain('/dev/sdb1');
    expect(sortie).not.toContain('/u01');
  });

  it('un serveur, qui en a un, l affiche', async () => {
    const srv = serveur();

    const sortie = await taper(srv, 'df -h');

    expect(montagesDeDf(sortie)).toContainEqual(['/dev/sdb1', '/u01']);
  });

  it('df et lsblk s accordent sur la taille de /boot', async () => {
    const pc = poste();

    expect(await taper(pc, 'lsblk')).toMatch(/sda2 .*2G .*\/boot/);
    expect(await taper(pc, 'df -h /boot')).toMatch(/\/dev\/sda2 +2\.0G/);
  });

  it('tout ce que df montre est monte pour de bon', async () => {
    const pc = poste();

    const proc = await taper(pc, 'cat /proc/mounts');
    for (const [source, cible] of montagesDeDf(await taper(pc, 'df -h'))) {
      expect(proc).toContain(`${source} ${cible} `);
    }
  });
});

describe('/etc/fstab existe et decrit le meme agencement', () => {
  it('il porte l en-tete et les six champs documentes', async () => {
    const pc = poste();

    const fstab = await taper(pc, 'cat /etc/fstab');

    expect(fstab).toContain('# /etc/fstab: static file system information.');
    expect(fstab).toContain('# <file system> <mount point>   <type>  <options>       <dump>  <pass>');
  });

  it('la racine est nommee par UUID, en passe 1', async () => {
    const pc = poste();

    const ligne = (await taper(pc, 'cat /etc/fstab')).split('\n')
      .find((l) => /^UUID=\S+\s+\/\s/.test(l)) ?? '';

    expect(ligne).toMatch(/^UUID=\S+\s+\/\s+ext4\s+relatime,errors=remount-ro\s+0\s+1$/);
  });

  it('/boot y figure en passe 2', async () => {
    const pc = poste();

    const ligne = (await taper(pc, 'cat /etc/fstab')).split('\n')
      .find((l) => /\s\/boot\s/.test(l)) ?? '';

    expect(ligne).toMatch(/^UUID=\S+\s+\/boot\s+ext4\s+\S+\s+0\s+2$/);
  });

  it('ses UUID sont ceux que blkid rend', async () => {
    const srv = serveur();

    const fstab = await taper(srv, 'cat /etc/fstab');
    const blkid = await taper(srv, 'blkid');
    const uuid = /UUID="([^"]+)"/.exec(blkid.split('\n')[0])?.[1] ?? '<aucun>';

    expect(fstab).toContain(`UUID=${uuid}`);
  });

  it('un serveur y declare aussi son second disque', async () => {
    const srv = serveur();

    expect(await taper(srv, 'cat /etc/fstab')).toMatch(/^UUID=\S+\s+\/u01\s+ext4\s/m);
  });
});

describe('TEMOINS', () => {
  it('mount et findmnt lisent toujours le meme inventaire', async () => {
    const pc = poste();

    expect(await taper(pc, 'mount')).toContain('/dev/sda1 on / type ext4');
    expect(await taper(pc, 'findmnt')).toContain('/boot /dev/sda2 ext4');
  });

  it('la racine rend toujours son usage REEL', async () => {
    const pc = poste();
    const avant = await taper(pc, 'df /');

    await taper(pc, 'truncate -s 64M /tmp/gros');
    const apres = await taper(pc, 'df /');

    const used = (s: string) => Number(s.split('\n')[1].trim().split(/\s+/)[2]);
    expect(used(apres)).toBeGreaterThan(used(avant));
  });
});
