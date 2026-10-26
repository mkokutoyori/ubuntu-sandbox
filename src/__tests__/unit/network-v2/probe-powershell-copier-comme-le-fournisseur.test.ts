/**
 * Sonde : Copy-Item range ce qu'il copie ou le fournisseur de systeme de
 * fichiers de PowerShell le range, et dit pourquoi il refuse avec les mots du
 * fournisseur.
 *
 * Mesure de depart (pile W14 + W16 + W18, avant ce lot) : `Copy-Item src dst`
 * avec `dst` existant fusionnait le CONTENU de `src` dans `dst` au lieu de creer
 * `dst\src` ; recopier un dossier deja copie ne disait rien (le fournisseur
 * refuse « An item with the specified name ... already exists. » sans -Force) ;
 * un dossier copie sur un fichier repondait « The system cannot find the path
 * specified. » ; deux fichiers copies sur un nom absent creaient un DOSSIER de
 * ce nom ; une copie vers un dossier parent absent repondait avec le mot de cmd,
 * sans categorie ni cible ; une destination en lecture seule ou cachee etait
 * ecrasee sans -Force ; `-Container:$false` etait lu et ignore ; `-PassThru` ne
 * rendait que la racine ; `Copy-Item src` sans destination refusait avec un
 * texte invente au lieu de copier dans l'emplacement courant ; un joker nu
 * (`Copy-Item *.txt dst`, `Get-Content a*.txt`) depuis un dossier qui n'est pas
 * la racine du lecteur cherchait `C:\a1.txt` ; un joker au milieu du chemin
 * (`*\a.txt`) ne trouvait rien ; un fichier cache etait copie par un joker sans
 * -Force.
 *
 * Autorites : sources de PowerShell 7.4.6 (tag v7.4.6) - SessionStateContainer.CopyItem
 * (la destination est resolue une fois par chemin ; source dossier + destination
 * dossier : sans -Recurse ni -Container c'est CopyContainerToContainerWithoutRecurseOrContainer,
 * avec -Recurse et sans -Container c'est CopyRecurseToSingleContainer, sinon le
 * fournisseur copie ; source dossier + destination fichier : CopyContainerItemToLeafError),
 * FileSystemProvider.CopyItem / CopyDirectoryInfoItem (un dossier destination
 * recoit la source comme enfant, une destination absente prend sa place et ses
 * parents sont crees, les fichiers puis les dossiers, CreateDirectory refuse un
 * dossier existant sans -Force avec DirectoryExist mais la copie continue) /
 * CopyFileInfoItem (File.CopyTo(destination, true) ; IOException ->
 * CopyFileInfoItemIOError, UnauthorizedAccessException ->
 * CopyFileInfoItemUnauthorizedAccessError, -Force retire ReadOnly et Hidden de
 * la destination ; Exclude et Filter ne portent que sur les fichiers),
 * FileSystemProvider.Dir (un joker n'enumere pas les elements caches sans
 * -Force), CopyItemCommand (Container vaut vrai par defaut, et la valeur de
 * Recurse quand -Recurse est donne sans -Container), SessionStateStrings.resx
 * et FileSystemProviderStrings.resx pour les textes ; documentation Microsoft de
 * CopyFile (win32/api/winbase/nf-winbase-copyfilew) : la copie echoue avec
 * ERROR_ACCESS_DENIED si la destination existe avec l'attribut HIDDEN ou READONLY.
 *
 * Sur l'arbre sans ce lot : 24 des 35 cas tombent. Passent des deux cotes,
 * tous de non-regression ou de temoin (le meme laboratoire prouve que ce qui
 * marchait marche encore) : 'takes the place of an absent destination and
 * keeps the parents it needs', 'creates an empty folder under an absent
 * destination without -Recurse', 'says nothing on success and creates nothing
 * with -WhatIf but one line', 'refuses to overwrite a file with itself,
 * whether it is named or reached through its folder', 'refuses to overwrite a
 * folder with itself', 'copies a hidden item named in full', 'leaves an
 * excluded file out of a recursive copy and keeps its folder', 'copies one
 * file to a new name', 'copies one file into an existing folder', 'overwrites
 * an ordinary destination file' et 'refuses a source that does not exist with
 * its absolute path'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lab(shell = 'powershell'): Promise<Console> {
  const console = await Console.open(new WindowsPC('windows-pc', 'WIN-CP', 0, 0));
  await console.run(shell);
  await console.runAll(
    'New-Item -Path C:\\lab -ItemType Directory', 'Set-Location C:\\lab',
    'New-Item -Name src -ItemType Directory', 'New-Item -Name src\\sub -ItemType Directory',
    'Set-Content src\\a.txt A', 'Set-Content src\\sub\\b.txt B', 'New-Item -Name dst -ItemType Directory',
  );
  return console;
}

const TREE = "(Get-ChildItem -Recurse -Force | ForEach-Object { $_.FullName.Substring(7) } | Sort-Object) -join '|'";

const tree = async (shell: Console): Promise<string[]> => {
  const out = await shell.run(TREE);
  return out === '' ? [] : out.split('|');
};

const errorBlock = (cmdlet: string, message: string, category: string, target: string, exception: string, id: string): string => [
  `${cmdlet} : ${message}`,
  `    + CategoryInfo          : ${category}: (${target}) [${cmdlet}], ${exception}`,
  `    + FullyQualifiedErrorId : ${id},Microsoft.PowerShell.Commands.${cmdlet.replace('-', '')}Command`,
].join('\n');

describe('a folder lands where the provider puts it', () => {
  it('becomes a child of an existing destination folder, empty without -Recurse', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src dst');
    expect(await tree(shell)).toEqual(['dst', 'dst\\src', 'src', 'src\\a.txt', 'src\\sub', 'src\\sub\\b.txt']);
  });

  it('copies the whole tree below the child folder with -Recurse', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src dst -Recurse');
    expect(await tree(shell)).toEqual([
      'dst', 'dst\\src', 'dst\\src\\a.txt', 'dst\\src\\sub', 'dst\\src\\sub\\b.txt', 'src', 'src\\a.txt', 'src\\sub', 'src\\sub\\b.txt',
    ]);
  });

  it('takes the place of an absent destination and keeps the parents it needs', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src deep\\er\\copy -Recurse');
    expect(await shell.run('Test-Path deep\\er\\copy\\sub\\b.txt')).toBe('True');
    expect(await shell.run('Test-Path deep\\er\\copy\\src')).toBe('False');
  });

  it('creates an empty folder under an absent destination without -Recurse', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src nd');
    expect(await shell.run('Test-Path nd')).toBe('True');
    expect(await shell.run('(Get-ChildItem nd | Measure-Object).Count')).toBe('0');
  });

  it('lists every copied item with -PassThru, the folder before its files', async () => {
    const shell = await lab();
    const out = await shell.run('Copy-Item src pt -Recurse -PassThru | ForEach-Object { $_.FullName }');
    expect(out.split('\n')).toEqual(['C:\\lab\\pt', 'C:\\lab\\pt\\a.txt', 'C:\\lab\\pt\\sub', 'C:\\lab\\pt\\sub\\b.txt']);
  });

  it('says nothing on success and creates nothing with -WhatIf but one line', async () => {
    const shell = await lab();
    expect(await shell.run('Copy-Item src nd -Recurse')).toBe('');
    const out = await shell.run('Copy-Item src wi -Recurse -WhatIf');
    expect(out).toBe('What if: Performing the operation "Copy Directory" on target "Item: C:\\lab\\src Destination: C:\\lab\\wi".');
    expect(await shell.run('Test-Path wi')).toBe('False');
  });
});

describe('a folder copied over an existing folder is refused by the provider, and the copy goes on', () => {
  it('refuses the existing child folder without -Force and still copies the files', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src dst -Recurse');
    await shell.run('Set-Content src\\a.txt A2');
    const out = await shell.run('Copy-Item src dst -Recurse');
    expect(out).toContain(errorBlock('Copy-Item', 'An item with the specified name C:\\lab\\dst\\src already exists.', 'ResourceExists', 'C:\\lab\\dst\\src:String', 'IOException', 'DirectoryExist'));
    expect(out).toContain('An item with the specified name C:\\lab\\dst\\src\\sub already exists.');
    expect(await shell.run('Get-Content dst\\src\\a.txt')).toBe('A2');
  });

  it('merges silently with -Force', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src dst -Recurse');
    await shell.run('Set-Content src\\a.txt A2');
    expect(await shell.run('Copy-Item src dst -Recurse -Force')).toBe('');
    expect(await shell.run('Get-Content dst\\src\\a.txt')).toBe('A2');
  });

  it('lists the existing folders it merges into with -Force and -PassThru', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src dst -Recurse');
    const out = await shell.run('Copy-Item src dst -Recurse -Force -PassThru | ForEach-Object { $_.FullName }');
    expect(out.split('\n')).toEqual(['C:\\lab\\dst\\src', 'C:\\lab\\dst\\src\\a.txt', 'C:\\lab\\dst\\src\\sub', 'C:\\lab\\dst\\src\\sub\\b.txt']);
  });

  it('refuses a folder copied onto an existing file', async () => {
    const shell = await lab();
    await shell.run('Set-Content leaf.txt L');
    const out = await shell.run('Copy-Item src leaf.txt -Recurse');
    expect(out).toBe(errorBlock('Copy-Item', 'Container cannot be copied onto existing leaf item.\nParameter name: path', 'InvalidArgument', 'C:\\lab\\src:String', 'ArgumentException', 'CopyContainerItemToLeafError'));
    expect(await shell.run('Get-Content leaf.txt')).toBe('L');
  });

  it('words the argument name the PowerShell 7 way', async () => {
    const shell = await lab('pwsh');
    await shell.run('Set-Content leaf.txt L');
    expect(await shell.run('Copy-Item src leaf.txt -Recurse')).toBe("Copy-Item: Container cannot be copied onto existing leaf item. (Parameter 'path')");
  });

  it('refuses a folder copied to another folder when -Container is off and -Recurse is not given', async () => {
    const shell = await lab();
    const out = await shell.run('Copy-Item src dst -Container:$false');
    expect(out).toContain('Container cannot be copied to another container. The -Recurse or -Container parameter is not specified.');
    expect(out).toContain('CopyContainerToContainerWithoutRecurseOrContainer,Microsoft.PowerShell.Commands.CopyItemCommand');
    expect(await tree(shell)).not.toContain('dst\\src');
  });

  it('flattens every leaf into the single destination with -Recurse and -Container:$false', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src dst -Recurse -Container:$false');
    expect(await tree(shell)).toEqual(['dst', 'dst\\a.txt', 'dst\\b.txt', 'dst\\sub', 'src', 'src\\a.txt', 'src\\sub', 'src\\sub\\b.txt']);
  });

  it('copies the first of several folders matched by a wildcard onto an absent destination and refuses the next', async () => {
    const shell = await lab();
    await shell.run('New-Item -Name src2 -ItemType Directory');
    const out = await shell.run('Copy-Item src* wild -Recurse');
    expect(out).toContain('Container cannot be copied onto existing leaf item.');
    expect(await shell.run('Test-Path wild\\sub\\b.txt')).toBe('True');
  });
});

describe('a file is copied the way the provider copies it', () => {
  it('overwrites one file when several are copied onto an absent name', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src\\a.txt,src\\sub\\b.txt newname');
    expect(await shell.run('(Get-Item newname).PSIsContainer')).toBe('False');
    expect(await shell.run('Get-Content newname')).toBe('B');
  });

  it('refuses a missing parent folder with the .NET words, the source as target', async () => {
    const shell = await lab();
    const out = await shell.run('Copy-Item src\\a.txt nodir\\x.txt');
    expect(out).toBe(errorBlock('Copy-Item', "Could not find a part of the path 'C:\\lab\\nodir\\x.txt'.", 'WriteError', 'C:\\lab\\src\\a.txt:FileInfo', 'DirectoryNotFoundException', 'CopyFileInfoItemIOError'));
  });

  it('refuses to overwrite a file with itself, whether it is named or reached through its folder', async () => {
    const shell = await lab();
    const same = errorBlock('Copy-Item', 'Cannot overwrite the item C:\\lab\\src\\a.txt with itself.', 'WriteError', 'C:\\lab\\src\\a.txt:String', 'IOException', 'CopyError');
    expect(await shell.run('Copy-Item src\\a.txt src\\a.txt')).toBe(same);
    expect(await shell.run('Copy-Item src\\a.txt src')).toBe(same);
  });

  it('refuses to overwrite a folder with itself', async () => {
    const shell = await lab();
    const out = await shell.run('Copy-Item src src -Recurse');
    expect(out).toBe(errorBlock('Copy-Item', 'Cannot overwrite the item C:\\lab\\src with itself.', 'WriteError', 'C:\\lab\\src:String', 'IOException', 'CopyError'));
  });

  it('copies into the current location when no destination is given', async () => {
    const shell = await lab();
    expect(await shell.run('Copy-Item src\\a.txt')).toBe('');
    expect(await shell.run('Get-Content a.txt')).toBe('A');
    expect(await shell.run('Copy-Item a.txt')).toContain('Cannot overwrite the item C:\\lab\\a.txt with itself.');
  });

  it('refuses a read-only destination without -Force and overwrites it with -Force', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content ro.txt R', 'attrib +r ro.txt');
    const out = await shell.run('Copy-Item src\\a.txt ro.txt');
    expect(out).toBe(errorBlock('Copy-Item', "Access to the path 'C:\\lab\\ro.txt' is denied.", 'PermissionDenied', 'C:\\lab\\src\\a.txt:FileInfo', 'UnauthorizedAccessException', 'CopyFileInfoItemUnauthorizedAccessError'));
    expect(await shell.run('Get-Content ro.txt')).toBe('R');
    expect(await shell.run('Copy-Item src\\a.txt ro.txt -Force')).toBe('');
    expect(await shell.run('Get-Content ro.txt')).toBe('A');
    expect(await shell.run('(Get-Item ro.txt).IsReadOnly')).toBe('False');
  });

  it('refuses a hidden destination without -Force', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content hid.txt H', 'attrib +h hid.txt');
    expect(await shell.run('Copy-Item src\\a.txt hid.txt')).toContain("Access to the path 'C:\\lab\\hid.txt' is denied.");
    expect(await shell.run('Copy-Item src\\a.txt hid.txt -Force')).toBe('');
    expect(await shell.run('Get-Content hid.txt -Force')).toBe('A');
  });

  it('is refused the same way by cmd copy, which shares the store', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content hid.txt H', 'attrib +h hid.txt');
    const out = await shell.run('cmd /c copy /y src\\a.txt hid.txt');
    expect(out).toContain('Access is denied.');
    expect(out).toContain('0 file(s) copied.');
  });

  it('refuses a file copied onto a folder of the same name inside the destination', async () => {
    const shell = await lab();
    await shell.run('New-Item -Name dst\\a.txt -ItemType Directory');
    const out = await shell.run('Copy-Item src\\a.txt dst');
    expect(out).toContain("Access to the path 'C:\\lab\\dst\\a.txt' is denied.");
  });
});

describe('wildcards name what the provider enumerates', () => {
  it('reads a bare wildcard against the current folder, not the root of the drive', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content a1.txt one', 'Set-Content a2.txt two');
    expect(await shell.run('Copy-Item a*.txt dst')).toBe('');
    expect(await shell.run('Get-Content dst\\a1.txt, dst\\a2.txt')).toBe('one\ntwo');
  });

  it('reads the same bare wildcard in Get-Content', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content a1.txt one', 'Set-Content a2.txt two');
    expect(await shell.run('Get-Content a*.txt')).toBe('one\ntwo');
  });

  it('reads a wildcard in the middle of the path', async () => {
    const shell = await lab();
    await shell.run('Copy-Item *\\a.txt dst');
    expect(await shell.run('Get-Content dst\\a.txt')).toBe('A');
  });

  it('leaves hidden items out of a wildcard unless -Force is given', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content v.txt visible', 'Set-Content h.txt hidden', 'attrib +h h.txt');
    await shell.run('Copy-Item *.txt dst');
    expect(await tree(shell)).toContain('dst\\v.txt');
    expect(await tree(shell)).not.toContain('dst\\h.txt');
    await shell.run('Copy-Item *.txt dst -Force');
    expect(await tree(shell)).toContain('dst\\h.txt');
  });

  it('applies the same rule to a wildcard given to Remove-Item', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content v.txt visible', 'Set-Content h.txt hidden', 'attrib +h h.txt');
    expect(await shell.run('Remove-Item *.txt')).toBe('');
    expect(await shell.run('Test-Path v.txt')).toBe('False');
    expect(await shell.run('Test-Path h.txt')).toBe('True');
    expect(await shell.run('Remove-Item *.txt -Force')).toBe('');
    expect(await shell.run('Test-Path h.txt')).toBe('False');
  });

  it('copies a hidden item named in full', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content h.txt hidden', 'attrib +h h.txt');
    await shell.run('Copy-Item h.txt dst');
    expect(await tree(shell)).toContain('dst\\h.txt');
  });
});

describe('Exclude and Filter narrow the files, not the folders', () => {
  it('leaves an excluded file out of a recursive copy and keeps its folder', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src nd -Recurse -Exclude b.txt');
    expect(await tree(shell)).toEqual(expect.arrayContaining(['nd\\a.txt', 'nd\\sub']));
    expect(await tree(shell)).not.toContain('nd\\sub\\b.txt');
  });

  it('keeps only the files that match -Filter and still copies every folder', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src nd -Recurse -Filter b*');
    expect(await tree(shell)).toEqual(expect.arrayContaining(['nd\\sub', 'nd\\sub\\b.txt']));
    expect(await tree(shell)).not.toContain('nd\\a.txt');
  });
});

describe('the other cases of the lab do not move', () => {
  it('copies one file to a new name', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src\\a.txt copy.txt');
    expect(await shell.run('Get-Content copy.txt')).toBe('A');
  });

  it('copies one file into an existing folder', async () => {
    const shell = await lab();
    await shell.run('Copy-Item src\\a.txt dst');
    expect(await shell.run('Get-Content dst\\a.txt')).toBe('A');
  });

  it('overwrites an ordinary destination file', async () => {
    const shell = await lab();
    await shell.runAll('Set-Content old.txt old');
    await shell.run('Copy-Item src\\a.txt old.txt');
    expect(await shell.run('Get-Content old.txt')).toBe('A');
  });

  it('refuses a source that does not exist with its absolute path', async () => {
    const shell = await lab();
    const out = await shell.run('Copy-Item nothing dst');
    expect(out).toContain("Cannot find path 'C:\\lab\\nothing' because it does not exist.");
  });
});
