/**
 * Sonde : `New-Item -Path <conteneur> -Name <nom>` cree l'element DANS le
 * conteneur, et les refus portent les mots du fournisseur.
 *
 * Mesure de depart (arbre W9, avant ce lot) : -Name etait declare mais
 * jamais lu. `New-Item -Path C:\Users\User -Name f.txt -ItemType File`
 * repondait « The file 'C:\Users\User' already exists. », `New-Item -Name d
 * -ItemType Directory` « An item with the specified name '' already
 * exists. », `New-Item -Path d -Name f.txt -Value x` creait un FICHIER
 * nomme `d` ; depuis une cle de registre, `New-Item -Path . -Name ZZ` ne
 * creait rien ; -ItemType n'etait pas evalue (`-ItemType Bogus` creait un
 * fichier, `-ItemType dir` ou `f` ne se lisaient pas comme un prefixe) ; les
 * messages citaient le chemin tel que tape, un dossier existant entre
 * apostrophes, sans identifiant d'erreur ni categorie du fournisseur ; le
 * -Value d'une cle de registre etait ignore.
 *
 * Autorites : sources de PowerShell 7.4.6 (tag v7.4.6) - Navigation.cs
 * (NewItemCommand : Path est le conteneur quand Name est donne, Path est
 * facultatif avec Name, `Path = string.Empty` pour le conteneur courant),
 * FileSystemProvider.cs (NewItem : type vide = file, GetItemType lit le
 * type comme un prefixe sans egard a la casse dans l'ordre directory,
 * container, file, symboliclink, junction, hardlink ; Force cree les
 * dossiers intermediaires ; fichier en FileMode.CreateNew, Create avec
 * Force ; CreateDirectory refuse un element existant sans Force par
 * DirectoryExist/ResourceExists ; IOException -> NewItemIOError/WriteError),
 * FileSystemProviderStrings.resx (DirectoryExist : « An item with the
 * specified name {0} already exists. », UnknownType) ; RegistryProvider.cs
 * (NewItem : la valeur donnee fixe la valeur par defaut de la cle).
 *
 * Sur l'arbre sans ce lot (80f7f29e9) : 20 des 25 cas tombent. Passent des
 * deux cotes, tous de non-regression (le meme laboratoire prouve que ce qui
 * marchait marche encore) : 'keeps creating by -Path alone', 'truncates an
 * existing file with -Force', 'returns the existing directory with -Force',
 * 'refuses the link types the file system cannot hold and creates nothing',
 * 'keeps creating a registry key by its full path'.
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
  const shell = await Console.open(new WindowsPC('windows-pc', 'WIN-NI', 0, 0));
  await shell.run('powershell');
  return shell;
}

describe('New-Item creates the item inside the container named by -Path', () => {
  it('creates a file named by -Name inside the container', async () => {
    const shell = await powershell();
    const out = await shell.run('New-Item -Path C:\\Users\\User -Name f1.txt -ItemType File');
    expect(await shell.run('Test-Path C:\\Users\\User\\f1.txt')).toBe('True');
    expect(out).toMatch(/^\s+Directory: C:\\Users\\User\s*$/m);
    expect(out).toMatch(/^-a----\s.*\s0 f1\.txt\s*$/m);
  });

  it('takes . as the current location', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path . -Name f2.txt -ItemType File');
    expect(await shell.run('Test-Path C:\\Users\\User\\f2.txt')).toBe('True');
  });

  it('takes the current location when -Path is absent', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Name d3 -ItemType Directory');
    expect(await shell.run('Test-Path C:\\Users\\User\\d3')).toBe('True');
    expect(await shell.run('(Get-Item d3).PSIsContainer')).toBe('True');
  });

  it('resolves a relative container against the current location', async () => {
    const shell = await powershell();
    await shell.runAll('cd C:\\Windows', 'New-Item -Path Temp -Name f4.txt -ItemType File');
    expect(await shell.run('Test-Path C:\\Windows\\Temp\\f4.txt')).toBe('True');
    expect(await shell.run('Test-Path C:\\Windows\\Temp')).toBe('True');
  });

  it('writes -Value into the new file', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path C:\\Users\\User -Name f5.txt -ItemType File -Value hello');
    expect(await shell.run('Get-Content C:\\Users\\User\\f5.txt')).toBe('hello');
  });

  it('names the container in the Directory header', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path C:\\Users\\User -Name d6 -ItemType Directory');
    const out = await shell.run('New-Item -Path d6 -Name f6.txt -ItemType File');
    expect(out).toMatch(/^\s+Directory: C:\\Users\\User\\d6\s*$/m);
  });

  it('creates the item in every container of a list', async () => {
    const shell = await powershell();
    await shell.runAll('New-Item -Name da -ItemType Directory', 'New-Item -Name db -ItemType Directory');
    const out = await shell.run('New-Item -Path da,db -Name same.txt -ItemType File');
    expect(out.match(/same\.txt/g)).toHaveLength(2);
    expect(await shell.run('Test-Path da\\same.txt')).toBe('True');
    expect(await shell.run('Test-Path db\\same.txt')).toBe('True');
    expect(await shell.run('(New-Item -Path da,db -Name again.txt -ItemType File).Count')).toBe('2');
  });

  it('keeps creating by -Path alone', async () => {
    const shell = await powershell();
    await shell.run('New-Item f8.txt -ItemType File -Value kept');
    expect(await shell.run('Get-Content f8.txt')).toBe('kept');
    await shell.run('New-Item d8 -ItemType Directory');
    expect(await shell.run('Test-Path d8')).toBe('True');
  });
});

describe('New-Item refuses with the words of the file system provider', () => {
  it('refuses an existing file and names it by its full path', async () => {
    const shell = await powershell();
    await shell.run('New-Item f9.txt -ItemType File');
    const out = await shell.run('New-Item f9.txt -ItemType File');
    expect(out).toContain("New-Item : The file 'C:\\Users\\User\\f9.txt' already exists.");
    expect(out).toContain('WriteError: (C:\\Users\\User\\f9.txt:String) [New-Item], IOException');
    expect(out).toContain('NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand');
  });

  it('truncates an existing file with -Force', async () => {
    const shell = await powershell();
    await shell.run('New-Item f10.txt -ItemType File -Value content');
    const out = await shell.run('New-Item f10.txt -ItemType File -Force');
    expect(out).not.toContain('already exists');
    expect(await shell.run('(Get-Item f10.txt).Length')).toBe('0');
  });

  it('refuses an existing directory by its full path and the provider identifier', async () => {
    const shell = await powershell();
    await shell.run('New-Item d11 -ItemType Directory');
    const out = await shell.run('New-Item d11 -ItemType Directory');
    expect(out).toContain('New-Item : An item with the specified name C:\\Users\\User\\d11 already exists.');
    expect(out).toContain('ResourceExists: (C:\\Users\\User\\d11:String) [New-Item], IOException');
    expect(out).toContain('DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand');
  });

  it('returns the existing directory with -Force', async () => {
    const shell = await powershell();
    await shell.run('New-Item d12 -ItemType Directory');
    expect(await shell.run('(New-Item d12 -ItemType Directory -Force).Name')).toBe('d12');
  });

  it('refuses a file whose parent does not exist', async () => {
    const shell = await powershell();
    const out = await shell.run('New-Item -Path nope13 -Name f.txt -ItemType File');
    expect(out).toContain("New-Item : Could not find a part of the path 'C:\\Users\\User\\nope13\\f.txt'.");
    expect(out).toContain('NewItemIOError,Microsoft.PowerShell.Commands.NewItemCommand');
    expect(await shell.run('Test-Path nope13')).toBe('False');
  });

  it('creates the missing parents of a file with -Force', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path up14 -Name f.txt -ItemType File -Force');
    expect(await shell.run('Test-Path up14\\f.txt')).toBe('True');
  });

  it('creates the missing parents of a directory without -Force', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path deep15\\er -Name dir -ItemType Directory');
    expect(await shell.run('Test-Path deep15\\er\\dir')).toBe('True');
  });

  it('refuses an item type the file system does not know', async () => {
    const shell = await powershell();
    const out = await shell.run('New-Item bogus16.txt -ItemType Bogus');
    expect(out).toContain('New-Item : The type is not a known type for the file system. Only "file","directory" or "symboliclink" can be specified.');
    expect(out).toContain('InvalidArgument: (:) [New-Item], ParentContainsErrorRecordException');
    expect(out).toContain('Argument,Microsoft.PowerShell.Commands.NewItemCommand');
    expect(await shell.run('Test-Path bogus16.txt')).toBe('False');
  });

  it('reads the item type as a prefix without regard to case', async () => {
    const shell = await powershell();
    await shell.runAll('New-Item d17 -ItemType DIR', 'New-Item f17 -ItemType f', 'New-Item c17 -ItemType Cont');
    expect(await shell.run('(Get-Item d17).PSIsContainer')).toBe('True');
    expect(await shell.run('(Get-Item f17).PSIsContainer')).toBe('False');
    expect(await shell.run('(Get-Item c17).PSIsContainer')).toBe('True');
  });

  it('refuses the link types the file system cannot hold and creates nothing', async () => {
    const shell = await powershell();
    for (const type of ['SymbolicLink', 'Junction', 'HardLink']) {
      const out = await shell.run(`New-Item link18-${type} -ItemType ${type}`);
      expect(out).toContain(`is not supported in this simulator: the file system has no links.`);
      expect(await shell.run(`Test-Path link18-${type}`)).toBe('False');
    }
  });

  it('asks for Path when neither -Path nor -Name is given', async () => {
    const shell = await powershell();
    expect(await shell.run('New-Item')).toContain('missing mandatory parameters: Path.');
  });
});

describe('New-Item in the other providers', () => {
  it('creates an environment variable by -Name from Env: and with -Path Env:', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'New-Item -Name NI_ONE -Value 1', 'New-Item -Path Env: -Name NI_TWO -Value 2');
    expect(await shell.run('$env:NI_ONE')).toBe('1');
    expect(await shell.run('$env:NI_TWO')).toBe('2');
  });

  it('creates a registry key by -Name inside the key -Path names', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path HKCU:\\Software -Name NiKeyA');
    expect(await shell.run('Test-Path HKCU:\\Software\\NiKeyA')).toBe('True');
  });

  it('creates a registry key relative to the current key', async () => {
    const shell = await powershell();
    await shell.runAll('cd HKCU:\\Software', 'New-Item -Name NiKeyB', 'New-Item -Path . -Name NiKeyC');
    expect(await shell.run('Test-Path HKCU:\\Software\\NiKeyB')).toBe('True');
    expect(await shell.run('Test-Path HKCU:\\Software\\NiKeyC')).toBe('True');
  });

  it('sets the default value of a registry key from -Value', async () => {
    const shell = await powershell();
    await shell.runAll('cd HKCU:\\Software', 'New-Item -Name NiKeyD -Value hello');
    expect(await shell.run("(Get-ItemProperty NiKeyD).'(default)'")).toBe('hello');
  });

  it('leaves a registry key without values when no -Value is given', async () => {
    const shell = await powershell();
    await shell.run('New-Item -Path HKCU:\\Software -Name NiKeyF');
    expect(await shell.run('Get-ItemProperty HKCU:\\Software\\NiKeyF')).toBe('');
  });

  it('keeps creating a registry key by its full path', async () => {
    const shell = await powershell();
    await shell.run('New-Item HKCU:\\Software\\NiKeyE');
    expect(await shell.run('Test-Path HKCU:\\Software\\NiKeyE')).toBe('True');
  });
});
