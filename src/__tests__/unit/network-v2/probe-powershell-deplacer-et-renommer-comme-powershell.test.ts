/**
 * Sonde : Move-Item et Rename-Item deplacent et renomment comme le
 * fournisseur de systeme de fichiers de PowerShell, et le renommage en
 * serie par bloc de script fonctionne.
 *
 * Mesure de depart (05730d8ae) :
 * `Move-Item d\*.txt dest` repondait « The system cannot find the file
 * specified. » (aucun joker), `-PassThru`, `-Force`, `-Filter`, `-Include`
 * et `-Exclude` etaient declares et jamais lus, une source absente et un
 * fichier deja la repondaient avec les mots de cmd, un dossier deplace sous
 * lui-meme n'etait pas refuse par le texte du fournisseur ; `Rename-Item
 * a.txt -NewName c.txt` repondait « The system cannot find the file
 * specified. » depuis un autre dossier, un nom qui est un chemin (`d\x`)
 * donnait « The system cannot find the path specified. », `-PassThru` ne
 * rendait rien et le renommage en serie `Get-ChildItem | Rename-Item
 * -NewName { $_.Name + '.bak' }` renommait le PREMIER element en
 * `$_.Name + '.bak'` (le texte du bloc) et laissait les autres ;
 * `Move-Item a.txt A.TXT` ne changeait pas la casse ; `Copy-Item a.txt
 * a.txt` repondait avec le mot de cmd « The file cannot be copied onto
 * itself. ».
 *
 * Autorites : sources de PowerShell 7.4.6 (tag v7.4.6) - FileSystemProvider.cs
 * (MoveItem : une destination qui est un dossier recoit la source, un
 * dossier ne va pas dans son propre sous-dossier -> TargetCannotBeSubdirectoryOfSource
 * / MoveItemArgumentError / InvalidArgument, un fichier existant sans Force
 * -> IOException MoveFileInfoItemIOError / WriteError, avec Force la
 * destination est supprimee puis le deplacement refait ; RenameItem : un
 * nouveau nom qui n'est pas son propre nom de fichier -> RenameError /
 * RenameItemArgumentError / InvalidArgument, IOException -> RenameItemIOError ;
 * CopyItem : meme element -> CopyError / WriteError), FileSystemProviderStrings.resx
 * (RenameError, TargetCannotBeSubdirectoryOfSource, CopyError), SessionStateStrings.resx
 * (PathNotFound) ; le texte d'une IOException est celui de .NET : Windows
 * PowerShell 5.1 (« Cannot create a file when that file already exists. »,
 * transcription publiee de `ren` sur un nom pris, avec et sans -Force :
 * til.secretgeek.net/powershell/rename_with_force), PowerShell 7
 * (IO_AlreadyExists_Name : « Cannot create '<chemin>' because a file or
 * directory with the same name already exists. »).
 *
 * Sur l'arbre sans ce lot (05730d8ae) : 21 des 28 cas tombent. Passent des
 * deux cotes, tous de non-regression (le meme laboratoire prouve que ce qui
 * marchait marche encore) : 'renames when the destination does not exist',
 * 'moves a whole folder with its content', 'overwrites the destination file
 * with -Force', 'renames a file from another folder and says nothing without
 * -PassThru', 'keeps renaming an environment variable', 'keeps overwriting
 * another existing file', 'says something instead of staying silent when
 * it is given no item'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function powershell(shell = 'powershell'): Promise<Console> {
  const console = await Console.open(new WindowsPC('windows-pc', 'WIN-MV', 0, 0));
  await console.run(shell);
  return console;
}

async function lab(shell = 'powershell'): Promise<Console> {
  const console = await powershell(shell);
  await console.runAll(
    'New-Item -Name src -ItemType Directory', 'New-Item -Name dest -ItemType Directory',
    'Set-Content src\\a.txt first', 'Set-Content src\\b.txt second', 'Set-Content src\\c.log third',
  );
  return console;
}

const names = async (shell: Console, folder: string): Promise<string[]> => {
  const out = await shell.run(`Get-ChildItem ${folder} -Name`);
  return out === '' ? [] : out.split('\n');
};

describe('Move-Item moves what the provider would move', () => {
  it('moves every file a wildcard matches into an existing folder', async () => {
    const shell = await lab();
    await shell.run('Move-Item src\\*.txt dest');
    expect(await names(shell, 'dest')).toEqual(['a.txt', 'b.txt']);
    expect(await names(shell, 'src')).toEqual(['c.log']);
  });

  it('moves a list of files', async () => {
    const shell = await lab();
    await shell.run('Move-Item src\\a.txt,src\\c.log dest');
    expect(await names(shell, 'dest')).toEqual(['a.txt', 'c.log']);
  });

  it('renames when the destination does not exist', async () => {
    const shell = await lab();
    await shell.run('Move-Item src\\a.txt src\\z.txt');
    expect(await names(shell, 'src')).toEqual(['b.txt', 'c.log', 'z.txt']);
  });

  it('moves a whole folder with its content', async () => {
    const shell = await lab();
    await shell.run('Move-Item src dest');
    expect(await shell.run('Test-Path dest\\src\\a.txt')).toBe('True');
    expect(await shell.run('Test-Path src')).toBe('False');
  });

  it('rewrites nothing on screen unless -PassThru is given', async () => {
    const shell = await lab();
    expect(await shell.run('Move-Item src\\a.txt dest')).toBe('');
    const out = await shell.run('Move-Item src\\b.txt dest -PassThru');
    expect(out).toMatch(/^\s+Directory: C:\\Users\\User\\dest\s*$/m);
    expect(out).toMatch(/^-a----\s.*\sb\.txt\s*$/m);
  });

  it('rewrites every moved item of a list with -PassThru', async () => {
    const shell = await lab();
    const out = await shell.run('Move-Item src\\a.txt,src\\b.txt dest -PassThru');
    expect(out.match(/\s[ab]\.txt\s*$/gm)).toHaveLength(2);
  });

  it('applies -Filter, -Include and -Exclude to the sources', async () => {
    const shell = await lab();
    await shell.run('Move-Item src\\* dest -Include *.txt -Exclude b*');
    expect(await names(shell, 'dest')).toEqual(['a.txt']);
    await shell.run('Move-Item src\\* dest -Filter *.log');
    expect(await names(shell, 'dest')).toEqual(['a.txt', 'c.log']);
  });

  it('reports a missing source by its full path', async () => {
    const shell = await lab();
    const out = await shell.run('Move-Item src\\nope.txt dest');
    expect(out).toContain("Move-Item : Cannot find path 'C:\\Users\\User\\src\\nope.txt' because it does not exist.");
    expect(out).toContain('ObjectNotFound: (C:\\Users\\User\\src\\nope.txt:String) [Move-Item], ItemNotFoundException');
    expect(out).toContain('PathNotFound,Microsoft.PowerShell.Commands.MoveItemCommand');
  });

  it('refuses a destination file that exists and leaves both files alone', async () => {
    const shell = await lab();
    await shell.run('Set-Content dest\\a.txt kept');
    const out = await shell.run('Move-Item src\\a.txt dest');
    expect(out).toContain('Move-Item : Cannot create a file when that file already exists.');
    expect(out).toContain('WriteError: (C:\\Users\\User\\src\\a.txt:String) [Move-Item], IOException');
    expect(out).toContain('MoveFileInfoItemIOError,Microsoft.PowerShell.Commands.MoveItemCommand');
    expect(await shell.run('Get-Content dest\\a.txt')).toBe('kept');
    expect(await shell.run('Get-Content src\\a.txt')).toBe('first');
  });

  it('overwrites the destination file with -Force', async () => {
    const shell = await lab();
    await shell.run('Set-Content dest\\a.txt kept');
    const out = await shell.run('Move-Item src\\a.txt dest -Force');
    expect(out).toBe('');
    expect(await shell.run('Get-Content dest\\a.txt')).toBe('first');
    expect(await shell.run('Test-Path src\\a.txt')).toBe('False');
  });

  it('refuses to move a folder under itself', async () => {
    const shell = await lab();
    await shell.run('New-Item -Path src -Name inner -ItemType Directory');
    const out = await shell.run('Move-Item src src\\inner');
    expect(out).toContain('Move-Item : Destination path cannot be a subdirectory of the source: C:\\Users\\User\\src.');
    expect(out).toContain('InvalidArgument: (C:\\Users\\User\\src:String) [Move-Item], ArgumentException');
    expect(out).toContain('MoveItemArgumentError,Microsoft.PowerShell.Commands.MoveItemCommand');
    expect(await shell.run('Test-Path src\\a.txt')).toBe('True');
  });

  it('words the refusal of a taken name as PowerShell 7 does', async () => {
    const shell = await lab('pwsh');
    await shell.run('Set-Content dest\\a.txt kept');
    const out = await shell.run('Move-Item src\\a.txt dest');
    expect(out).toContain("Move-Item: Cannot create 'C:\\Users\\User\\dest\\a.txt' because a file or directory with the same name already exists.");
  });

  it('renames the case of a name with Move-Item', async () => {
    const shell = await lab();
    await shell.run('Move-Item src\\a.txt src\\A.TXT');
    expect(await names(shell, 'src')).toEqual(['A.TXT', 'b.txt', 'c.log']);
  });
});

describe('Rename-Item renames what the provider would rename', () => {
  it('renames a file from another folder and says nothing without -PassThru', async () => {
    const shell = await lab();
    expect(await shell.run('Rename-Item src\\a.txt -NewName z.txt')).toBe('');
    expect(await names(shell, 'src')).toEqual(['b.txt', 'c.log', 'z.txt']);
  });

  it('rewrites the renamed item with -PassThru', async () => {
    const shell = await lab();
    const out = await shell.run('Rename-Item src\\a.txt z.txt -PassThru');
    expect(out).toMatch(/^\s+Directory: C:\\Users\\User\\src\s*$/m);
    expect(out).toMatch(/^-a----\s.*\sz\.txt\s*$/m);
  });

  it('renames every piped item with a script block that reads $_', async () => {
    const shell = await lab();
    await shell.run("Get-ChildItem src -File | Rename-Item -NewName { $_.Name + '.bak' }");
    expect(await names(shell, 'src')).toEqual(['a.txt.bak', 'b.txt.bak', 'c.log.bak']);
  });

  it('renames the pipeline back with -replace and rewrites every item with -PassThru', async () => {
    const shell = await lab();
    await shell.run("Get-ChildItem src -File | Rename-Item -NewName { $_.Name + '.bak' }");
    const out = await shell.run("Get-ChildItem src\\*.bak | Rename-Item -NewName { $_.Name -replace '\\.bak$','' } -PassThru");
    expect(out.match(/\.(txt|log)\s*$/gm)).toHaveLength(3);
    expect(await names(shell, 'src')).toEqual(['a.txt', 'b.txt', 'c.log']);
  });

  it('rewrites both items of a pair with -PassThru', async () => {
    const shell = await lab();
    const out = await shell.run("Get-ChildItem src\\*.txt | Rename-Item -NewName { $_.Name + '.bak' } -PassThru");
    expect(out.match(/\.bak\s*$/gm)).toHaveLength(2);
  });

  it('says something instead of staying silent when it is given no item', async () => {
    const shell = await lab();
    expect(await shell.run('Rename-Item -NewName z.txt')).not.toBe('');
    expect(await names(shell, 'src')).toEqual(['a.txt', 'b.txt', 'c.log']);
  });

  it('refuses a new name that is a path', async () => {
    const shell = await lab();
    const out = await shell.run('Rename-Item src\\a.txt src\\y.txt');
    expect(out).toContain('Rename-Item : Cannot rename the specified target, because it represents a path or device name.');
    expect(out).toContain('Parameter name: newName');
    expect(out).toContain('InvalidArgument: (C:\\Users\\User\\src\\a.txt:String) [Rename-Item], ArgumentException');
    expect(out).toContain('RenameItemArgumentError,Microsoft.PowerShell.Commands.RenameItemCommand');
    expect(await names(shell, 'src')).toEqual(['a.txt', 'b.txt', 'c.log']);
  });

  it('refuses a name that is already taken', async () => {
    const shell = await lab();
    const out = await shell.run('Rename-Item src\\a.txt b.txt');
    expect(out).toContain('Rename-Item : Cannot create a file when that file already exists.');
    expect(out).toContain('WriteError: (C:\\Users\\User\\src\\a.txt:String) [Rename-Item], IOException');
    expect(out).toContain('RenameItemIOError,Microsoft.PowerShell.Commands.RenameItemCommand');
    expect(await shell.run('Get-Content src\\b.txt')).toBe('second');
  });

  it('renames only the case of a name', async () => {
    const shell = await lab();
    await shell.run('Rename-Item src\\b.txt B.TXT');
    expect(await names(shell, 'src')).toEqual(['a.txt', 'B.TXT', 'c.log']);
  });

  it('reports a missing item by its full path', async () => {
    const shell = await lab();
    const out = await shell.run('Rename-Item src\\nope.txt z.txt');
    expect(out).toContain("Rename-Item : Cannot find path 'C:\\Users\\User\\src\\nope.txt' because it does not exist.");
    expect(out).toContain('PathNotFound,Microsoft.PowerShell.Commands.RenameItemCommand');
  });

  it('refuses an empty new name', async () => {
    const shell = await lab();
    expect(await shell.run("Rename-Item src\\a.txt ''")).toContain("Cannot bind argument to parameter 'NewName' because it is an empty string.");
  });

  it('keeps renaming an environment variable', async () => {
    const shell = await lab();
    await shell.runAll('Set-Item Env:MV_ONE 1', 'Rename-Item Env:MV_ONE MV_TWO');
    expect(await shell.run('$env:MV_TWO')).toBe('1');
    expect(await shell.run('$env:MV_ONE')).toBe('');
  });
});

describe('Copy-Item refuses to copy an item onto itself with the provider wording', () => {
  it('names the item and the provider identifier', async () => {
    const shell = await lab();
    const out = await shell.run('Copy-Item src\\a.txt src\\a.txt');
    expect(out).toContain('Copy-Item : Cannot overwrite the item C:\\Users\\User\\src\\a.txt with itself.');
    expect(out).toContain('WriteError: (C:\\Users\\User\\src\\a.txt:String) [Copy-Item], IOException');
    expect(out).toContain('CopyError,Microsoft.PowerShell.Commands.CopyItemCommand');
  });

  it('refuses it too when the destination is the folder the item is in', async () => {
    const shell = await lab();
    expect(await shell.run('Copy-Item src\\a.txt src')).toContain('Cannot overwrite the item C:\\Users\\User\\src\\a.txt with itself.');
  });

  it('keeps overwriting another existing file', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src\\a.txt src\\b.txt');
    expect(await shell.run('Get-Content src\\b.txt')).toBe('first');
  });
});
