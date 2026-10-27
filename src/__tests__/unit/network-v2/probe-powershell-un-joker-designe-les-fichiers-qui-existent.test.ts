/**
 * Sonde : Set-Content, Add-Content et Clear-Content resolvent un joker comme
 * ContentCommandBase.ResolvePaths - le joker designe les fichiers qui EXISTENT,
 * jamais un fichier a son nom - et un joker sans correspondance est une erreur
 * de chemin introuvable, pas un fichier cree.
 *
 * Mesure de depart (mandeng a 3cd85c4bb) : `Set-Content a*.txt X` n'ecrivait dans
 * aucun des fichiers `a1.txt`, `a2.txt` et creait un fichier nomme `a*.txt` (un
 * nom que Windows refuse) ; `Add-Content a*.txt Y` ajoutait a ce fichier-la ;
 * `Clear-Content a*.txt` repondait que `a*.txt` n'existe pas alors que les deux
 * fichiers existent ; `Set-Content nope*.txt X` creait `nope*.txt` au lieu de
 * dire « Cannot find path » ; un joker au milieu du chemin (`*\f.txt`) n'etait
 * pas developpe ; -WhatIf nommait le joker et non les fichiers ; un fichier
 * cache etait ecrit par un joker sans -Force ; `Set-Content -Path f X` et
 * `Set-Content -LiteralPath f X` ecrivaient un fichier VIDE : la valeur
 * `X` etait lue comme le second argument positionnel alors qu'avec le chemin
 * nomme c'est le premier.
 *
 * Autorites : PowerShell 7.4.6 (tag v7.4.6), ContentCommandBase.cs
 * (ResolvePaths : GetResolvedPSPathFromPSPath developpe le joker ; sans
 * correspondance le joker est une erreur ItemNotFound ; un chemin sans joker
 * absent n'est cree que si la commande ecrit - allowNonexistingPaths vaut vrai
 * pour Set-Content et Add-Content, faux pour Clear-Content et Get-Content),
 * WriteContentCommandBase.cs (ResolvePaths(writerPaths, true, false, ...)),
 * ClearContentCommand.cs (InvokeProvider.Content.Clear : le globber), FileSystemProvider.cs (Dir : un
 * element cache n'est pas enumere sans -Force), LocationGlobber.cs.
 *
 * Sur l'arbre sans ce lot : 11 des 14 cas tombent. Passent des deux cotes,
 * tous temoins : la creation d'un fichier absent, le refus d'un fichier
 * absent par Clear-Content et l'ecriture d'une liste de fichiers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lab(): Promise<Console> {
  const console = await Console.open(new WindowsPC('windows-pc', 'WIN-WC', 0, 0));
  await console.run('powershell');
  await console.runAll(
    'New-Item -Path C:\\lab -ItemType Directory', 'Set-Location C:\\lab',
    'Set-Content a1.txt one', 'Set-Content a2.txt two', 'Set-Content b.log log',
  );
  return console;
}

const names = async (shell: Console, line = 'Get-ChildItem -Name -Force'): Promise<string[]> => {
  const out = await shell.run(line);
  return out === '' ? [] : out.split('\n');
};

describe('a wildcard names the files that exist', () => {
  it('Set-Content writes every file it matches and creates no file named after the wildcard', async () => {
    const shell = await lab();
    expect(await shell.run('Set-Content a*.txt X')).toBe('');
    expect(await shell.run('Get-Content a1.txt, a2.txt, b.log')).toBe('X\nX\nlog');
    expect(await names(shell)).toEqual(['a1.txt', 'a2.txt', 'b.log']);
  });

  it('Add-Content appends to every file it matches', async () => {
    const shell = await lab();
    expect(await shell.run('Add-Content a*.txt Y')).toBe('');
    expect(await shell.run('Get-Content a1.txt, a2.txt')).toBe('one\nY\ntwo\nY');
    expect(await names(shell)).toEqual(['a1.txt', 'a2.txt', 'b.log']);
  });

  it('Clear-Content empties every file it matches', async () => {
    const shell = await lab();
    expect(await shell.run('Clear-Content a*.txt')).toBe('');
    expect(await shell.run('(Get-Content a1.txt, a2.txt, b.log) -join "|"')).toBe('log');
  });

  it('reads a wildcard in the middle of the path', async () => {
    const shell = await lab();
    await shell.runAll('New-Item -Path d1 -ItemType Directory', 'New-Item -Path d2 -ItemType Directory', 'Set-Content d1\\f.txt 1', 'Set-Content d2\\f.txt 2');
    expect(await shell.run('Set-Content *\\f.txt X')).toBe('');
    expect(await shell.run('Get-Content d1\\f.txt, d2\\f.txt')).toBe('X\nX');
  });

  it('names the files the wildcard matches in -WhatIf, one line each', async () => {
    const shell = await lab();
    const out = await shell.run('Set-Content a*.txt X -WhatIf');
    expect(out.split('\n')).toEqual([
      'What if: Performing the operation "Set Content" on target "Path: C:\\lab\\a1.txt".',
      'What if: Performing the operation "Set Content" on target "Path: C:\\lab\\a2.txt".',
    ]);
    expect(await shell.run('Get-Content a1.txt')).toBe('one');
  });

  it('leaves a hidden file out of a wildcard unless -Force is given', async () => {
    const shell = await lab();
    await shell.run('attrib +h a2.txt');
    await shell.run('Set-Content a*.txt X');
    expect(await shell.run('Get-Content a1.txt')).toBe('X');
    expect(await shell.run('Get-Content a2.txt')).toBe('two');
    await shell.run('Set-Content a*.txt X -Force');
    expect(await shell.run('Get-Content a2.txt')).toBe('X');
  });

  it('leaves out what -Exclude names', async () => {
    const shell = await lab();
    await shell.run('Set-Content a*.txt X -Exclude a2*');
    expect(await shell.run('Get-Content a1.txt, a2.txt')).toBe('X\ntwo');
  });
});

describe('the value is the first positional argument once the path is named', () => {
  it('binds it to -Value for Set-Content -Path', async () => {
    const shell = await lab();
    expect(await shell.run('Set-Content -Path a1.txt NEW')).toBe('');
    expect(await shell.run('Get-Content a1.txt')).toBe('NEW');
  });

  it('binds it to -Value for Set-Content -LiteralPath', async () => {
    const shell = await lab();
    expect(await shell.run('Set-Content -LiteralPath a1.txt NEW')).toBe('');
    expect(await shell.run('Get-Content a1.txt')).toBe('NEW');
  });

  it('binds it to -Value for Add-Content -LiteralPath', async () => {
    const shell = await lab();
    expect(await shell.run('Add-Content -LiteralPath a1.txt NEW')).toBe('');
    expect(await shell.run('Get-Content a1.txt')).toBe('one\nNEW');
  });
});

describe('a path that names nothing', () => {
  it('is a missing path for a wildcard that matches nothing, and creates nothing', async () => {
    const shell = await lab();
    const out = await shell.run('Set-Content nope*.txt X');
    expect(out).toContain("Cannot find path 'C:\\lab\\nope*.txt' because it does not exist.");
    expect(out).toContain('PathNotFound,Microsoft.PowerShell.Commands.SetContentCommand');
    expect(await names(shell)).toEqual(['a1.txt', 'a2.txt', 'b.log']);
  });

  it('is created by Set-Content when it holds no wildcard', async () => {
    const shell = await lab();
    expect(await shell.run('Set-Content fresh.txt X')).toBe('');
    expect(await shell.run('Get-Content fresh.txt')).toBe('X');
  });

  it('is refused by Clear-Content', async () => {
    const shell = await lab();
    expect(await shell.run('Clear-Content missing.txt')).toContain("Cannot find path 'C:\\lab\\missing.txt' because it does not exist.");
  });

  it('is written for every file of a list', async () => {
    const shell = await lab();
    expect(await shell.run('Set-Content a1.txt, b.log X')).toBe('');
    expect(await shell.run('Get-Content a1.txt, b.log')).toBe('X\nX');
  });
});
