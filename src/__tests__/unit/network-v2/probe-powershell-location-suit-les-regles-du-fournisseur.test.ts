/**
 * Le modele de position de PowerShell suit les regles du fournisseur : `~`, un emplacement par lecteur, les
 * lecteurs comme commandes, la casse du disque sur le dernier nom, `cd -` et `cd +`, les fournisseurs autres que le
 * systeme de fichiers.
 *
 * Mesure de depart (6c86125ec), un WindowsPC et un terminal PowerShell (Windows PowerShell 5.1 par defaut, PowerShell
 * 7 pour le groupe qui le dit). `cd ~`, `ls ~`, `Resolve-Path ~` et `Test-Path ~\Documents` cherchaient un element
 * nomme `~` au lieu du profil ; `D:` et `Z:` n'etaient pas des commandes (« The term 'D:\' is not recognized ») ;
 * `cd D:` allait a la racine de D: au lieu de sa derniere position ; le dernier nom d'un chemin gardait la casse
 * tapee ; en 5.1, `cd -` repondait `0` et `cd +` ne disait rien au lieu de refuser un chemin de ce nom ; en 7, `cd -`
 * et `cd +` ne revenaient ni n'avancaient, et `Set-Location` sans chemin ne rentrait pas au profil ; apres
 * `Set-Location HKLM:\SOFTWARE` le prompt restait sur C:, et `cd ..` comme `cd Microsoft` deplacaient le dossier de
 * C: ; `Get-Location -Stack` listait le plus ancien d'abord ; `Resolve-Path` d'un chemin absent affichait un tableau
 * au lieu de « Cannot find path ... because it does not exist. » ; `Pop-Location -StackName` et `Get-Location
 * -StackName` d'une pile qui n'existe pas (ou plus) ne disaient rien ; `Push-Location 'br[1]'` entrait dans un dossier
 * `br[1]` alors que PowerShell lit les crochets comme un joker et refuse ; `Get-Location -PSDrive Work`, d'un lecteur
 * cree par `New-PSDrive`, repondait « Cannot find drive. A drive with the name 'Work' does not exist. ».
 *
 * Autorites : les sources de PowerShell 7.4.6 -- `SessionStateInternal.SetLocation` (historique borne a 20, `-` et `+`
 * hors de l'edition 5.1, `~` vers le dossier personnel, `D:` seul rend la position courante du lecteur, le chemin tape
 * dans PathNotFound), `SessionStateInternal.PopLocation` (une pile nommee disparait quand elle se vide, une pile
 * absente est refusee), `LocationGlobber` (un chemin a joker qui ne trouve rien est PathNotFound, sauf sous
 * `-LiteralPath`), `FileSystemProvider.NormalizeRelativePath` (seule la casse du DERNIER nom est celle du disque),
 * `SessionStateStrings` pour les textes ; les pages Microsoft Learn de `Set-Location`, `Push-Location`,
 * `Pop-Location`, `Get-Location` et `Resolve-Path` pour les parametres et le vocabulaire.
 *
 * Sur les 44 cas, 31 tombent avant la correction. Les 13 qui passent dans les deux etats sont de trois sortes. Les
 * cas de NON-REGRESSION, que PowerShell faisait deja juste : `Set-Location` sans chemin et avec un chemin vide ou nul
 * qui restent en place en 5.1, `Get-Location -PSDrive`, `Pop-Location` sur une pile vide, `Push-Location` qui empile
 * meme quand le deplacement echoue, `Push-Location D:\Data` puis `Pop-Location` entre deux lecteurs, la pile propre a
 * chaque PowerShell, et `Resolve-Path` d'un chemin qui existe. Le GARDE-FOU « starts every other drive at its root
 * whatever cmd remembered » : la base passe par construction (elle ne retient aucun repertoire de lecteur), il sert a
 * interdire que la memoire par lecteur de cmd (`=D:`) fuie dans PowerShell, qui l'ignore. Les GARDE-FOUS nes de la
 * mutation de ce lot, que l'ancien modele tenait deja et que le nouveau pouvait perdre : le nom du fournisseur de
 * l'emplacement courant, le resultat de `-PassThru` de `Set-Location` et de `Push-Location`, et `-LiteralPath` qui
 * prend le nom tel qu'il est tape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function windowsPowerShell(...setup: string[]): Promise<Console> {
  const machine = new WindowsPC('windows-pc', 'WIN-PS', 0, 0);
  const shell = await Console.open(machine, 'a');
  await shell.runAll(
    'echo text> C:\\Users\\User\\plain.txt',
    'mkdir C:\\Users\\User\\MixedCase',
    ...setup,
    'powershell',
  );
  return shell;
}

async function corePowerShell(): Promise<Console> {
  const machine = new WindowsPC('windows-pc', 'WIN-PS', 0, 0);
  const shell = await Console.open(machine, 'a');
  await shell.run('pwsh');
  return shell;
}

const PS = (directory: string): string => `PS ${directory}> `;

describe('PowerShell home directory', () => {
  it('goes to the profile directory for ~', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('cd ~')).toBe('');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('resolves ~\\ and ~/ against the profile directory', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd C:\\Windows');
    await shell.run('cd ~\\Documents');
    expect(shell.prompt).toBe(PS('C:\\Users\\User\\Documents'));
    await shell.run('cd C:\\Windows');
    await shell.run('cd ~/Downloads');
    expect(shell.prompt).toBe(PS('C:\\Users\\User\\Downloads'));
  });

  it('tests a path under ~', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('Test-Path ~\\Documents')).toBe('True');
    expect(await shell.run('Test-Path ~')).toBe('True');
  });

  it('resolves ~ with Resolve-Path', async () => {
    const shell = await windowsPowerShell();
    const output = await shell.run('Resolve-Path ~');
    expect(output).toContain('C:\\Users\\User');
    expect(output).not.toContain('~');
  });

  it('lists the profile directory for ls ~', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('ls ~')).toContain('Directory: C:\\Users\\User');
  });
});

describe('PowerShell drives as commands', () => {
  it('switches drive with D: and C:', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('D:')).toBe('');
    expect(shell.prompt).toBe(PS('D:\\'));
    expect(await shell.run('C:')).toBe('');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('names a drive that does not exist', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('Z:')).toContain("Cannot find drive. A drive with the name 'Z' does not exist.");
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('returns to the last location of a drive for cd D:', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('cd D:\\Data', 'cd C:\\Windows');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
    await shell.run('cd D:');
    expect(shell.prompt).toBe(PS('D:\\Data'));
    await shell.run('cd C:');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('keeps one location per drive for D: as a command', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('cd D:\\Projects', 'C:');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
    await shell.run('D:');
    expect(shell.prompt).toBe(PS('D:\\Projects'));
  });

  it('reports the location of another drive with Get-Location -PSDrive', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('cd D:\\Data', 'cd C:\\Windows');
    expect(await shell.run('(Get-Location -PSDrive D).Path')).toBe('D:\\Data');
    expect(await shell.run('(Get-Location -PSDrive C).Path')).toBe('C:\\Windows');
  });

  it('starts every other drive at its root whatever cmd remembered', async () => {
    const shell = await windowsPowerShell('cd /d D:\\Data', 'cd /d C:\\Users\\User');
    await shell.run('cd D:');
    expect(shell.prompt).toBe(PS('D:\\'));
  });
});

describe('PowerShell stores the leaf with the case of the disk', () => {
  it('fixes the last name of an absolute path and keeps the others as typed', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd c:\\users\\user\\documents');
    expect(shell.prompt).toBe(PS('C:\\users\\user\\Documents'));
  });

  it('fixes the last name of a relative path', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd DOCUMENTS');
    expect(shell.prompt).toBe(PS('C:\\Users\\User\\Documents'));
    await shell.run('cd ..');
    await shell.run('cd mixedcase');
    expect(shell.prompt).toBe(PS('C:\\Users\\User\\MixedCase'));
  });
});

describe('Windows PowerShell location rules', () => {
  it('reads cd - as a path of that name', async () => {
    const shell = await windowsPowerShell();
    const output = await shell.run('cd -');
    expect(output).toContain("Cannot find path 'C:\\Users\\User\\-' because it does not exist.");
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('reads cd + as a path of that name', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('cd +')).toContain("Cannot find path 'C:\\Users\\User\\+' because it does not exist.");
  });

  it('stays in place for Set-Location without a path', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('Set-Location')).toBe('');
    expect(await shell.run('cd')).toBe('');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('stays in place for an empty or null path', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd C:\\Windows');
    await shell.runAll('cd ""', 'cd $null');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });
});

describe('PowerShell 7 location rules', () => {
  it('goes home for Set-Location without a path', async () => {
    const shell = await corePowerShell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('cd')).toBe('');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('goes back with cd - and forward with cd +', async () => {
    const shell = await corePowerShell();
    await shell.runAll('cd C:\\Windows', 'cd C:\\Windows\\System32');
    await shell.run('cd -');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
    await shell.run('cd -');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
    await shell.run('cd +');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
    await shell.run('cd +');
    expect(shell.prompt).toBe(PS('C:\\Windows\\System32'));
  });

  it('goes back to the place it came from after going forward', async () => {
    const shell = await corePowerShell();
    await shell.runAll('cd C:\\Windows', 'cd C:\\Windows\\System32', 'cd -', 'cd +');
    expect(shell.prompt).toBe(PS('C:\\Windows\\System32'));
    await shell.run('cd -');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
    await shell.run('cd -');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('keeps the twenty most recent locations', async () => {
    const shell = await corePowerShell();
    for (let step = 1; step <= 22; step++) await shell.run(`mkdir C:\\step${step}`);
    for (let step = 1; step <= 22; step++) await shell.run(`cd C:\\step${step}`);
    for (let step = 1; step <= 20; step++) await shell.run('cd -');
    expect(shell.prompt).toBe(PS('C:\\step2'));
    expect(await shell.run('cd -')).toContain('There is no location history left to navigate backwards.');
    expect(shell.prompt).toBe(PS('C:\\step2'));
  });

  it('refuses cd - when there is no history', async () => {
    const shell = await corePowerShell();
    expect(await shell.run('cd -')).toContain('There is no location history left to navigate backwards.');
  });

  it('refuses cd + when there is nothing to go forward to', async () => {
    const shell = await corePowerShell();
    expect(await shell.run('cd +')).toContain('There is no location history left to navigate forwards.');
  });

  it('forgets the forward history after a new move', async () => {
    const shell = await corePowerShell();
    await shell.runAll('cd C:\\Windows', 'cd -', 'cd C:\\Users');
    expect(await shell.run('cd +')).toContain('There is no location history left to navigate forwards.');
  });
});

describe('PowerShell locations in other providers', () => {
  it('names the provider of the current location', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('(Get-Location).Provider.Name')).toBe('FileSystem');
    await shell.run('Set-Location HKLM:\\SOFTWARE');
    expect(await shell.run('(Get-Location).Provider.Name')).toBe('Registry');
  });

  it('shows the registry location in the prompt', async () => {
    const shell = await windowsPowerShell();
    await shell.run('Set-Location HKLM:\\SOFTWARE');
    expect(shell.prompt).toBe(PS('HKLM:\\SOFTWARE'));
  });

  it('moves up inside the provider with cd ..', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('Set-Location HKLM:\\SOFTWARE\\Microsoft', 'cd ..');
    expect(shell.prompt).toBe(PS('HKLM:\\SOFTWARE'));
    await shell.run('cd ..');
    expect(shell.prompt).toBe(PS('HKLM:\\'));
  });

  it('moves down inside the provider with a relative key', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('Set-Location HKLM:\\SOFTWARE', 'cd Microsoft');
    expect(shell.prompt).toBe(PS('HKLM:\\SOFTWARE\\Microsoft'));
  });

  it('returns to the file system with a drive path', async () => {
    const shell = await windowsPowerShell();
    await shell.run('Set-Location HKLM:\\SOFTWARE');
    expect(shell.prompt).toBe(PS('HKLM:\\SOFTWARE'));
    await shell.run('cd C:\\Windows');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('remembers the file system location while another provider is current', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('cd C:\\Windows', 'Set-Location Env:');
    expect(shell.prompt).toBe(PS('Env:\\'));
    await shell.run('cd C:');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('refuses a missing registry key and stays', async () => {
    const shell = await windowsPowerShell();
    await shell.run('Set-Location HKLM:\\SOFTWARE');
    expect(await shell.run('cd NoSuchKey')).toContain('Cannot find path');
    expect(shell.prompt).toBe(PS('HKLM:\\SOFTWARE'));
  });
});

describe('PowerShell location stack', () => {
  it('does nothing for Pop-Location on an empty stack', async () => {
    const shell = await windowsPowerShell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('Pop-Location')).toBe('');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('lists the newest entry first', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('Push-Location C:\\Windows', 'Push-Location C:\\Windows\\System32');
    const lines = (await shell.run('(Get-Location -Stack).Path')).split('\n');
    expect(lines).toEqual(['C:\\Windows', 'C:\\Users\\User']);
  });

  it('pushes the current location even when the move fails', async () => {
    const shell = await windowsPowerShell();
    const output = await shell.run('Push-Location C:\\nonexistent');
    expect(output).toContain("Cannot find path 'C:\\nonexistent' because it does not exist.");
    expect(await shell.run('(Get-Location -Stack).Path')).toBe('C:\\Users\\User');
  });

  it('keeps a named stack until its last location is popped', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('Push-Location C:\\Windows -StackName trail', 'Push-Location C:\\Windows\\System32 -StackName trail');
    await shell.run('Pop-Location -StackName trail');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
    await shell.run('Pop-Location -StackName trail');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
    expect(await shell.run('Pop-Location -StackName trail')).toContain("Cannot find location stack 'trail'. It does not exist or it is not a container.");
  });

  it('pops back across drives', async () => {
    const shell = await windowsPowerShell();
    await shell.runAll('Push-Location D:\\Data', 'Pop-Location');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('keeps its stack to itself', async () => {
    const shell = await windowsPowerShell();
    await shell.run('Push-Location C:\\Windows');
    await shell.run('exit');
    expect(await shell.run('pushd')).toBe('');
  });
});

describe('PowerShell location arguments', () => {
  it('returns the new location from Set-Location -PassThru', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('(Set-Location C:\\Windows -PassThru).Path')).toBe('C:\\Windows');
  });

  it('returns the new location from Push-Location -PassThru', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('(Push-Location C:\\Windows -PassThru).Path')).toBe('C:\\Windows');
  });

  it('takes the name as typed with -LiteralPath', async () => {
    const shell = await windowsPowerShell('mkdir "C:\\Users\\User\\br[1]"');
    await shell.run('Push-Location -LiteralPath "C:\\Users\\User\\br[1]"');
    expect(shell.prompt).toBe(PS('C:\\Users\\User\\br[1]'));
    await shell.run('Set-Location C:\\Windows');
    await shell.run('Set-Location -LiteralPath "C:\\Users\\User\\br[1]"');
    expect(shell.prompt).toBe(PS('C:\\Users\\User\\br[1]'));
  });

  it('reads brackets as a wildcard without -LiteralPath', async () => {
    const shell = await windowsPowerShell('mkdir "C:\\Users\\User\\br[1]"');
    expect(await shell.run('Push-Location "C:\\Users\\User\\br[1]"')).toContain('Cannot find path');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('reports the location of a drive made with New-PSDrive', async () => {
    const shell = await windowsPowerShell();
    await shell.run('New-PSDrive -Name Work -PSProvider FileSystem -Root C:\\Windows');
    expect(await shell.run('(Get-Location -PSDrive Work).Path')).toBe('Work:\\');
  });
});

describe('Resolve-Path and missing paths', () => {
  it('refuses a path that does not exist', async () => {
    const shell = await windowsPowerShell();
    expect(await shell.run('Resolve-Path .\\nothing')).toContain('Cannot find path');
  });

  it('resolves a path that exists', async () => {
    const shell = await windowsPowerShell();
    const output = await shell.run('Resolve-Path .\\Documents');
    expect(output).toContain('C:\\Users\\User\\Documents');
  });
});
