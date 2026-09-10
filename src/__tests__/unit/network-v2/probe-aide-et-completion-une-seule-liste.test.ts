/**
 * Sonde — `Get-Help` et `-<Tab>` nomment les MEMES parametres.
 *
 * `CmdletHelp.ts` portait, pour 33 cmdlets, une seconde liste de
 * parametres ecrite a la main sous forme de texte libre
 * (`'-Path, -Destination, -Recurse, ...'`), sans aucun lien avec
 * `ICmdlet.parameters` que la completion interroge. Deux ecritures d'un
 * seul fait ne restent pas egales : 26 des 33 entrees divergeaient du
 * code, 103 parametres declares manquaient a l'aide, et l'aide de
 * `Get-NetAdapter` annoncait un `-All` que la cmdlet n'a pas — un
 * parametre annonce qui ne fait rien.
 *
 * L'aide DERIVE desormais de la declaration : une seule liste, deux vues.
 *
 * Discrimination `git stash` : 3 cas tombent avant le correctif —
 * « l aide nomme les parametres que la completion propose »,
 * « l aide n annonce plus un parametre que la cmdlet n a pas » et
 * « -Parameter refuse un nom que la cmdlet ne declare pas ».
 *
 * Passent des deux cotes, et pourquoi :
 *  - « -Detailed ouvre bien une section PARAMETERS » — NON-REGRESSION :
 *    la section existait, elle doit survivre au changement de source.
 *  - « -Parameter accepte un nom que la cmdlet declare » — NON-REGRESSION :
 *    l'ancien rendu affichait la liste entiere sous ce nom, le nouveau
 *    nomme le parametre ; dans les deux cas le nom demande apparait.
 *  - « la completion propose les memes noms pour Copy-Item » — TEMOIN :
 *    mesure la vue de reference, celle dont l'aide doit desormais
 *    s'accorder ; elle etait deja juste et doit le rester.
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

function lab(): { shell: PowerShellSubShell; ps: (line: string) => Promise<string> } {
  const pc = new WindowsPC('windows-pc', 'PC1');
  pc.powerOn();
  const shell = PowerShellSubShell.create(pc).subShell;
  return { shell, ps: async (line) => (await shell.processLine(line)).output.join('\n') };
}

describe('Sonde — une seule liste de parametres, deux vues', () => {
  it('l aide nomme les parametres que la completion propose', async () => {
    const { shell, ps } = lab();
    const complete = shell.getCompletions('Get-Content -');
    expect(complete).toContain('-Encoding');
    expect(complete).toContain('-Delimiter');

    const aide = await ps('Get-Help Get-Content -Detailed');
    expect(aide).toContain('-Encoding');
    expect(aide).toContain('-Delimiter');
  });

  it('l aide n annonce plus un parametre que la cmdlet n a pas', async () => {
    const { shell, ps } = lab();
    expect(shell.getCompletions('Get-NetAdapter -')).not.toContain('-All');
    const aide = await ps('Get-Help Get-NetAdapter -Detailed');
    const section = aide.slice(aide.indexOf('PARAMETERS'));
    expect(section).not.toContain('-All');
  });

  it('-Parameter refuse un nom que la cmdlet ne declare pas', async () => {
    const { ps } = lab();
    const out = await ps('Get-Help Set-DnsClientServerAddress -Parameter Zorglub');
    expect(out).toContain('Cannot find parameter matching the name');
  });

  it('-Parameter accepte un nom que la cmdlet declare', async () => {
    const { ps } = lab();
    const out = await ps('Get-Help Set-DnsClientServerAddress -Parameter InterfaceAlias');
    expect(out).toContain('-InterfaceAlias');
  });

  it('-Detailed ouvre bien une section PARAMETERS', async () => {
    const { ps } = lab();
    expect(await ps('Get-Help Get-Process -Detailed')).toContain('PARAMETERS');
  });

  it('TEMOIN : la completion propose les memes noms pour Copy-Item', async () => {
    const { shell, ps } = lab();
    const complete = shell.getCompletions('Copy-Item -');
    expect(complete).toContain('-Path');
    expect(complete).toContain('-Destination');
    const aide = await ps('Get-Help Copy-Item -Detailed');
    expect(aide).toContain('-Destination');
  });
});
