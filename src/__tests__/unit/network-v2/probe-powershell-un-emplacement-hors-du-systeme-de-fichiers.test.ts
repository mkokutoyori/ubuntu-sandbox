/**
 * Sonde : un emplacement PowerShell qui n'est pas le systeme de fichiers
 * (Env:, Function:, Variable:, Alias:, HKLM:) se liste, se resout et
 * s'ecrit comme celui d'un vrai PowerShell.
 *
 * Mesure de depart (arbre W1-W4 + W7 + W8, avant ce lot) : apres
 * `cd Env:` (ou `cd Function:`, `cd Variable:`, `cd Alias:`,
 * `cd HKLM:\SOFTWARE`) le prompt change mais `ls`, `Get-Item`,
 * `Test-Path`, `New-Item`, `Set-Content`, `Remove-Item`... continuent
 * d'agir sur le dossier du systeme de fichiers que l'on a quitte ; un
 * nom relatif de l'emplacement courant n'est resolu nulle part ;
 * `New-Item Env:BAZ -Value 3` cree un FICHIER nomme `Env:BAZ` dans C:\ ;
 * `Set-Item FOO v` depuis Env: ne fait rien et ne dit rien ; un chemin
 * recu par le pipeline n'atteint pas `Set-Location` ; un element
 * (`Get-Item C:\Windows`) donne sa table de proprietes au lieu de son
 * chemin ; la fonction `prompt` de l'utilisateur est ignoree ;
 * `Get-ChildItem Env:\COMPUTERNAME` rend TOUTES les variables.
 *
 * Autorites : sources de PowerShell 7.4.6 (tag v7.4.6) -
 * SessionStateProviderBase.cs (GetChildItems trie par nom sans egard a
 * la casse ; NewItem exige une valeur et refuse un nom existant sans
 * -Force ; RenameItem, CopyItem ; lecteur et ecrivain de contenu, Seek et
 * ClearContent non pris en charge), EnvironmentProvider.cs (le nom saisi
 * est celui rendu), VariableProvider.cs, AliasProvider.cs,
 * FunctionProvider.cs, LocationGlobber.cs (ExpandMshGlobPath : le chemin
 * d'une erreur d'introuvable s'ecrit `Lecteur:\nom`),
 * AddContentCommand.cs (SeekContentPosition), textes de
 * SessionStateStrings.resx ; Microsoft Learn about_Prompts (5.1) : la
 * fonction `prompt` fournit la ligne d'invite, `PS>` quand elle echoue ou
 * ne rend rien, le nom de l'ordinateur distant se prepose.
 *
 * Sur l'arbre sans ce lot (8a9f0c939) : 62 des 72 cas tombent. Passent des deux
 * cotes, chacun pour sa raison :
 *   - temoins (le meme laboratoire prouve que le systeme de fichiers
 *     reste atteignable) : 'keeps listing the file system after going
 *     back to C:', 'lists a file-system path typed in full from a foreign
 *     location', 'keeps resolving a file-system name as before', 'runs a
 *     function round trip without any location' ;
 *   - non-regression : 'keeps the long-standing Set-Item and Remove-Item
 *     with the drive typed in full', 'stays at the root of a foreign drive
 *     when asked to go up', 'reads the text between the braces of a
 *     function as its content' ;
 *   - gardes (la fonction `prompt` n'agissait pas, elle ne doit pas
 *     deranger non plus) : 'returns to the default prompt when the
 *     function is removed', 'leaves $? as the command before it left it',
 *     'keeps the default prompt while no function is defined'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
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

  get prompt(): string {
    return this.session.getPrompt();
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
  const shell = await Console.open(new WindowsPC('windows-pc', 'WIN-NS', 0, 0));
  await shell.run('powershell');
  return shell;
}

const PS = (directory: string): string => `PS ${directory}> `;
const rowOf = (output: string, name: string): string[] => output.split('\n').filter(line => line.trimStart().startsWith(name));

describe('a location outside the file system lists what it holds', () => {
  it('lists the environment variables from Env: and not the directory it left', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    const out = await shell.run('ls');
    expect(out).toMatch(/^COMPUTERNAME\s+WIN-NS\s*$/m);
    expect(out).toMatch(/^Name\s+Value\s*$/m);
    expect(out).not.toContain('Directory:');
    expect(out).not.toMatch(/LastWriteTime/);
  });

  it('lists the functions from Function: with the view Get-Command gives them', async () => {
    const shell = await powershell();
    await shell.run('function listedFn { 1 }');
    const command = rowOf(await shell.run('Get-Command listedFn'), 'Function');
    await shell.run('cd Function:');
    const out = await shell.run('ls');
    expect(rowOf(out, 'Function')).toEqual(command);
    expect(out).toMatch(/^CommandType\s+Name\s+Version\s+Source\s*$/m);
    expect(out).not.toContain('Directory:');
  });

  it('lists the variables from Variable:', async () => {
    const shell = await powershell();
    await shell.run('$listedVar = 7');
    await shell.run('cd Variable:');
    const out = await shell.run('ls listedVar');
    expect(out).toMatch(/^listedVar\s+7\s*$/m);
    expect(out).not.toContain('Directory:');
  });

  it('lists the aliases from Alias: as Get-Alias does', async () => {
    const shell = await powershell();
    const alias = await shell.run('Get-Alias gci');
    await shell.run('cd Alias:');
    expect(await shell.run('ls gci')).toBe(alias);
  });

  it('lists the keys of the registry hive entered with cd', async () => {
    const shell = await powershell();
    await shell.run('cd HKLM:\\SOFTWARE');
    const out = await shell.run('ls');
    expect(out).toContain('Microsoft');
    expect(out).not.toContain('Directory:');
    expect(out).not.toMatch(/LastWriteTime/);
  });

  it('resolves a relative key name against the entered registry key', async () => {
    const shell = await powershell();
    await shell.run('cd HKLM:\\SOFTWARE');
    expect(await shell.run('ls Microsoft')).toContain('Windows NT');
    expect(await shell.run('Test-Path Microsoft')).toBe('True');
    expect(await shell.run('Test-Path NoSuchKey')).toBe('False');
  });

  it('filters the listing with a wildcard', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    const out = await shell.run('ls COMP*');
    expect(out).toMatch(/^COMPUTERNAME\s+WIN-NS\s*$/m);
    expect(out).not.toContain('WINDIR');
  });

  it('gives the names alone with -Name', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Get-ChildItem -Name COMP*')).toBe('COMPUTERNAME');
  });

  it('sorts the listing without regard to case', async () => {
    const shell = await powershell();
    await shell.runAll('$zetaVar = 1', '$AlphaVar = 2', 'cd Variable:');
    const out = await shell.run('ls *Var');
    expect(out.indexOf('AlphaVar')).toBeGreaterThan(-1);
    expect(out.indexOf('AlphaVar')).toBeLessThan(out.indexOf('zetaVar'));
  });

  it('refuses a name nothing matches, with the path of the provider', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Get-Item NOPE')).toContain("Cannot find path 'Env:\\NOPE' because it does not exist.");
    expect(await shell.run('ls zzz*')).toContain("Cannot find path 'Env:\\zzz*' because it does not exist.");
    expect(await shell.run('Get-ChildItem Env:NOPE')).toContain("Cannot find path 'Env:\\NOPE' because it does not exist.");
  });

  it('keeps listing the file system after going back to C:', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'cd C:\\Windows');
    const out = await shell.run('ls');
    expect(out).toContain('Directory: C:\\Windows');
    expect(out).toContain('System32');
  });

  it('lists a file-system path typed in full from a foreign location', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    const out = await shell.run('Get-ChildItem C:\\Windows');
    expect(out).toContain('Directory: C:\\Windows');
    expect(out).toContain('System32');
  });
});

describe('a path resolves inside the provider it is typed in', () => {
  it('resolves a relative name in Env: and refuses an absent one with the provider path', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Resolve-Path COMP*')).toMatch(/^Env:\\COMPUTERNAME\s*$/m);
    expect(await shell.run('Resolve-Path .')).toMatch(/^Env:\\\s*$/m);
    expect(await shell.run('Resolve-Path NOPE')).toContain("Cannot find path 'Env:\\NOPE' because it does not exist.");
  });

  it('converts to the path the provider itself uses', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Convert-Path COMPUTERNAME')).toBe('COMPUTERNAME');
    await shell.run('cd HKLM:\\SOFTWARE');
    expect(await shell.run('Convert-Path Microsoft')).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft');
  });

  it('resolves a relative key name in the registry and refuses an absent one', async () => {
    const shell = await powershell();
    await shell.run('cd HKLM:\\SOFTWARE');
    expect(await shell.run('Resolve-Path Microsoft')).toMatch(/^HKLM:\\SOFTWARE\\Microsoft\s*$/m);
    expect(await shell.run('Resolve-Path NoSuchKey')).toContain("Cannot find path 'HKLM:\\SOFTWARE\\NoSuchKey' because it does not exist.");
  });

  it('names the provider and the drive of what it resolved', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('(Resolve-Path COMPUTERNAME).Provider.Name')).toBe('Environment');
    expect(await shell.run('(Resolve-Path COMPUTERNAME).Drive.Name')).toBe('Env');
    expect(await shell.run('(Get-Location).Drive.Name')).toBe('Env');
  });

  it('converts a name typed right after the drive, without a separator', async () => {
    const shell = await powershell();
    expect(await shell.run('Convert-Path Env:COMPUTERNAME')).toBe('COMPUTERNAME');
    expect(await shell.run('Convert-Path Env:\\COMPUTERNAME')).toBe('COMPUTERNAME');
  });

  it('keeps resolving a file-system name as before', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('Convert-Path .')).toBe('C:\\Windows');
    expect(await shell.run('(Resolve-Path .).Provider.Name')).toBe('FileSystem');
    expect(await shell.run('(Resolve-Path .).Drive.Name')).toBe('C');
  });
});

describe('the registry holds no content', () => {
  it('refuses the content cmdlets on a key as the provider does, without touching the file system', async () => {
    const shell = await powershell();
    await shell.run('cd HKLM:\\SOFTWARE');
    const refusal = 'Cannot use interface. The IContentCmdletProvider interface is not implemented by this provider.';
    expect(await shell.run('Get-Content Microsoft')).toContain(refusal);
    expect(await shell.run('Set-Content Microsoft x')).toContain(refusal);
    expect(await shell.run('Add-Content Microsoft x')).toContain(refusal);
    expect(await shell.run('Clear-Content Microsoft')).toContain(refusal);
    expect(await shell.run('Get-ChildItem C:\\Users\\User -Name')).not.toContain('Microsoft');
  });
});

describe('Test-Path and Get-Item read the current provider', () => {
  it('finds a relative name in Env: and refuses an absent one', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Test-Path COMPUTERNAME')).toBe('True');
    expect(await shell.run('Test-Path NOPE')).toBe('False');
  });

  it('matches names without regard to case', async () => {
    const shell = await powershell();
    expect(await shell.run('Test-Path Env:\\computername')).toBe('True');
    await shell.run('cd Env:');
    expect(await shell.run('Test-Path computername')).toBe('True');
  });

  it('returns every entry a wildcard matches', async () => {
    const shell = await powershell();
    await shell.runAll('Set-Item Env:WILD_ONE 1', 'Set-Item Env:WILD_TWO 2');
    const out = await shell.run('Get-Item Env:WILD_*');
    expect(out).toMatch(/^WILD_ONE\s+1\s*$/m);
    expect(out).toMatch(/^WILD_TWO\s+2\s*$/m);
    expect(await shell.run('(Get-Item Env:WILD_*).Count')).toBe('2');
  });

  it('answers for the root of the drive', async () => {
    const shell = await powershell();
    expect(await shell.run('Test-Path Env:\\')).toBe('True');
    expect(await shell.run('Test-Path Variable:\\')).toBe('True');
  });

  it('returns the item with the spelling that was typed for an environment variable', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Get-Item computername')).toMatch(/^computername\s+WIN-NS\s*$/m);
    expect(await shell.run('(Get-Item COMPUTERNAME).Value')).toBe('WIN-NS');
  });

  it('reads the item the path names in Variable:, Function: and Alias:', async () => {
    const shell = await powershell();
    await shell.runAll('$readVar = 3', 'function readFn { "body" }');
    expect(await shell.run('(Get-Item Variable:readVar).Value')).toBe('3');
    expect(await shell.run('(Get-Item Function:readFn).Name')).toBe('readFn');
    expect(await shell.run('(Get-Item Alias:ls).Definition')).toBe('Get-ChildItem');
  });

  it('gives an item the provider path in PSPath', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item Env:COMPUTERNAME).PSPath')).toBe('Microsoft.PowerShell.Core\\Environment::COMPUTERNAME');
    expect(await shell.run('(Get-Item Alias:ls).PSPath')).toBe('Microsoft.PowerShell.Core\\Alias::ls');
  });

  it('keeps the long-standing reads with the drive typed in full', async () => {
    const shell = await powershell();
    expect(await shell.run('Get-Item Env:\\COMPUTERNAME')).toMatch(/^COMPUTERNAME\s+WIN-NS\s*$/m);
    expect(await shell.run('Get-ChildItem Env:\\COMPUTERNAME')).toMatch(/^COMPUTERNAME\s+WIN-NS\s*$/m);
    expect(await shell.run('$env:COMPUTERNAME')).toBe('WIN-NS');
  });
});

describe('an environment variable is written from the location Env:', () => {
  it('creates it with New-Item -Value and shows the new item', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('New-Item FOO -Value bar')).toMatch(/^FOO\s+bar\s*$/m);
    expect(await shell.run('$env:FOO')).toBe('bar');
    expect(await shell.run('Get-Content FOO')).toBe('bar');
  });

  it('creates no file when the drive is typed in full', async () => {
    const shell = await powershell();
    await shell.run('New-Item Env:BAZ -Value 3');
    expect(await shell.run('$env:BAZ')).toBe('3');
    expect(await shell.run('Test-Path C:\\Env:BAZ')).toBe('False');
    expect(await shell.run('Get-ChildItem C:\\ -Name')).not.toContain('Env:BAZ');
  });

  it('refuses an existing name unless -Force, and a missing value', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'New-Item FOO -Value one');
    expect(await shell.run('New-Item FOO -Value two')).toContain("The item at path 'FOO' already exists.");
    expect(await shell.run('$env:FOO')).toBe('one');
    await shell.run('New-Item FOO -Value two -Force');
    expect(await shell.run('$env:FOO')).toBe('two');
    expect(await shell.run('New-Item NOVALUE')).toContain('Value cannot be null.');
  });

  it('sets it with Set-Item and Set-Content, without printing', async () => {
    const shell = await powershell();
    await shell.run('cd Env:');
    expect(await shell.run('Set-Item FOO baz')).toBe('');
    expect(await shell.run('$env:FOO')).toBe('baz');
    expect(await shell.run('Set-Content FOO qux')).toBe('');
    expect(await shell.run('$env:FOO')).toBe('qux');
    expect(await shell.run('Set-Item FOO again -PassThru')).toMatch(/^FOO\s+again\s*$/m);
  });

  it('removes it when it is set to $null', async () => {
    const shell = await powershell();
    await shell.run('New-Item Env:GONE -Value 1');
    expect(await shell.run('Test-Path Env:GONE')).toBe('True');
    await shell.run('Set-Item Env:GONE $null');
    expect(await shell.run('Test-Path Env:GONE')).toBe('False');
  });

  it('refuses to rename it onto a name already taken unless that is forced', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'Set-Item FIRST 1', 'Set-Item SECOND 2');
    expect(await shell.run('Rename-Item FIRST SECOND')).toContain("The item at path 'SECOND' already exists.");
    expect(await shell.run('$env:FIRST')).toBe('1');
    expect(await shell.run('$env:SECOND')).toBe('2');
    await shell.run('Rename-Item FIRST SECOND -Force');
    expect(await shell.run('$env:FIRST')).toBe('');
    expect(await shell.run('$env:SECOND')).toBe('1');
  });

  it('reports an absent name once and the root as a path without content', async () => {
    const shell = await powershell();
    const absent = await shell.run('Get-Content Env:NOPE_X');
    expect(absent.split("Cannot find path 'Env:\\NOPE_X' because it does not exist.")).toHaveLength(2);
    expect(await shell.run('Get-Content Env:')).toContain("Cannot find path 'Env:\\' because it does not exist.");
  });

  it('refuses to append to it and to clear it as the provider does', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'Set-Item FOO baz');
    expect(await shell.run('Add-Content FOO more')).toContain(
      "The invocation of Seek on the 'Environment' provider's content writer failed for path 'Env:\\FOO'. Cannot call method. The content Seek method is not supported by this provider.");
    expect(await shell.run('Clear-Content FOO')).toContain('Cannot perform the ClearContent operation. The ClearContent operation is not supported by this provider.');
    expect(await shell.run('$env:FOO')).toBe('baz');
  });

  it('renames it and copies it inside Env:', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'Set-Item FOO baz');
    expect(await shell.run('Rename-Item FOO FOO2')).toBe('');
    expect(await shell.run('$env:FOO')).toBe('');
    expect(await shell.run('$env:FOO2')).toBe('baz');
    expect(await shell.run('Copy-Item FOO2 FOO3')).toBe('');
    expect(await shell.run('$env:FOO3')).toBe('baz');
    expect(await shell.run('Copy-Item FOO2 FOO3 -PassThru')).toMatch(/^FOO3\s+baz\s*$/m);
    expect(await shell.run('Rename-Item FOO3 FOO4 -PassThru')).toMatch(/^FOO4\s+baz\s*$/m);
  });

  it('removes it by name or from a listing, and refuses an absent name', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'Set-Item FOO baz', 'Set-Item FOO2 baz');
    expect(await shell.run('Remove-Item FOO')).toBe('');
    expect(await shell.run('Test-Path FOO')).toBe('False');
    expect(await shell.run('Get-ChildItem FOO* | Remove-Item')).toBe('');
    expect(await shell.run('Test-Path FOO2')).toBe('False');
    expect(await shell.run('Remove-Item NOPE')).toContain("Cannot find path 'Env:\\NOPE' because it does not exist.");
  });

  it('keeps the long-standing Set-Item and Remove-Item with the drive typed in full', async () => {
    const shell = await powershell();
    await shell.run('Set-Item Env:BAR 1');
    expect(await shell.run('$env:BAR')).toBe('1');
    await shell.run('Remove-Item Env:BAR');
    expect(await shell.run('$env:BAR')).toBe('');
  });

  it('shows to cmd what PowerShell wrote', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'New-Item SHARED -Value seen');
    await shell.run('cmd');
    expect(await shell.run('echo %SHARED%')).toBe('seen');
  });

  it('refuses a copy between two providers', async () => {
    const shell = await powershell();
    await shell.run('Set-Item Env:BAZ 3');
    expect(await shell.run('Copy-Item Env:BAZ Variable:BAZ')).toContain('Source and destination path did not resolve to the same provider.');
    expect(await shell.run('Copy-Item Env:BAZ C:\\baz.txt')).toContain('Source and destination path did not resolve to the same provider.');
    expect(await shell.run('Test-Path C:\\baz.txt')).toBe('False');
  });
});

describe('a variable, a function and an alias are written from their locations', () => {
  it('creates, sets, reads, renames and removes a variable', async () => {
    const shell = await powershell();
    await shell.run('cd Variable:');
    expect(await shell.run('New-Item myvar -Value 5')).toMatch(/^myvar\s+5\s*$/m);
    expect(await shell.run('$myvar')).toBe('5');
    await shell.run('Set-Item myvar 6');
    expect(await shell.run('$myvar')).toBe('6');
    expect(await shell.run('Get-Content myvar')).toBe('6');
    await shell.run('Rename-Item myvar myvar2');
    expect(await shell.run('$myvar2')).toBe('6');
    await shell.run('Remove-Item myvar2');
    expect(await shell.run('Test-Path myvar2')).toBe('False');
  });

  it('keeps an array value as the lines of the content', async () => {
    const shell = await powershell();
    await shell.runAll('cd Variable:', 'Set-Item many (1,2,3)');
    expect(await shell.run('Get-Content many')).toBe('1\n2\n3');
  });

  it('defines a function from a script block or a string', async () => {
    const shell = await powershell();
    await shell.run('cd Function:');
    await shell.run('Set-Item blockFn { "from block" }');
    expect(await shell.run('blockFn')).toBe('from block');
    expect(await shell.run('New-Item textFn -Value "Write-Output from-text"')).toMatch(/^Function\s+textFn\b/m);
    expect(await shell.run('textFn')).toBe('from-text');
    await shell.run('Set-Content contentFn "Write-Output from-content"');
    expect(await shell.run('contentFn')).toBe('from-content');
  });

  it('copies, renames, reads and removes a function', async () => {
    const shell = await powershell();
    await shell.runAll('function srcFn { "x" }', 'cd Function:');
    await shell.run('Copy-Item srcFn copyFn');
    expect(await shell.run('copyFn')).toBe('x');
    await shell.run('Rename-Item copyFn movedFn');
    expect(await shell.run('movedFn')).toBe('x');
    expect((await shell.run('Get-Content movedFn')).trim()).toBe('"x"');
    await shell.run('Remove-Item movedFn');
    expect(await shell.run('Test-Path movedFn')).toBe('False');
    expect(await shell.run('Test-Path srcFn')).toBe('True');
  });

  it('reads the text between the braces of a function as its content', async () => {
    const shell = await powershell();
    await shell.run('function bodyFn { 1 }');
    await shell.run('function nestedFn { if ($true) { 2 } }');
    expect(await shell.run('Get-Content Function:bodyFn')).toBe(' 1 ');
    expect(await shell.run('Get-Content Function:nestedFn')).toBe(' if ($true) { 2 } ');
  });

  it('gives its text as the definition of the command row and of the item', async () => {
    const shell = await powershell();
    await shell.run('function defFn { "hello" }');
    expect(await shell.run('(Get-Command defFn).Definition.Trim()')).toBe('"hello"');
    expect(await shell.run('(Get-Item Function:defFn).Definition.Trim()')).toBe('"hello"');
  });

  it('refuses a name already taken in Function:', async () => {
    const shell = await powershell();
    await shell.runAll('function takenFn { 1 }', 'cd Function:');
    expect(await shell.run('New-Item takenFn -Value "2"')).toContain("The item at path 'takenFn' already exists.");
    expect(await shell.run('takenFn')).toBe('1');
  });

  it('creates, reads, renames, copies and removes an alias', async () => {
    const shell = await powershell();
    await shell.run('cd Alias:');
    await shell.run('New-Item hh -Value Get-Location');
    expect(await shell.run('Get-Content hh')).toBe('Get-Location');
    await shell.run('Rename-Item hh hh2');
    expect(await shell.run('Test-Path hh')).toBe('False');
    await shell.run('Copy-Item hh2 hh3');
    expect(await shell.run('Get-Content hh3')).toBe('Get-Location');
    await shell.run('Set-Item hh3 Get-Date');
    expect(await shell.run('Get-Content hh3')).toBe('Get-Date');
    await shell.run('Remove-Item hh2');
    expect(await shell.run('Test-Path hh2')).toBe('False');
  });

  it('runs a function round trip without any location', async () => {
    const shell = await powershell();
    await shell.runAll('function roundFn { "round" }');
    expect(await shell.run('roundFn')).toBe('round');
    await shell.run('Remove-Item Function:\\roundFn');
    expect(await shell.run('Test-Path Function:\\roundFn')).toBe('False');
  });
});

describe('a path is bound from the pipeline and an item is converted to it', () => {
  it('binds a string piped to Set-Location', async () => {
    const shell = await powershell();
    await shell.run("'C:\\Windows' | Set-Location");
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('binds an item piped to Set-Location', async () => {
    const shell = await powershell();
    await shell.run('Get-Item C:\\Windows | Set-Location');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('binds the Path property of an object piped to Set-Location', async () => {
    const shell = await powershell();
    await shell.run("[pscustomobject]@{Path='C:\\Windows'} | Set-Location");
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('pushes the directory chosen from a listing and remembers where it was', async () => {
    const shell = await powershell();
    await shell.run('Get-ChildItem C:\\Windows -Directory | Select-Object -First 1 | Push-Location');
    expect(shell.prompt).not.toBe(PS('C:\\Users\\User'));
    expect(await shell.run('Get-Location -Stack')).toContain('C:\\Users\\User');
    await shell.run('Pop-Location');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('accepts an item in place of a path', async () => {
    const shell = await powershell();
    await shell.run('Set-Location (Get-Item C:\\Windows)');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
    await shell.run('Set-Location -Path (Get-Item C:\\Users)');
    expect(shell.prompt).toBe(PS('C:\\Users'));
  });

  it('converts an item to its full path in a string', async () => {
    const shell = await powershell();
    expect(await shell.run('"$(Get-Item C:\\Windows)"')).toBe('C:\\Windows');
    expect(await shell.run('(Get-Item C:\\Windows).ToString()')).toBe('C:\\Windows');
  });

  it('converts an entry of a listing to its name', async () => {
    const shell = await powershell();
    await shell.run('$first = Get-ChildItem C:\\Windows | Select-Object -First 1');
    expect(await shell.run('"$first"')).toBe(await shell.run('$first.Name'));
  });

  it('strips the provider from a path received from the pipeline', async () => {
    const shell = await powershell();
    await shell.run("'Microsoft.PowerShell.Core\\FileSystem::C:\\Windows' | Set-Location");
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('goes home with ~ from a foreign location', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'cd ~');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
  });

  it('stays at the root of a foreign drive when asked to go up', async () => {
    const shell = await powershell();
    await shell.runAll('cd Env:', 'cd ..');
    expect(shell.prompt).toBe(PS('Env:\\'));
    await shell.run('cd \\');
    expect(shell.prompt).toBe(PS('Env:\\'));
  });
});

describe('the prompt function of the user decides the prompt', () => {
  it('shows the string the function returns', async () => {
    const shell = await powershell();
    await shell.run('function prompt { "X> " }');
    expect(shell.prompt).toBe('X> ');
  });

  it('follows the location when the function reads it', async () => {
    const shell = await powershell();
    await shell.run('function prompt { "[$(Get-Location)] $ " }');
    await shell.run('cd C:\\Windows');
    expect(shell.prompt).toBe('[C:\\Windows] $ ');
    await shell.run('cd Env:');
    expect(shell.prompt).toBe('[Env:\\] $ ');
  });

  it('shows what the function writes to the host before what it returns', async () => {
    const shell = await powershell();
    await shell.run('function prompt { Write-Host "a" -NoNewline; "b> " }');
    expect(shell.prompt).toBe('ab> ');
  });

  it('falls back to PS> when the function returns nothing or fails', async () => {
    const shell = await powershell();
    await shell.run('function prompt { $null }');
    expect(shell.prompt).toBe('PS>');
    await shell.run('function prompt { throw "broken" }');
    expect(shell.prompt).toBe('PS>');
  });

  it('returns to the default prompt when the function is removed', async () => {
    const shell = await powershell();
    await shell.run('function prompt { "X> " }');
    await shell.run('Remove-Item Function:\\prompt');
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
    await shell.run('cd C:\\Windows');
    expect(shell.prompt).toBe(PS('C:\\Windows'));
  });

  it('runs the function once per command and not once per reading of the prompt', async () => {
    const shell = await powershell();
    await shell.run('function prompt { $global:count++; "$count> " }');
    expect(shell.prompt).toBe('1> ');
    expect(shell.prompt).toBe('1> ');
    await shell.run('1');
    expect(shell.prompt).toBe('2> ');
  });

  it('keeps the location the function moved to', async () => {
    const shell = await powershell();
    await shell.run('function prompt { Set-Location C:\\Windows; "X> " }');
    expect(await shell.run('(Get-Location).Path')).toBe('C:\\Windows');
    expect(await shell.run('cmd /c cd')).toBe('C:\\Windows');
  });

  it('keeps the environment variable the function set', async () => {
    const shell = await powershell();
    await shell.run('function prompt { $env:PROMPT_RAN = "yes"; "X> " }');
    expect(await shell.run('$env:PROMPT_RAN')).toBe('yes');
  });

  it('leaves $? as the command before it left it', async () => {
    const shell = await powershell();
    await shell.run('function prompt { "X> " }');
    await shell.run('Write-Error boom -ErrorAction SilentlyContinue');
    expect(await shell.run('$?')).toBe('False');
  });

  it('keeps the default prompt while no function is defined', async () => {
    const shell = await powershell();
    expect(shell.prompt).toBe(PS('C:\\Users\\User'));
    await shell.run('cd Env:');
    expect(shell.prompt).toBe(PS('Env:\\'));
  });
});

describe('the sub-shell runs the prompt function once, when a command ends', () => {
  const subShell = (): PowerShellSubShell =>
    PowerShellSubShell.create(new WindowsPC('windows-pc', 'WIN-NS', 0, 0)).subShell;

  it('hands the new prompt back with the result of the command that defined the function', async () => {
    const shell = subShell();
    const result = await shell.processLine('function prompt { "X> " }');
    expect(result.prompt).toBe('X> ');
    expect(shell.getPrompt()).toBe('X> ');
  });

  it('does not run the function while a block is still being typed', async () => {
    const shell = subShell();
    await shell.processLine('function prompt { $global:count++; "$count> " }');
    expect((await shell.processLine('if ($true) {')).prompt).toBe('>> ');
    expect((await shell.processLine('$count')).prompt).toBe('>> ');
    const closed = await shell.processLine('}');
    expect(closed.output).toEqual(['1']);
    expect(closed.prompt).toBe('2> ');
  });

  it('does not run the function when the session is left', async () => {
    const shell = subShell();
    await shell.processLine('function prompt { $global:count++; "$count> " }');
    expect((await shell.processLine('exit')).exit).toBe(true);
    expect((await shell.processLine('$count')).output).toEqual(['1']);
  });
});
