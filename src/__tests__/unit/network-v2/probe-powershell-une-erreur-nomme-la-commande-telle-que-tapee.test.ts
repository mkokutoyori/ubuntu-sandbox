/**
 * Sonde : PowerShell 7 est la seule version du projet ; l'erreur d'une commande nomme le cmdlet resolu.
 * (Historique : Windows PowerShell 5.1, retire, nommait la commande TELLE QUE TAPEE (`cd : Cannot find path ...`, `ls : ...`,
 * `md : ...`), alors que la categorie garde le cmdlet (`[Set-Location]`) ;
 * PowerShell 7 nomme le cmdlet resolu (`Set-Location: ...`) ; l'enregistrement
 * d'erreur porte l'InvocationInfo de la commande fautive.
 *
 * Mesure de depart (W14, avant ce lot) : `cd C:\nope`, `ls C:\nope`,
 * `gci C:\nope`, `dir C:\nope`, `sl`, `chdir` ecrivaient tous le nom du cmdlet
 * resolu en tete (`Set-Location : ...`, `Get-ChildItem : ...`) ; `md C:\Users`
 * ecrivait `mkdir : ...` ; `$_.InvocationInfo.InvocationName`,
 * `$_.InvocationInfo.MyCommand.Name` et `$_.CategoryInfo.Activity` d'un
 * enregistrement attrape par try/catch ou range par -ErrorVariable etaient
 * vides.
 *
 * Autorites : PowerShell 7.4.6 (tag v7.4.6),
 * FormatAndOutput/DefaultFormatters/PowerShellCore_format_ps1xml.cs - la vue
 * normale (Windows PowerShell 5.1) prefixe le message par
 * `$myinv.InvocationName + ' : '`, ou par `$myinv.MyCommand.Name` quand
 * InvocationName vaut `&`, `.` ou rien (appel par operateur) ; la vue concise
 * (PowerShell 7) prefixe par `$myinv.MyCommand` (le cmdlet resolu), jamais
 * par l'alias tape. ErrorCategoryInfo.Activity vaut le nom du cmdlet qui a
 * ecrit l'erreur. InvocationName est le nom tel que tape, alias compris.
 *
 * Sur l'arbre sans ce lot : 16 des 23 cas tombent. Passent des deux cotes,
 * tous temoins : les noms complets (`Get-Item`, `Get-ChildItem`), l'appel par
 * operateur (`& cd`), les trois cas de PowerShell 7 (le cmdlet resolu) et la
 * sortie sans erreur.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function shellFor(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}

async function run(sub: PowerShellSubShell, line: string): Promise<string[]> {
  return (await sub.processLine(line)).output;
}

const missing = "Cannot find path 'C:\\nope' because it does not exist.";

describe('PowerShell 7 names the resolved cmdlet whatever was typed', () => {
  it.each([
    ['cd', 'Set-Location'],
    ['ls', 'Get-ChildItem'],
    ['gci', 'Get-ChildItem'],
  ])('%s fails as %s', async (typed, cmdlet) => {
    const out = await run(shellFor(), `${typed} C:\\nope`);
    expect(out).toEqual([`${cmdlet}: ${missing}`]);
  });

  it('still records the name that was typed', async () => {
    const sub = shellFor();
    await run(sub, 'cd C:\\nope -ErrorVariable ev');
    expect(await run(sub, '$ev[0].InvocationInfo.InvocationName')).toEqual(['cd']);
  });
});
