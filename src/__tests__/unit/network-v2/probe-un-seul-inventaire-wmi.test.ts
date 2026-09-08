/**
 * Un poste Windows n'a qu'UN inventaire, et WMI le lit.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un `windows-pc` ordinaire, en
 * posant la meme question a `systeminfo` et a WMI :
 *
 * ```
 * systeminfo                     System Manufacturer:   QEMU
 *                                System Model:          Standard PC (i440FX...)
 *                                Total Physical Memory: 3,888 MB
 * Get-CimInstance Win32_ComputerSystem
 *                                Manufacturer:        Microsoft Corporation
 *                                Model:               Virtual Machine
 *                                TotalPhysicalMemory: 8589934592
 * wmic bios get serialnumber     (rien)
 * wmic memorychip get capacity   (rien)
 * wmic computersystem get model  (rien)
 * Get-CimInstance Win32_LogicalDisk   Invalid class
 * ```
 *
 * TROIS faits ecrits deux fois, et les deux ecritures se contredisent
 * sur la meme machine au meme instant : le constructeur, le modele et la
 * quantite de memoire. `systeminfo` lit `HardwareProfile` ; WMI portait
 * ses propres constantes. Un laboratoire d'inventaire — recenser un
 * parc, comparer deux postes, verifier une migration — part donc de deux
 * reponses selon la commande tapee.
 *
 * Trois classes de plus manquaient completement, et leur absence est
 * PIRE qu'une erreur : `wmic bios get serialnumber` rendait une ligne
 * VIDE, exit 0. La commande avait l'air d'avoir repondu. Un vrai wmic
 * refuse un alias qu'il ne connait pas (`Alias not found!`).
 *
 * Enfin `wmic logicaldisk` fonctionnait quand
 * `Get-CimInstance Win32_LogicalDisk` repondait « Invalid class » : deux
 * facades de WMI, sur une machine qui n'en a qu'un.
 *
 * ── Discrimination (`git stash push -- src/network src/powershell`) ─
 *
 * Mesuree : 9 cas sur 11 tombent contre l'etat d'avant. Les DEUX autres
 * sont les TEMOINS, et c'est leur role : `systeminfo`, deja juste, qui
 * est le point de comparaison de tout le reste et ne doit pas bouger ;
 * et `wmic logicaldisk`, la seule classe que les deux facades servaient
 * deja, qui prouve qu'en les reunissant on n'a pas casse celle qui
 * marchait.
 *
 * Un cas ecrit a l'aveugle passait POUR RIEN : « Win32_BIOS rend le
 * meme numero que wmic » comparait `<absent>` a `<absent>`, les deux
 * cotes ignorant la classe. Il exige desormais la valeur, et il tombe
 * comme les autres.
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

/** La valeur d'un champ `Nom : valeur` d'une vue liste PowerShell. */
function champ(sortie: string, nom: string): string {
  return new RegExp(`^${nom}\\s*:\\s*(.*)$`, 'm').exec(sortie)?.[1].trim() ?? '<absent>';
}

/** La valeur d'une ligne `Etiquette:   valeur` de `systeminfo`. */
function ligneSysteminfo(sortie: string, nom: string): string {
  return new RegExp(`^${nom}:\\s*(.*)$`, 'm').exec(sortie)?.[1].trim() ?? '<absent>';
}

describe('WMI et systeminfo decrivent le meme chassis', () => {
  it('le constructeur et le modele sont les memes des deux cotes', async () => {
    const pc = poste();

    const si = await pc.executeCommand('systeminfo');
    const cim = await pc.executeCommand('powershell Get-CimInstance Win32_ComputerSystem');

    expect(champ(cim, 'Manufacturer')).toBe(ligneSysteminfo(si, 'System Manufacturer'));
    expect(champ(cim, 'Model')).toBe(ligneSysteminfo(si, 'System Model'));
  });

  it('la memoire totale est la meme des deux cotes', async () => {
    const pc = poste();

    const cim = await pc.executeCommand('powershell Get-CimInstance Win32_ComputerSystem');
    const octets = Number(champ(cim, 'TotalPhysicalMemory'));
    const mo = Number(
      ligneSysteminfo(await pc.executeCommand('systeminfo'), 'Total Physical Memory')
        .replace(/[^\d]/g, ''));

    expect(Math.round(octets / 1024 / 1024)).toBe(mo);
  });
});

describe('les classes materielles de WMI existent', () => {
  it('wmic bios rend le BIOS de la machine', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('wmic bios get manufacturer,smbiosbiosversion');

    expect(sortie.split('\n')[0].trim().split(/\s+/)).toEqual(['Manufacturer', 'SMBIOSBIOSVersion']);
    expect(sortie).toContain('SeaBIOS');
  });

  it('wmic memorychip rend une barrette avec sa capacite', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('wmic memorychip get capacity,devicelocator');

    expect(sortie).toMatch(/^\d+\s+DIMM 0/m);
  });

  it('wmic computersystem rend le meme modele que systeminfo', async () => {
    const pc = poste();

    const parWmic = (await pc.executeCommand('wmic computersystem get model'))
      .split('\n')[1]?.trim() ?? '<absent>';
    const parSysteminfo = ligneSysteminfo(await pc.executeCommand('systeminfo'), 'System Model');

    expect(parWmic).toBe(parSysteminfo);
  });

  it('un alias que WMI ne connait pas est REFUSE, pas rendu vide', async () => {
    const pc = poste();

    expect(await pc.executeCommand('wmic zorglub get name')).toContain('Alias not found!');
  });
});

describe('les deux facades de WMI servent les memes classes', () => {
  it('Win32_LogicalDisk repond a Get-CimInstance comme a wmic', async () => {
    const pc = poste();

    const cim = await pc.executeCommand('powershell Get-CimInstance Win32_LogicalDisk');

    expect(cim).not.toContain('Invalid class');
    expect(cim).toContain('C:');
  });

  it('Win32_DiskDrive aussi, et il decrit le disque physique', async () => {
    const pc = poste();

    const cim = await pc.executeCommand('powershell Get-CimInstance Win32_DiskDrive');

    expect(cim).not.toContain('Invalid class');
    expect(cim).toContain('PHYSICALDRIVE0');
  });

  it('Win32_BIOS rend le meme numero de serie que wmic', async () => {
    const pc = poste();

    const parCim = champ(
      await pc.executeCommand('powershell Get-CimInstance Win32_BIOS'), 'SMBIOSBIOSVersion');
    const parWmic = (await pc.executeCommand('wmic bios get smbiosbiosversion'))
      .split('\n')[1]?.trim() ?? '<absent>';

    expect(parCim).toBe('1.16.0-1');
    expect(parWmic).toBe(parCim);
  });
});

describe('TEMOINS', () => {
  it('systeminfo, deja juste, ne bouge pas', async () => {
    const pc = poste();

    const si = await pc.executeCommand('systeminfo');

    expect(ligneSysteminfo(si, 'System Manufacturer')).toBe('QEMU');
    expect(ligneSysteminfo(si, 'BIOS Version')).toContain('SeaBIOS 1.16.0-1');
  });

  it('wmic logicaldisk, la classe que les deux facades servaient, marche toujours', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('wmic logicaldisk get caption,size');

    expect(sortie.split('\n')[0].trim().split(/\s+/)).toEqual(['Caption', 'Size']);
    expect(sortie).toContain('C:');
  });
});
