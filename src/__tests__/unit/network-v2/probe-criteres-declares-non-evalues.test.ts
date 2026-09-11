/**
 * Sonde — trois criteres annonces que rien n'evaluait.
 *
 * Releves lors d'un recoupement entre la SYNTAXE que porte l'aide et la
 * declaration que porte la cmdlet, ils etaient restes ouverts :
 *
 *  - `Get-LocalUser` ne declare AUCUN parametre, alors qu'il honore
 *    `-Name` par une fonction d'aide : la completion n'a donc jamais rien
 *    a proposer. Et `-SID`, que l'aide annonce, n'est jamais lu — la
 *    cmdlet rend tous les comptes au lieu de celui reclame.
 *  - `Get-Volume` DECLARE `-FileSystemLabel` et ne filtre jamais dessus.
 *  - l'aide de `Get-Volume` annonce `-FriendlyName`, qui n'est pas un
 *    parametre de cette cmdlet : c'est un ALIAS d'affichage de
 *    `FileSystemLabel` dans le CDXML du module Storage. La syntaxe
 *    promettait donc un parametre qui n'a jamais existe.
 *
 * Un critere annonce que rien n'evalue a toute l'apparence d'exister sauf
 * l'effet (regle 6).
 *
 * Les attentes sont ecrites d'apres la documentation de l'editeur.
 *
 * Discrimination `git stash` : 4 des 6 cas tombent. Les deux autres sont
 * des TEMOINS — `Get-LocalUser` et `Get-Volume` sans filtre rendent bien
 * quelque chose — sans quoi quatre refus mesureraient une machine vide
 * plutot que des criteres ignores.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

function lab(): { pc: WindowsPC; shell: PowerShellSubShell; ps: (l: string) => Promise<string> } {
  const pc = new WindowsPC('windows-pc', 'PC1');
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  return { pc, shell, ps: async (l) => (await shell.processLine(l)).output.join('\n') };
}

describe('Sonde — un critere annonce est un critere evalue', () => {
  it('Get-LocalUser propose ses parametres a la completion', () => {
    const { shell } = lab();
    const proposals = shell.getCompletions('Get-LocalUser -');
    expect(proposals).toContain('-Name');
    expect(proposals).toContain('-SID');
  });

  it('Get-LocalUser -SID rend LE compte demande, pas tous', async () => {
    const { ps } = lab();
    const sid = (await ps('(Get-LocalUser -Name Administrator).SID')).trim();
    expect(sid).toMatch(/^S-1-/);
    const out = await ps(`Get-LocalUser -SID "${sid}" | Select-Object -ExpandProperty Name`);
    expect(out).toMatch(/Administrator/i);
    expect(out.trim().split(/\n+/).length).toBe(1);
  });

  it('Get-Volume -FileSystemLabel filtre au lieu de tout rendre', async () => {
    const { ps } = lab();
    const out = await ps('Get-Volume -FileSystemLabel "PasUnVolume"');
    expect(out).toMatch(/No MSFT_Volume objects found/i);
  });

  it('l aide de Get-Volume n annonce plus un parametre qui n existe pas', async () => {
    const { ps } = lab();
    const aide = await ps('Get-Help Get-Volume');
    expect(aide).not.toContain('-FriendlyName');
    expect(aide).toContain('-FileSystemLabel');
  });

  it('TEMOIN : Get-LocalUser sans argument rend les comptes', async () => {
    const { ps } = lab();
    expect(await ps('Get-LocalUser')).toMatch(/Administrator/i);
  });

  it('TEMOIN : Get-Volume sans filtre rend les volumes', async () => {
    const { ps } = lab();
    expect(await ps('Get-Volume')).toMatch(/C/);
  });
});
