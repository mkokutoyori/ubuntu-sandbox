/**
 * Sonde : l'erreur d'une commande PowerShell nomme la commande TELLE QUE TAPEE
 * dans Windows PowerShell 5.1 (`cd : Cannot find path ...`, `ls : ...`,
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

function shellFor(language: 'desktop' | 'core'): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc, { language }).subShell;
}

async function run(sub: PowerShellSubShell, line: string): Promise<string[]> {
  return (await sub.processLine(line)).output;
}

const missing = "Cannot find path 'C:\\nope' because it does not exist.";

describe('Windows PowerShell 5.1 names the command as it was typed', () => {
  it.each([
    ['cd', 'Set-Location'],
    ['chdir', 'Set-Location'],
    ['sl', 'Set-Location'],
    ['ls', 'Get-ChildItem'],
    ['dir', 'Get-ChildItem'],
    ['gci', 'Get-ChildItem'],
    ['GCI', 'Get-ChildItem'],
    ['get-childitem', 'Get-ChildItem'],
    ['Get-ChildItem', 'Get-ChildItem'],
  ])('%s fails with its own name and the cmdlet in the category', async (typed, cmdlet) => {
    const out = await run(shellFor('desktop'), `${typed} C:\\nope`);
    expect(out[0]).toBe(`${typed} : ${missing}`);
    expect(out[1]).toContain(`[${cmdlet}], ItemNotFoundException`);
    expect(out[2]).toBe(`    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.${cmdlet.replace('-', '')}Command`);
  });

  it('writes the full name of a cmdlet that was typed in full', async () => {
    const out = await run(shellFor('desktop'), 'Get-Item C:\\nope');
    expect(out[0]).toBe(`Get-Item : ${missing}`);
  });

  it('writes the cmdlet, not the alias, for a call made with the call operator', async () => {
    const out = await run(shellFor('desktop'), '& cd C:\\nope');
    expect(out[0]).toBe(`Set-Location : ${missing}`);
  });

  it('writes the alias the user defined', async () => {
    const sub = shellFor('desktop');
    await run(sub, 'Set-Alias goto Set-Location');
    const out = await run(sub, 'goto C:\\nope');
    expect(out[0]).toBe(`goto : ${missing}`);
    expect(out[1]).toContain('[Set-Location]');
  });

  it('names md and mkdir as typed while the category says New-Item', async () => {
    const sub = shellFor('desktop');
    for (const typed of ['md', 'mkdir']) {
      const out = await run(sub, `${typed} C:\\Users`);
      expect(out[0]).toBe(`${typed} : An item with the specified name C:\\Users already exists.`);
      expect(out[1]).toContain('[New-Item], IOException');
    }
  });

  it('names the command as typed inside Invoke-Expression', async () => {
    const out = await run(shellFor('desktop'), "Invoke-Expression 'cd C:\\nope'");
    expect(out[0]).toBe(`cd : ${missing}`);
  });

  it('names the command as typed inside a function', async () => {
    const sub = shellFor('desktop');
    await run(sub, 'function Enter-Nope { cd C:\\nope }');
    const out = await run(sub, 'Enter-Nope');
    expect(out[0]).toBe(`cd : ${missing}`);
  });

  it('keeps the invocation of the failing command on the record caught by try/catch', async () => {
    const sub = shellFor('desktop');
    const out = await run(sub, 'try { cd C:\\nope -ErrorAction Stop } catch { $_.InvocationInfo.InvocationName; $_.InvocationInfo.MyCommand.Name; $_.CategoryInfo.Activity }');
    expect(out).toEqual(['cd', 'Set-Location', 'Set-Location']);
  });

  it('keeps the invocation of the failing command on the record stored by -ErrorVariable', async () => {
    const sub = shellFor('desktop');
    await run(sub, 'ls C:\\nope -ErrorVariable ev');
    expect(await run(sub, '$ev[0].InvocationInfo.InvocationName')).toEqual(['ls']);
    expect(await run(sub, '$ev[0].InvocationInfo.MyCommand.CommandType')).toEqual(['Cmdlet']);
    expect(await run(sub, '$ev[0].CategoryInfo.Activity')).toEqual(['Get-ChildItem']);
  });

  it('keeps the call operator out of InvocationName', async () => {
    const sub = shellFor('desktop');
    await run(sub, '& cd C:\\nope -ErrorVariable ev');
    expect(await run(sub, '$ev[0].InvocationInfo.MyCommand.Name')).toEqual(['Set-Location']);
  });

  it('prints nothing when the command succeeds', async () => {
    expect(await run(shellFor('desktop'), 'cd C:\\Windows')).toEqual([]);
  });
});

describe('PowerShell 7 names the resolved cmdlet whatever was typed', () => {
  it.each([
    ['cd', 'Set-Location'],
    ['ls', 'Get-ChildItem'],
    ['gci', 'Get-ChildItem'],
  ])('%s fails as %s', async (typed, cmdlet) => {
    const out = await run(shellFor('core'), `${typed} C:\\nope`);
    expect(out).toEqual([`${cmdlet}: ${missing}`]);
  });

  it('still records the name that was typed', async () => {
    const sub = shellFor('core');
    await run(sub, 'cd C:\\nope -ErrorVariable ev');
    expect(await run(sub, '$ev[0].InvocationInfo.InvocationName')).toEqual(['cd']);
  });
});
