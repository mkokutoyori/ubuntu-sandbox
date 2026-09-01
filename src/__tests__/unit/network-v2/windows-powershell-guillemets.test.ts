/**
 * `powershell` recoit la QUEUE de la ligne de commande, guillemets
 * compris, parce que c'est LUI qui l'analyse. Trouve en mesurant tout
 * autre chose — une interface d'equipe LBFO s'appelle
 * « Team1 - VLAN 42 » et aucune commande ne pouvait la nommer.
 *
 * LE DEFAUT MESURE depasse de loin ce cas. `splitCmdArgs` retire les
 * guillemets en decoupant — ce qui est JUSTE pour les commandes de
 * cmd.exe lui-meme, `dir "Mes documents"` recevant bien un seul
 * argument — puis le relais PowerShell recollait les morceaux avec des
 * espaces. PowerShell ne voyait donc plus de chaine litterale du tout :
 * `Write-Output "a - b"` rendait `a` puis `NaN`, le tiret etant lu
 * comme une SOUSTRACTION entre deux mots ; `"Domain Admins - Backup"`
 * rendait trois lignes ; `Get-Item -Path "a - b"` cherchait le chemin
 * `a`. Autrement dit toute chaine entre guillemets contenant une
 * espace etait mise en pieces, ce qui touche les chemins, les noms
 * d'affichage, les descriptions — pas seulement l'agregation.
 *
 * Le correctif suit ce que fait un vrai shell : cmd.exe passe la queue
 * BRUTE au processus enfant, qui fait sa propre analyse. Le decoupage
 * garde une variante qui conserve les guillemets, employee pour ce
 * seul relais, de sorte qu'aucune commande de cmd.exe ne change de
 * comportement. La sequence `""` a l'interieur d'un `-Command "..."`
 * est l'echappement de cmd.exe pour un guillemet litteral et est
 * repliee comme telle.
 *
 * DISCRIMINATION : 8 des 12 cas tombent contre l'etat d'avant. Les 4
 * autres sont nommes : la chaine SANS espace, qui survivait au
 * recollage ; les apostrophes, que le decoupage ne touchait pas ; la
 * soustraction VRAIE entre parentheses, qui doit continuer de donner
 * -1 et garde que le correctif n'a pas desactive l'operateur ; et un
 * mot nu, temoin du chemin ordinaire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { splitCmdArgs } from '@/network/devices/windows/cmdline';

describe('une chaine entre guillemets traverse le relais PowerShell', () => {
  let pc: WindowsPC;

  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
    pc = new WindowsPC('windows-pc', 'WS', 0, 0);
    pc.powerOn();
  });
  afterEach(() => { vi.useRealTimers(); });

  const ps = (c: string) => pc.executeCommand(`powershell ${c}`);

  it('un tiret entre deux mots reste dans la chaine', async () => {
    expect(await ps('Write-Output "a - b"')).toBe('a - b');
  });

  it('plusieurs espaces et un tiret survivent ensemble', async () => {
    expect(await ps('Write-Output "Domain Admins - Backup"')).toBe('Domain Admins - Backup');
  });

  it('la chaine passe aussi entre parentheses', async () => {
    expect(await ps('Write-Output ("a - b")')).toBe('a - b');
  });

  it('elle passe par une variable', async () => {
    expect(await ps('$x = "a - b"; Write-Output $x')).toBe('a - b');
  });

  it('des chiffres entre guillemets restent du texte', async () => {
    expect(await ps('Write-Output "1 - 2"')).toBe('1 - 2');
  });

  it('un parametre nomme recoit la chaine entiere', async () => {
    expect(await ps('Get-Item -Path "a - b"')).toContain("'a - b'");
  });

  it('`-Command` replie l\'echappement `\"\"` de cmd.exe', async () => {
    expect(await ps('-Command "Write-Output ""a - b"""')).toBe('a - b');
  });

  it('le decoupage garde les guillemets quand on le lui demande', () => {
    expect(splitCmdArgs('powershell Write-Output "a - b"'))
      .toEqual(['powershell', 'Write-Output', 'a - b']);
    expect(splitCmdArgs('powershell Write-Output "a - b"', true))
      .toEqual(['powershell', 'Write-Output', '"a - b"']);
  });

  it('une chaine SANS espace passait deja', async () => {
    expect(await ps('Write-Output "a-b"')).toBe('a-b');
  });

  it('les apostrophes passaient deja', async () => {
    expect(await ps("Write-Output 'a - b'")).toBe('a - b');
  });

  it('la soustraction reste une soustraction', async () => {
    expect(await ps('Write-Output (1 - 2)')).toBe('-1');
  });

  it('TEMOIN : un mot nu traverse le chemin ordinaire', async () => {
    expect(await ps('Write-Output hello')).toBe('hello');
  });
});
