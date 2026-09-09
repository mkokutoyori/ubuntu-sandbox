/**
 * Un poste Windows a UN agencement de disques, comme le poste Linux.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un `windows-pc` ordinaire, en
 * posant la MEME question a toutes ses vues :
 *
 * ```
 * Get-Disk        0 Microsoft Virtual Disk  100.00 GB   MBR  True True
 *                 1 Virtual HD D:            50.00 GB   MBR  False False
 * Get-Volume      C Windows NTFS 99.83 GB / 100.00 GB
 *                 D Data    NTFS 50.00 GB /  50.00 GB
 * Get-Partition   « n'est pas reconnu »
 * fsutil          « n'est pas reconnu »
 * wmic diskdrive  sda  QEMU HARDDISK  53687091200      (un disque ext4 !)
 * ```
 *
 * Trois defauts, tous mesures.
 *
 * (1) `Get-Disk` rendait UNE LIGNE PAR LETTRE DE LECTEUR. Un disque
 * physique n'est pas un volume : deux lettres portees par le meme disque
 * en faisaient deux, et un `mkdir E:\` en faisait apparaitre un
 * troisieme — un disque qui n'existe pas. Le numero de serie « du
 * disque » etait meme derive du numero de serie du VOLUME, deux notions
 * que Windows distingue.
 *
 * (2) L'inventaire materiel de la machine decrivait un disque LINUX.
 * `HardwareProfile.defaultFor()` ne connaissait qu'un role, pas une
 * plateforme, si bien qu'un poste Windows portait `sda1` monte sur `/`
 * en `ext4` — ce que `wmic diskdrive` rendait mot pour mot depuis le lot
 * precedent. Pendant ce temps le systeme de fichiers Windows inventait
 * ses propres 100 Go pour `C:` et 50 Go pour `D:` : deux ecritures du
 * meme fait, qui ne pouvaient que se contredire.
 *
 * (3) `Get-Partition` et `fsutil` n'existaient pas, alors que ce sont
 * les deux commandes par lesquelles on lit un agencement de disques sous
 * Windows.
 *
 * ── Discrimination (`git stash push -- src/network src/powershell`) ─
 *
 * Mesuree : 8 cas sur 10 tombent contre l'etat d'avant. Les DEUX qui
 * passent des deux cotes sont les TEMOINS, et c'est leur role : les
 * tailles de volume (`C:` = 100 Gio, `D:` = 50 Gio) et les etiquettes
 * que `Get-Volume` rend ne doivent pas bouger en changeant de source.
 * Elles etaient justes avant parce que le systeme de fichiers les
 * inventait ; elles le restent parce que la partition les porte.
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
  return createDevice('windows-pc', 0, 0) as unknown as Cmd;
}

function lignesDeDonnees(sortie: string): string[] {
  return sortie.split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !/^-+[\s-]*$/.test(l.trim()));
}

describe('les disques PHYSIQUES sont ceux de l inventaire', () => {
  it('un poste a deux disques, et une lettre de plus n en cree pas un troisieme', async () => {
    const pc = poste();

    const avant = await pc.executeCommand('powershell Get-Disk');
    await pc.executeCommand('powershell New-Item -ItemType Directory -Path E:\\');
    const apres = await pc.executeCommand('powershell Get-Disk');

    const disques = (s: string) => s.split('\n').filter((l) => /^\s*\d+\s+\S/.test(l)).length;
    expect(disques(avant)).toBe(2);
    expect(disques(apres)).toBe(2);
  });

  it('wmic diskdrive et Get-Disk nomment le MEME disque', async () => {
    const pc = poste();

    const parWmic = (await pc.executeCommand('wmic diskdrive get deviceid,model'))
      .split('\n')[1]?.trim().replace(/^\S+\s+/, '').trim() ?? '<aucun>';
    const parPs = (await pc.executeCommand('powershell Get-Disk'))
      .split('\n').find((l) => /^\s*0\s/.test(l))?.trim() ?? '<aucun>';

    expect(parWmic).not.toBe('<aucun>');
    expect(parPs).toContain(parWmic);
  });

  it('le disque systeme porte la partition reservee ET C:', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('powershell Get-Partition -DiskNumber 0');

    expect(sortie).toContain('Disk Number: 0');
    const lignes = lignesDeDonnees(sortie).filter((l) => /^\d+\s/.test(l.trim()));
    expect(lignes.length).toBe(2);
    expect(lignes[1]).toMatch(/^\s*2\s+C\s+\d+\s/);
  });

  it('Get-Partition -DriveLetter C ne rend que la sienne', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('powershell Get-Partition -DriveLetter C');

    expect(sortie).toContain('Disk Number: 0');
    expect(lignesDeDonnees(sortie).filter((l) => /^\d+\s/.test(l.trim())).length).toBe(1);
  });
});

describe('fsutil volume repond ce que le volume contient', () => {
  it('diskfree rend les trois totaux, avec leur equivalent en Go', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('fsutil volume diskfree C:');

    expect(sortie).toMatch(/^Total # of free bytes {8}: \d+ \(\d+\.\d{2}GB\)$/m);
    expect(sortie).toMatch(/^Total # of bytes {13}: \d+ \(\d+\.\d{2}GB\)$/m);
    expect(sortie).toMatch(/^Total # of avail free bytes {2}: \d+ \(\d+\.\d{2}GB\)$/m);
  });

  it('le total qu il annonce est celui que dir compte', async () => {
    const pc = poste();

    const parFsutil = /Total # of free bytes\s+: (\d+)/
      .exec(await pc.executeCommand('fsutil volume diskfree C:'))?.[1] ?? '<aucun>';
    const parDir = /([\d,]+) bytes free/
      .exec(await pc.executeCommand('dir C:\\'))?.[1].replace(/,/g, '') ?? '<aucun>';

    expect(parFsutil).toBe(parDir);
  });

  it('list rend les lettres montees', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('fsutil volume list');

    expect(sortie).toContain('C:\\');
    expect(sortie).toContain('D:\\');
  });

  it('un volume qui n existe pas est REFUSE', async () => {
    const pc = poste();

    expect(await pc.executeCommand('fsutil volume diskfree Z:'))
      .toContain('Error:  The system cannot find the path specified.');
  });
});

describe('TEMOINS', () => {
  it('les tailles de volume ne bougent pas', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('wmic logicaldisk get caption,size');
    const taille = (letter: string) => sortie.split('\n')
      .find((l) => l.trim().startsWith(letter))?.trim().split(/\s+/)[1] ?? '<aucun>';

    expect(taille('C:')).toBe('107374182400');
    expect(taille('D:')).toBe('53687091200');
  });

  it('Get-Volume garde ses deux lettres et leur etiquette', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('powershell Get-Volume');

    expect(sortie).toMatch(/^C\s+Windows\s+NTFS/m);
    expect(sortie).toMatch(/^D\s+Data\s+NTFS/m);
  });
});
