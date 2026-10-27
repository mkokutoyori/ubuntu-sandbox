/**
 * Les listes de PowerShell nomment le dossier liste : `Directory:` porte le chemin resolu, un commutateur place avant
 * le chemin ne le remplace pas, un joker garde le tableau, `New-Item` affiche l'entree avec son parent.
 *
 * Mesure de depart (6c86125ec), un WindowsPC et un terminal PowerShell lance depuis cmd. `ls ..` ecrivait « Directory:
 * .. » et `ls .\Documents` « Directory: .\Documents » (le chemin tape, pas le dossier resolu), `ls ~` n'avait pas
 * d'en-tete, `ls -Force C:\` et `ls -Name C:\Users\User\Documents` prenaient le commutateur pour le chemin et listaient
 * le dossier courant, `ls C:\Windows\*.exe` et `New-Item` n'imprimaient aucun `Directory:` faute de parent, et
 * `FullName` sous la racine d'un volume portait deux separateurs (`C:\\Windows`). `(Get-ChildItem fichier).BaseName`
 * ne rendait rien, et `Get-ChildItem fichier | Move-Item -Destination dossier` repondait « Access is denied. » en
 * visant la racine du lecteur au lieu du fichier.
 *
 * Autorites : le fournisseur FileSystem de PowerShell 7.4.6 -- l'en-tete d'un listing est le `PSParentPath` de
 * l'element, resolu avant d'etre affiche ; le formateur de tableau de `FileInfo`/`DirectoryInfo` (Mode, LastWriteTime,
 * Length, Name) ; la page Microsoft Learn de `Get-ChildItem` pour `-Force`, `-Name` et `-Recurse`, et celle de
 * `Move-Item` pour `-Path`, `-LiteralPath` et `-Destination`.
 *
 * Sur les 22 cas, 12 tombent avant la correction. Les 10 qui passent dans les deux etats sont de deux sortes. Les
 * TEMOINS du laboratoire : « prints the directory of the current location » (l'en-tete d'un `ls` nu, sans lequel un
 * en-tete absent ailleurs pourrait venir de la lecture du test et non de la machine) et « prints a table for a file
 * path » (`Get-Item` d'un fichier garde son tableau). Les GARDE-FOUS, que la base tenait deja et qu'une correction
 * pouvait perdre : les quatre cas de « items directly under a drive root » (sortir le parent d'un chemin sans
 * separateur rendait `C:` au lieu de `C:\` et cassait `ls C:\*.txt`, `Get-Item C:\Windows` et `Select-String -Path
 * C:\nums.*` ; le balayage n'a signale que ce dernier, une reconnaissance a trouve les autres) et les quatre formes
 * d'appel de `Move-Item` (source en position, `-Path`, `-LiteralPath`, source et destination en position), dont la
 * lecture des arguments a ete refaite avec celle du pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function powershell(): Promise<Console> {
  const shell = await Console.open(new WindowsPC('windows-pc', 'WIN-LS', 0, 0));
  await shell.run('echo content> C:\\Users\\User\\Documents\\inside.txt');
  await shell.run('powershell');
  return shell;
}

const header = (output: string): string | undefined =>
  output.split('\n').find(line => line.trim().startsWith('Directory:'))?.trim();

describe('Get-ChildItem names the directory it lists', () => {
  it('prints the resolved directory for a relative path', async () => {
    const shell = await powershell();
    expect(header(await shell.run('ls ..'))).toBe('Directory: C:\\Users');
  });

  it('prints the resolved directory for ~', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows');
    expect(header(await shell.run('ls ~'))).toBe('Directory: C:\\Users\\User');
  });

  it('prints the directory of the current location', async () => {
    const shell = await powershell();
    expect(header(await shell.run('ls'))).toBe('Directory: C:\\Users\\User');
  });

  it('prints a subdirectory by its absolute path', async () => {
    const shell = await powershell();
    const output = await shell.run('ls .\\Documents');
    expect(header(output)).toBe('Directory: C:\\Users\\User\\Documents');
    expect(output).toContain('inside.txt');
  });

  it('gives FullName with a single separator under a volume root', async () => {
    const shell = await powershell();
    const names = (await shell.run('(ls C:\\).FullName')).split('\n');
    expect(names).toContain('C:\\Windows');
    expect(names.some(name => name.includes('\\\\'))).toBe(false);
  });
});

describe('Get-ChildItem switches leave the path alone', () => {
  it('lists the path after -Force', async () => {
    const shell = await powershell();
    const output = await shell.run('ls -Force C:\\');
    expect(header(output)).toBe('Directory: C:\\');
    expect(output).toContain('Windows');
  });

  it('lists the path after -Recurse and -Name', async () => {
    const shell = await powershell();
    expect(await shell.run('ls -Name C:\\Users\\User\\Documents')).toBe('inside.txt');
    expect(await shell.run('ls -Recurse C:\\Users\\User\\Documents')).toContain('inside.txt');
  });
});

describe('listings of single files and wildcards keep the table', () => {
  it('prints a table for a wildcard', async () => {
    const shell = await powershell();
    const output = await shell.run('ls C:\\Windows\\*.exe');
    expect(header(output)).toBe('Directory: C:\\Windows');
    expect(output).toContain('Mode');
    expect(output).toContain('notepad.exe');
    expect(output).not.toContain('PSIsContainer');
  });

  it('prints a table for a file path', async () => {
    const shell = await powershell();
    const output = await shell.run('Get-Item C:\\Windows\\notepad.exe');
    expect(header(output)).toBe('Directory: C:\\Windows');
    expect(output).toContain('-a----');
    expect(output).toContain('201216');
  });
});

describe('New-Item reports the item it made', () => {
  it('prints the directory entry with its parent', async () => {
    const shell = await powershell();
    const output = await shell.run('New-Item -ItemType Directory made');
    expect(header(output)).toBe('Directory: C:\\Users\\User');
    expect(output).toContain('d-----');
    expect(output).toContain('made');
    expect(await shell.run('Test-Path C:\\Users\\User\\made')).toBe('True');
  });

  it('prints the file entry for a file under another directory', async () => {
    const shell = await powershell();
    const output = await shell.run('New-Item C:\\Windows\\fresh.txt -ItemType File');
    expect(header(output)).toBe('Directory: C:\\Windows');
    expect(output).toContain('-a----');
    expect(output).toContain('fresh.txt');
  });
});

describe('items directly under a drive root', () => {
  it('lists the files a wildcard names', async () => {
    const shell = await powershell();
    expect(await shell.run('ls C:\\*.txt -Name')).toContain('nums.txt');
  });

  it('lists the content of the folder a wildcard names', async () => {
    const shell = await powershell();
    expect(await shell.run('ls C:\\Wind* -Name')).toContain('System32');
  });

  it('dates the item Get-Item returns for a top-level folder', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows).LastWriteTime')).not.toBe('');
  });

  it('reads the files a wildcard names with Select-String', async () => {
    const shell = await powershell();
    expect(await shell.run("Select-String -Pattern '^1' -Path C:\\nums.*")).toContain('nums.txt');
  });
});

describe('listed items carry the names of their files', () => {
  it('gives the base name of a file without its last extension', async () => {
    const shell = await powershell();
    await shell.run('Set-Content C:\\Users\\User\\a.b.txt hi');
    expect(await shell.run('(Get-ChildItem C:\\Users\\User\\a.b.txt).BaseName')).toBe('a.b');
    expect(await shell.run('(Get-ChildItem C:\\Users\\User\\a.b.txt).Extension')).toBe('.txt');
  });

  it('gives a file without extension its whole name as base name', async () => {
    const shell = await powershell();
    await shell.run('Set-Content C:\\Users\\User\\noext hi');
    expect(await shell.run('(Get-ChildItem C:\\Users\\User\\noext).BaseName')).toBe('noext');
  });
});

describe('Move-Item reads its source however it is given', () => {
  async function moved(command: string): Promise<string> {
    const shell = await powershell();
    await shell.run('mkdir C:\\Users\\User\\box');
    await shell.run('Set-Location C:\\Users\\User');
    await shell.run('Set-Content item.txt hi');
    await shell.run(command);
    return shell.run('Get-ChildItem C:\\Users\\User\\box -Name');
  }

  it('moves a positional source to a named destination', async () => {
    expect(await moved('Move-Item item.txt -Destination box')).toBe('item.txt');
  });

  it('moves a source given by -LiteralPath', async () => {
    expect(await moved('Move-Item -LiteralPath item.txt -Destination box')).toBe('item.txt');
  });

  it('moves a source given by -Path', async () => {
    expect(await moved('Move-Item -Path item.txt -Destination box')).toBe('item.txt');
  });

  it('moves a source and a destination given by position', async () => {
    expect(await moved('Move-Item item.txt box')).toBe('item.txt');
  });

  it('moves the item that arrives from the pipeline', async () => {
    expect(await moved('Get-ChildItem item.txt | Move-Item -Destination box')).toBe('item.txt');
  });
});
