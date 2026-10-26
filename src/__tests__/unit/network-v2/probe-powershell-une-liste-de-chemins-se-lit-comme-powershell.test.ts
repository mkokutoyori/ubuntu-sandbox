/**
 * Sonde : les commandes de chemin PowerShell lisent une LISTE de chemins,
 * un listage qui couvre plusieurs dossiers nomme chacun d'eux, et `mkdir`
 * est `New-Item -ItemType Directory`.
 *
 * Mesure de depart (80f7f29e9 + New-Item) : `Get-ChildItem da,db`,
 * `Get-Item a,b`, `Set-Content a,b -Value x`, `Add-Content`, `Clear-Content`,
 * `Copy-Item a,b -Destination d`, `Get-FileHash a,b`, `Get-Acl a,b`
 * repondaient « Cannot find path 'da db' » ou « Could not find a part of the
 * path 'C:\\...\\a.txt b' » : le tableau etait joint par une espace avant
 * d'etre lu comme un chemin ; seul Get-Content, Test-Path, Remove-Item et
 * Resolve-Path lisaient une liste. Un listage recursif ou une liste de
 * dossiers imprimait UN tableau sans aucun en-tete `Directory:` ; `mkdir d`
 * imprimait un tableau `Name FullName ItemType` avec le chemin tel que tape,
 * ne refusait pas un dossier existant et ne lisait pas -Name.
 *
 * Autorites : sources de PowerShell 7.4.6 (tag v7.4.6) - les commandes
 * declarent `Path` comme string[] (GetChildItemCommand, GetItemCommand,
 * CopyItemCommand, SetContentCommand... : Navigation.cs, Content.cs,
 * ItemProperty.cs), chaque chemin est traite dans l'ordre ; le fournisseur
 * de systeme de fichiers groupe les elements par PSParentPath et le format
 * FileSystem imprime un en-tete `Directory:` par groupe ; `mkdir` est une
 * fonction qui enveloppe New-Item -Type Directory (le texte d'erreur porte
 * le nom tape, la categorie dit [New-Item]) ; une erreur de chemin
 * introuvable cite le chemin absolu (SessionStateStrings.resx PathNotFound).
 *
 * Sur l'arbre sans ce lot (05730d8ae) : 23 des 30 cas tombent. Passent des
 * deux cotes, tous de non-regression ou de garde : 'refuses a copy that
 * lacks its source or its destination' et 'asks for a path when none is
 * given' (une commande sans chemin parle au lieu de se taire ; le texte
 * n'est pas epingle, PowerShell invite le parametre obligatoire), 'keeps
 * reading a single path as before', 'keeps the single header of a listing in
 * one folder', 'names the drive root as the header of the items directly
 * under it', 'groups only objects that carry Mode, LastWriteTime and Name'
 * (les deux bornes du regroupement par dossier), 'creates the missing
 * parents' (mkdir).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

class Console {
  private constructor(private readonly session: WindowsTerminalSession) {}

  static async open(machine: WindowsPC): Promise<Console> {
    const session = new WindowsTerminalSession('a', machine);
    await session.init();
    return new Console(session);
  }

  async run(line: string): Promise<string> {
    const before = this.session.lines.length;
    this.session.setInput(line);
    this.session.setInputBuf(line);
    this.session.handleKey(key('Enter'));
    await settle();
    return this.session.lines.slice(before + 1).map(entry => entry.text).join('\n');
  }

  async runAll(...lines: string[]): Promise<void> {
    for (const line of lines) await this.run(line);
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function powershell(): Promise<Console> {
  const shell = await Console.open(new WindowsPC('windows-pc', 'WIN-LS', 0, 0));
  await shell.run('powershell');
  return shell;
}

async function twoFolders(): Promise<Console> {
  const shell = await powershell();
  await shell.runAll(
    'New-Item -Name da -ItemType Directory', 'New-Item -Name db -ItemType Directory',
    'Set-Content da\\a.txt first', 'Set-Content db\\b.txt second',
  );
  return shell;
}

const rowsNamed = (out: string, name: string): number => out.split('\n').filter(line => line.trimEnd().endsWith(name)).length;
const headers = (out: string): string[] => [...out.matchAll(/^\s+Directory: (.+?)\s*$/gm)].map(match => match[1]);

describe('the commands that take -Path read a list of paths', () => {
  it('lists every folder of a list', async () => {
    const shell = await twoFolders();
    const out = await shell.run('Get-ChildItem da,db');
    expect(rowsNamed(out, 'a.txt')).toBe(1);
    expect(rowsNamed(out, 'b.txt')).toBe(1);
  });

  it('lists a list of wildcard paths', async () => {
    const shell = await twoFolders();
    const out = await shell.run('Get-ChildItem da\\*,db\\*');
    expect(rowsNamed(out, 'a.txt')).toBe(1);
    expect(rowsNamed(out, 'b.txt')).toBe(1);
  });

  it('reads every path piped to Get-ChildItem', async () => {
    const shell = await twoFolders();
    const out = await shell.run("'da','db' | Get-ChildItem -Name");
    expect(out.split('\n')).toEqual(['a.txt', 'b.txt']);
  });

  it('reads every item of a list with Get-Item', async () => {
    const shell = await twoFolders();
    const out = await shell.run('Get-Item da\\a.txt,db\\b.txt');
    expect(rowsNamed(out, 'a.txt')).toBe(1);
    expect(rowsNamed(out, 'b.txt')).toBe(1);
  });

  it('applies -Include, -Exclude and -Filter to the items Get-Item reads', async () => {
    const shell = await twoFolders();
    await shell.run('Set-Content da\\c.log third');
    expect(await shell.run('(Get-Item da\\* -Include *.txt).Name')).toBe('a.txt');
    expect(await shell.run('(Get-Item da\\* -Exclude *.txt).Name')).toBe('c.log');
    expect(await shell.run('(Get-Item da\\* -Filter *.log).Name')).toBe('c.log');
    expect(await shell.run('Get-Item da\\a.txt -Include *.log')).toBe('');
  });

  it('reports a missing path of a list by its full path and goes on with the others', async () => {
    const shell = await twoFolders();
    const out = await shell.run('Get-Item da\\a.txt,da\\nope.txt,db\\b.txt');
    expect(out).toContain("Get-Item : Cannot find path 'C:\\Users\\User\\da\\nope.txt' because it does not exist.");
    expect(rowsNamed(out, 'a.txt')).toBe(1);
    expect(rowsNamed(out, 'b.txt')).toBe(1);
  });

  it('writes every file of a list with Set-Content', async () => {
    const shell = await twoFolders();
    await shell.run('Set-Content da\\a.txt,db\\b.txt -Value both');
    expect(await shell.run('Get-Content da\\a.txt')).toBe('both');
    expect(await shell.run('Get-Content db\\b.txt')).toBe('both');
  });

  it('appends to every file of a list with Add-Content', async () => {
    const shell = await twoFolders();
    await shell.run('Add-Content da\\a.txt,db\\b.txt -Value more');
    expect(await shell.run('Get-Content da\\a.txt')).toBe('first\nmore');
    expect(await shell.run('Get-Content db\\b.txt')).toBe('second\nmore');
  });

  it('empties every file of a list with Clear-Content', async () => {
    const shell = await twoFolders();
    await shell.run('Clear-Content da\\a.txt,db\\b.txt');
    expect(await shell.run('(Get-Item da\\a.txt).Length')).toBe('0');
    expect(await shell.run('(Get-Item db\\b.txt).Length')).toBe('0');
  });

  it('copies every file of a list', async () => {
    const shell = await twoFolders();
    await shell.runAll('New-Item -Name dest -ItemType Directory', 'Copy-Item da\\a.txt,db\\b.txt -Destination dest');
    expect((await shell.run('Get-ChildItem dest -Name')).split('\n')).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses a copy that lacks its source or its destination', async () => {
    const shell = await twoFolders();
    expect(await shell.run('Copy-Item -Destination db')).not.toBe('');
    expect(await shell.run("Copy-Item '' db")).not.toBe('');
    expect(await shell.run('Copy-Item da\\a.txt')).not.toBe('');
  });

  it('refuses a copy whose sources are not all in the provider of the destination', async () => {
    const shell = await twoFolders();
    await shell.run('Set-Item Env:LS_ONE 1');
    expect(await shell.run('Copy-Item Env:LS_ONE,da\\a.txt Env:LS_TWO')).toContain('Source and destination path did not resolve to the same provider.');
    expect(await shell.run('Copy-Item Env:LS_ONE,da\\a.txt db')).toContain('Source and destination path did not resolve to the same provider.');
    await shell.run('Copy-Item Env:LS_ONE Env:LS_THREE');
    expect(await shell.run('$env:LS_THREE')).toBe('1');
  });

  it('returns the copy made for every source of a list with -PassThru', async () => {
    const shell = await powershell();
    await shell.runAll('Set-Item Env:LS_A 1', 'Set-Item Env:LS_B 2');
    expect(await shell.run('@(Copy-Item Env:LS_A,Env:LS_B Env:LS_C -PassThru).Count')).toBe('2');
    expect(await shell.run('$env:LS_C')).toBe('2');
  });

  it('reports a missing source of a copy by its full path', async () => {
    const shell = await twoFolders();
    const out = await shell.run('Copy-Item da\\nope.txt -Destination db');
    expect(out).toContain("Copy-Item : Cannot find path 'C:\\Users\\User\\da\\nope.txt' because it does not exist.");
  });

  it('hashes every file of a list', async () => {
    const shell = await twoFolders();
    expect((await shell.run('Get-FileHash da\\a.txt,db\\b.txt | Select-Object -ExpandProperty Path')).split('\n'))
      .toEqual(['C:\\Users\\User\\da\\a.txt', 'C:\\Users\\User\\db\\b.txt']);
  });

  it('reads the ACL of every item of a list', async () => {
    const shell = await twoFolders();
    expect((await shell.run('Get-Acl da\\a.txt,db\\b.txt | Select-Object -ExpandProperty Path')).split('\n')).toHaveLength(2);
  });

  it('reads and writes the values of a list of registry keys', async () => {
    const shell = await powershell();
    await shell.runAll('New-Item HKCU:\\Software\\LsKeyA', 'New-Item HKCU:\\Software\\LsKeyB');
    await shell.run('New-ItemProperty -Path HKCU:\\Software\\LsKeyA,HKCU:\\Software\\LsKeyB -Name Mark -Value 1 -PropertyType String');
    expect(await shell.run('(Get-ItemProperty HKCU:\\Software\\LsKeyA).Mark')).toBe('1');
    expect(await shell.run('(Get-ItemProperty HKCU:\\Software\\LsKeyB).Mark')).toBe('1');
    await shell.run('Set-ItemProperty -Path HKCU:\\Software\\LsKeyA,HKCU:\\Software\\LsKeyB -Name Mark -Value 2');
    expect((await shell.run('(Get-ItemProperty HKCU:\\Software\\LsKeyA,HKCU:\\Software\\LsKeyB).Mark')).split('\n')).toEqual(['2', '2']);
    await shell.run('Remove-ItemProperty -Path HKCU:\\Software\\LsKeyA,HKCU:\\Software\\LsKeyB -Name Mark');
    expect(await shell.run('(Get-ItemProperty HKCU:\\Software\\LsKeyA).Mark')).toBe('');
    expect(await shell.run('(Get-ItemProperty HKCU:\\Software\\LsKeyB).Mark')).toBe('');
  });

  it('asks for a path when none is given', async () => {
    const shell = await twoFolders();
    expect(await shell.run('Get-FileHash')).not.toBe('');
    expect(await shell.run('Clear-Content')).not.toBe('');
  });

  it('keeps reading a single path as before', async () => {
    const shell = await twoFolders();
    expect(rowsNamed(await shell.run('Get-ChildItem da'), 'a.txt')).toBe(1);
    expect(rowsNamed(await shell.run('Get-Item da\\a.txt'), 'a.txt')).toBe(1);
    await shell.run('Set-Content da\\a.txt only');
    expect(await shell.run('Get-Content da\\a.txt')).toBe('only');
  });
});

describe('a listing that spans several directories names each of them', () => {
  it('prints one Directory header per folder of a list', async () => {
    const shell = await twoFolders();
    expect(headers(await shell.run('Get-ChildItem da,db'))).toEqual(['C:\\Users\\User\\da', 'C:\\Users\\User\\db']);
  });

  it('prints one Directory header per folder of a recursive listing', async () => {
    const shell = await twoFolders();
    await shell.runAll('New-Item -Path da -Name sub -ItemType Directory', 'Set-Content da\\sub\\s.txt inner');
    expect(headers(await shell.run('Get-ChildItem da -Recurse')))
      .toEqual(['C:\\Users\\User\\da', 'C:\\Users\\User\\da\\sub']);
  });

  it('puts each file under the header of its own folder', async () => {
    const shell = await twoFolders();
    const out = await shell.run('Get-ChildItem da,db');
    const second = out.indexOf('Directory: C:\\Users\\User\\db');
    expect(out.slice(0, second)).toContain('a.txt');
    expect(out.slice(0, second)).not.toContain('b.txt');
    expect(out.slice(second)).toContain('b.txt');
  });

  it('prints one header per container for the items New-Item creates in a list of containers', async () => {
    const shell = await twoFolders();
    const out = await shell.run('New-Item -Path da,db -Name same.txt -ItemType File');
    expect(headers(out)).toEqual(['C:\\Users\\User\\da', 'C:\\Users\\User\\db']);
  });

  it('keeps the single header of a listing in one folder', async () => {
    const shell = await twoFolders();
    expect(headers(await shell.run('Get-ChildItem da'))).toEqual(['C:\\Users\\User\\da']);
  });

  it('names the drive root as the header of the items directly under it', async () => {
    const shell = await powershell();
    expect(headers(await shell.run('Get-ChildItem C:\\'))).toEqual(['C:\\']);
  });

  it('groups only objects that carry Mode, LastWriteTime and Name', async () => {
    const shell = await powershell();
    const serviceLike = "[pscustomobject]@{ Status = 'Running'; Name = 'x'; DisplayName = 'X'; Mode = 'd-----'; FullName = 'C:\\a\\x' }";
    const dated = "[pscustomobject]@{ Mode = 'd-----'; LastWriteTime = [datetime]'2020-01-02'; Name = 'x'; FullName = 'C:\\a\\x' }";
    const relative = "[pscustomobject]@{ Mode = 'd-----'; LastWriteTime = [datetime]'2020-01-02'; Name = 'x'; FullName = 'a\\x' }";
    expect(headers(await shell.run(serviceLike))).toEqual([]);
    expect(headers(await shell.run(relative))).toEqual([]);
    expect(headers(await shell.run(dated))).toEqual(['C:\\a']);
  });
});

describe('mkdir is New-Item -ItemType Directory', () => {
  it('prints the new directory the way New-Item does', async () => {
    const shell = await powershell();
    const out = await shell.run('mkdir md1');
    expect(headers(out)).toEqual(['C:\\Users\\User']);
    expect(out).toMatch(/^d-----\s.*\smd1\s*$/m);
    expect(out).not.toContain('ItemType');
  });

  it('creates the directory by -Name inside the container -Path names', async () => {
    const shell = await powershell();
    await shell.run('mkdir md2');
    const out = await shell.run('mkdir -Path md2 -Name inner');
    expect(headers(out)).toEqual(['C:\\Users\\User\\md2']);
    expect(await shell.run('Test-Path md2\\inner')).toBe('True');
  });

  it('creates the missing parents', async () => {
    const shell = await powershell();
    await shell.run('md md3\\a\\b');
    expect(await shell.run('Test-Path md3\\a\\b')).toBe('True');
  });

  it('refuses an existing directory with the provider wording, under the name that was typed', async () => {
    const shell = await powershell();
    await shell.run('mkdir md4');
    const out = await shell.run('mkdir md4');
    expect(out).toContain('mkdir : An item with the specified name C:\\Users\\User\\md4 already exists.');
    expect(out).toContain('ResourceExists: (C:\\Users\\User\\md4:String) [New-Item], IOException');
    expect(out).toContain('DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand');
  });
});
