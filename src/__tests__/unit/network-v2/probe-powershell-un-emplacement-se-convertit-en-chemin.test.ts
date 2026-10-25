/**
 * Un emplacement PowerShell se comporte comme un `PathInfo` -- il se convertit en son chemin partout ou un chemin est
 * attendu -- et les commandes de chemin (Split-Path, Convert-Path, Resolve-Path, Test-Path, Get-PSDrive, New-PSDrive,
 * Get-Item, Get-ChildItem) lisent leurs arguments comme PowerShell.
 *
 * Mesure de depart (3789713d6), un WindowsPC et un terminal PowerShell : `"$PWD"`, `$PWD.ToString()`, `[string]$PWD`
 * et `"$(Get-Location)"` imprimaient la table de proprietes de l'objet (`Path=C:\; ProviderPath=C:\; Provider=...`), si
 * bien que `Join-Path $PWD x`, `Split-Path $PWD`, `Set-Location $saved` et `Test-Path $PWD` echouaient ; `$PWD` restait
 * fige sur la premiere valeur lue ; `Convert-Path` n'existait pas ; `Split-Path` ne lisait pas un commutateur place
 * avant le chemin, rendait `C:` pour le parent d'un dossier de premier niveau (au lieu de `C:\`), un parent pour une
 * racine, gardait la barre oblique et n'honorait ni `-Qualifier`, `-NoQualifier`, `-IsAbsolute`, `-Resolve`, ni la
 * difference entre les editions (`-Extension` et `-LeafBase` n'existent qu'en PowerShell 7) ; un joker place
 * directement sous la racine d'un lecteur (`C:\Wi*`) ne se resolvait pas dans `Resolve-Path` ni `Test-Path` ;
 * `Resolve-Path -Relative` rendait l'objet ; `Get-PSDrive` ne triait pas par nom, ne filtrait ni par nom ni par
 * `-PSProvider`, ne nommait pas le fournisseur et ne refusait ni un lecteur ni un fournisseur absent ; un lecteur cree
 * par `New-PSDrive` sur le systeme de fichiers ou le registre ne s'entrait pas (`Set-Location X:`, `X:`), n'etait pas
 * lu par les commandes de chemin, se quittait vers le haut et n'etait refuse ni quand son nom etait pris ni quand sa
 * racine n'etait pas un dossier ; `Get-Item` et `Get-ChildItem` rendaient un objet sans `Parent`, `Root`,
 * `Directory`, `Exists`, `PSPath`, `PSDrive`, `PSProvider`, `Get-Item` exigeait `-Path` et ne trouvait pas
 * `C:\Win*` ; `Test-Path` ignorait `-PathType` et `-IsValid`, ne lisait pas le pipeline (`'C:\Windows' | Test-Path`
 * rendait False) et rendait False pour `$null` ou une liste vide au lieu de l'erreur de liaison ; `Remove-Item ''`
 * repondait « Cannot find path '' » au lieu de l'erreur de liaison ; `Get-Item` tirait le chemin d'un objet recu par le pipeline de son texte ; `New-PSDrive` rendait
 * `Used` et `Free` a 0 au lieu de l'occupation du volume qui porte la racine, et ne deduisait le fournisseur d'une
 * racine que pour une lettre de lecteur nue ; et une commande a droite d'une affectation
 * (`$x = Get-Item .`, `$ok = Test-Path ..`, `$x = Get-ChildItem *`) prenait `.`, `..` ou `*` pour une chaine.
 *
 * Autorites : Microsoft Learn (PowerShell 7.6, pages lues) -- Split-Path, Convert-Path, Resolve-Path, Get-PSDrive,
 * New-PSDrive, Test-Path (`Test-Path $null` : « Cannot bind argument to parameter 'Path' because it is null. », une
 * chaine vide ou blanche : False) ; sources de PowerShell 7.4.6 -- `PathInfo` (le texte d'un emplacement est son chemin),
 * `SessionStateStrings.resx` (« Cannot find drive. A drive with the name '{0}' does not exist. », « Cannot find a
 * provider with the name '{0}'. », « A drive with the name '{0}' already exists. ») et `FileSystemProviderStrings.resx`
 * (« The specified drive root "{0}" either does not exist, or it is not a folder. ») ; .NET `FileSystemInfo.ToString`
 * (le chemin d'origine : complet pour `Get-Item`, le nom seul pour une entree enumeree).
 *
 * Sur les 97 cas, 78 tombent avant la correction. Les 19 qui passent dans les deux etats sont de trois sortes. Des
 * NON-REGRESSIONS de ce qui marchait deja : « keeps the Path column when printed » (la table de `Get-Location`),
 * « keeps a relative parent relative » (`Split-Path`), « is left by a path of another drive » et « is gone once it
 * is removed » (les lecteurs de `New-PSDrive`), « takes a wildcard as its argument » (le parseur), les cinq cas
 * de « Remove-Item reads its targets as the other path commands do » (le pipeline, une chaine, un objet a propriete
 * Path, rien, une liste explicite) et les deux de « Get-ChildItem and Get-Item take a piped path » : ces commandes
 * lisaient deja un chemin recu par le pipeline, chacune par sa propre fonction, remplacees ici par celle des autres
 * commandes de chemin. Les GARDE-FOUS nes du balayage de la serie precedente (la racine d'un
 * lecteur garde son separateur, un joker sous cette racine se resout) : les cinq cas « a wildcard directly under a
 * drive root » -- liste du dossier, liste des fichiers, entree dans un dossier unique, refus de plusieurs, date de
 * l'element rendu par `Get-Item`. Deux GARDE-FOUS du sens d'une condition : « keeps the drives of every provider
 * named », que la base passe parce qu'elle ignorait `-PSProvider` et rendait tout -- le cas fixe qu'un lecteur est
 * garde quand IL EST DE L'UN des fournisseurs nommes ; « stays a range and not a command », que la base passe parce
 * qu'elle n'avait pas la branche qui lit une commande a droite d'une affectation -- le cas fixe que cette branche
 * ne prend pas `1 .. 3` pour une commande.
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

async function powershell(command = 'powershell'): Promise<Console> {
  const shell = await Console.open(new WindowsPC('windows-pc', 'WIN-PATH', 0, 0));
  await shell.run(command);
  return shell;
}

const PS = (directory: string): string => `PS ${directory}> `;

describe('a location converts to its path', () => {
  it('expands $PWD in a string with the live location', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows\\System32');
    expect(await shell.run('"$PWD"')).toBe('C:\\Windows\\System32');
    expect(await shell.run('"$pwd\\x"')).toBe('C:\\Windows\\System32\\x');
  });

  it('converts to a string explicitly', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows\\System32');
    expect(await shell.run('$PWD.ToString()')).toBe('C:\\Windows\\System32');
    expect(await shell.run('[string]$PWD')).toBe('C:\\Windows\\System32');
    expect(await shell.run('"at $(Get-Location)"')).toBe('at C:\\Windows\\System32');
  });

  it('joins and splits a location like a path', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows\\System32');
    expect(await shell.run('Join-Path $PWD drivers')).toBe('C:\\Windows\\System32\\drivers');
    expect(await shell.run('Join-Path (Get-Location) hosts')).toBe('C:\\Windows\\System32\\hosts');
    expect(await shell.run('Split-Path $PWD')).toBe('C:\\Windows');
    expect(await shell.run('Get-Location | Split-Path -Leaf')).toBe('System32');
  });

  it('is accepted wherever a path is', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows\\System32');
    expect(await shell.run('Test-Path $PWD')).toBe('True');
    expect(await shell.run('(Get-ChildItem $PWD | Measure-Object).Count -gt 0')).toBe('True');
  });

  it('returns to a saved location', async () => {
    const shell = await powershell();
    await shell.runAll('cd C:\\Windows\\System32', '$here = Get-Location', 'cd C:\\');
    expect(shell.prompt).toBe(PS('C:\\'));
    await shell.run('Set-Location $here');
    expect(shell.prompt).toBe(PS('C:\\Windows\\System32'));
  });

  it('names its provider and its drive', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Location).Provider.Name')).toBe('FileSystem');
    expect(await shell.run('"$((Get-Location).Provider)"')).toBe('Microsoft.PowerShell.Core\\FileSystem');
    expect(await shell.run('"$((Get-Location).Drive)"')).toBe('C');
  });

  it('follows the location into another provider', async () => {
    const shell = await powershell();
    await shell.run('cd HKCU:\\');
    expect(await shell.run('"$PWD"')).toBe('HKCU:\\');
    expect(await shell.run('"$((Get-Location).Provider)"')).toBe('Microsoft.PowerShell.Core\\Registry');
  });

  it('is what Resolve-Path returns', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows\\System32');
    expect(await shell.run('"$(Resolve-Path .)"')).toBe('C:\\Windows\\System32');
    expect(await shell.run('(Resolve-Path .).Path')).toBe('C:\\Windows\\System32');
  });

  it('keeps the Path column when printed', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows');
    const printed = await shell.run('Get-Location');
    expect(printed).toContain('Path');
    expect(printed).toContain('C:\\Windows');
    expect(printed).not.toContain('ProviderPath');
  });

  it('keeps $PWD true to the location after the shell asked for it twice', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows');
    await shell.run('"$PWD"');
    await shell.run('cd C:\\Users');
    expect(await shell.run('"$PWD"')).toBe('C:\\Users');
  });
});

describe('Split-Path', () => {
  it('reads a switch placed before the path', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -Parent C:\\Users\\User')).toBe('C:\\Users');
    expect(await shell.run('Split-Path -Leaf C:\\Windows\\System32')).toBe('System32');
    expect(await shell.run('Split-Path -Qualifier C:\\x\\y')).toBe('C:');
  });

  it('returns the drive root as the parent of a top-level folder', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path C:\\Windows')).toBe('C:\\');
  });

  it('has no parent for a drive root', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path C:\\')).toBe('');
    expect(await shell.run('Split-Path foo')).toBe('');
  });

  it('keeps a relative parent relative', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path .\\folder1\\file1.txt')).toBe('.\\folder1');
  });

  it('turns a forward slash into a backslash', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path C:/Windows/System32')).toBe('C:\\Windows');
  });

  it('gives the drive root as the leaf of a drive root', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -Leaf C:\\')).toBe('C:\\');
  });

  it('returns the qualifier of a registry path', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -Path "HKCU:\\Software\\Microsoft" -Qualifier')).toBe('HKCU:');
  });

  it('refuses a qualifier that is not there', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -Qualifier x\\y')).toContain("Cannot parse path because path 'x\\y' does not have a qualifier specified.");
  });

  it('removes the qualifier', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -NoQualifier C:\\x\\y')).toBe('\\x\\y');
    expect(await shell.run('Split-Path -NoQualifier x\\y')).toBe('x\\y');
  });

  it('says whether a path is absolute', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -IsAbsolute C:\\x')).toBe('True');
    expect(await shell.run('Split-Path -IsAbsolute .\\x')).toBe('False');
  });

  it('reads a path from the pipeline', async () => {
    const shell = await powershell();
    expect(await shell.run("'C:\\Users\\User01\\My Documents\\My Pictures' | Split-Path")).toBe('C:\\Users\\User01\\My Documents');
  });

  it('resolves the path first with -Resolve', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path C:\\Windows\\System32\\drivers\\etc\\hos* -Leaf -Resolve')).toBe('hosts');
    expect(await shell.run('Split-Path C:\\Win* -Parent -Resolve')).toBe('C:\\');
    expect(await shell.run('Split-Path C:\\nothing -Resolve')).toContain("Cannot find path 'C:\\nothing' because it does not exist.");
  });

  it('refuses -Extension and -LeafBase in Windows PowerShell', async () => {
    const shell = await powershell();
    expect(await shell.run('Split-Path -Extension a.txt')).toContain("A parameter cannot be found that matches parameter name 'Extension'.");
  });

  it('splits the extension and the base name in PowerShell 7', async () => {
    const shell = await powershell('pwsh');
    expect(await shell.run('Split-Path -Extension C:\\a\\b.txt')).toBe('.txt');
    expect(await shell.run('Split-Path -LeafBase C:\\a\\b.txt')).toBe('b');
  });
});

describe('Convert-Path', () => {
  it('gives the current directory for a dot', async () => {
    const shell = await powershell();
    await shell.run('cd C:\\Windows');
    expect(await shell.run('Convert-Path .')).toBe('C:\\Windows');
  });

  it('expands a wildcard', async () => {
    const shell = await powershell();
    expect(await shell.run('Convert-Path C:\\Win*')).toBe('C:\\Windows');
  });

  it('resolves the home directory and dot-dot', async () => {
    const shell = await powershell();
    expect(await shell.run('Convert-Path ~')).toBe('C:\\Users\\User');
    expect(await shell.run('Convert-Path C:\\Windows\\..\\Users')).toBe('C:\\Users');
  });

  it('refuses a path that does not exist', async () => {
    const shell = await powershell();
    expect(await shell.run('Convert-Path nothing')).toContain("Cannot find path 'nothing' because it does not exist.");
  });
});

describe('Resolve-Path', () => {
  it('expands a wildcard under a drive root', async () => {
    const shell = await powershell();
    expect(await shell.run('(Resolve-Path C:\\Wi*).Path')).toBe('C:\\Windows');
  });

  it('gives a path relative to the current location with -Relative', async () => {
    const shell = await powershell();
    expect(await shell.run('Resolve-Path .\\Documents -Relative')).toBe('.\\Documents');
    expect(await shell.run('Resolve-Path C:\\Windows -Relative')).toBe('..\\..\\Windows');
  });
});

describe('a wildcard directly under a drive root', () => {
  it('lists the content of the matching folder', async () => {
    const shell = await powershell();
    expect(await shell.run('Get-ChildItem C:\\Wind* -Name')).toContain('System32');
  });

  it('lists the matching files', async () => {
    const shell = await powershell();
    expect(await shell.run('Get-ChildItem C:\\*.txt -Name')).toContain('nums.txt');
  });

  it('is found by Test-Path', async () => {
    const shell = await powershell();
    expect(await shell.run('Test-Path C:\\Win*')).toBe('True');
  });

  it('can be entered when it names one folder', async () => {
    const shell = await powershell();
    await shell.run('Set-Location C:\\Use*');
    expect(shell.prompt).toBe(PS('C:\\Users'));
  });

  it('refuses to be entered when it names several', async () => {
    const shell = await powershell();
    expect(await shell.run('Set-Location C:\\P*')).toContain('resolved to multiple containers');
  });

  it('dates the item Get-Item returns for a top-level folder', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows).LastWriteTime')).not.toBe('');
  });
});

describe('Get-PSDrive', () => {
  it('lists the drives in the order of their names', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-PSDrive).Name -join ","')).toBe('Alias,C,D,Env,Function,HKCU,HKLM,Variable');
  });

  it('keeps the drives of one provider', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-PSDrive -PSProvider FileSystem).Name -join ","')).toBe('C,D');
    expect(await shell.run('(Get-PSDrive -PSProvider Registry).Name -join ","')).toBe('HKCU,HKLM');
  });

  it('names the provider of every drive', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-PSDrive Env).Provider')).toBe('Environment');
    expect(await shell.run('(Get-PSDrive Alias).Provider')).toBe('Alias');
  });

  it('matches names with a wildcard and a list', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-PSDrive -Name H*).Name -join ","')).toBe('HKCU,HKLM');
    expect(await shell.run('(Get-PSDrive C, D).Name -join ","')).toBe('C,D');
  });

  it('refuses a drive that does not exist', async () => {
    const shell = await powershell();
    expect(await shell.run('Get-PSDrive Z')).toContain("Cannot find drive. A drive with the name 'Z' does not exist.");
  });

  it('refuses a provider that does not exist', async () => {
    const shell = await powershell();
    expect(await shell.run('Get-PSDrive -PSProvider Nothing')).toContain("Cannot find a provider with the name 'Nothing'.");
  });

  it('gives the current location of a file system drive relative to its root', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-PSDrive C).CurrentLocation')).toBe('Users\\User');
  });

  it('can be entered when the drive is the alias provider', async () => {
    const shell = await powershell();
    await shell.run('cd Alias:');
    expect(shell.prompt).toBe(PS('Alias:\\'));
  });
});

describe('a drive made with New-PSDrive on the file system', () => {
  async function withDrive(name = 'X'): Promise<Console> {
    const shell = await powershell();
    await shell.run(`New-PSDrive -Name ${name} -PSProvider FileSystem -Root C:\\Windows | Out-Null`);
    return shell;
  }

  it('is entered with its own name', async () => {
    const shell = await withDrive();
    await shell.run('Set-Location X:\\System32');
    expect(shell.prompt).toBe(PS('X:\\System32'));
  });

  it('is entered as a bare drive command', async () => {
    const shell = await withDrive('Proj');
    await shell.run('Proj:');
    expect(shell.prompt).toBe(PS('Proj:\\'));
  });

  it('reports both the drive path and the path it stands for', async () => {
    const shell = await withDrive();
    await shell.run('Set-Location X:\\System32');
    expect(await shell.run('(Get-Location).Path')).toBe('X:\\System32');
    expect(await shell.run('(Get-Location).ProviderPath')).toBe('C:\\Windows\\System32');
  });

  it('is read by the commands that take a path', async () => {
    const shell = await withDrive();
    expect(await shell.run('Test-Path X:\\System32\\drivers')).toBe('True');
    expect(await shell.run('Get-ChildItem X:\\ -Name | Select-Object -First 1')).toBe('Boot');
    expect(await shell.run('Get-Content X:\\System32\\drivers\\etc\\hosts | Select-Object -First 1')).toContain('Copyright');
  });

  it('lists the folder it is in when the commands take no path', async () => {
    const shell = await withDrive();
    await shell.run('Set-Location X:\\System32\\drivers');
    expect(await shell.run('Get-ChildItem -Name')).toContain('etc');
  });

  it('cannot be left upwards from its root', async () => {
    const shell = await withDrive();
    await shell.run('Set-Location X:\\System32');
    await shell.run('cd ..');
    expect(shell.prompt).toBe(PS('X:\\'));
    await shell.run('cd ..');
    expect(shell.prompt).toBe(PS('X:\\'));
  });

  it('is left by a path of another drive', async () => {
    const shell = await withDrive();
    await shell.run('Set-Location X:\\System32');
    await shell.run('Set-Location C:\\Users');
    expect(shell.prompt).toBe(PS('C:\\Users'));
  });

  it('is refused when its name is taken', async () => {
    const shell = await withDrive();
    expect(await shell.run('New-PSDrive -Name X -PSProvider FileSystem -Root C:\\Users')).toContain("A drive with the name 'X' already exists.");
    expect(await shell.run('New-PSDrive -Name C -PSProvider FileSystem -Root C:\\Users')).toContain("A drive with the name 'C' already exists.");
  });

  it('is refused when its root is not a folder', async () => {
    const shell = await powershell();
    expect(await shell.run('New-PSDrive -Name Y -PSProvider FileSystem -Root C:\\nowhere')).toContain('The specified drive root "C:\\nowhere" either does not exist, or it is not a folder.');
  });

  it('is refused when its root is a file', async () => {
    const shell = await powershell();
    await shell.run('Set-Content C:\\Users\\User\\note.txt text');
    expect(await shell.run('Test-Path C:\\Users\\User\\note.txt')).toBe('True');
    expect(await shell.run('New-PSDrive -Name Y -PSProvider FileSystem -Root C:\\Users\\User\\note.txt')).toContain('The specified drive root "C:\\Users\\User\\note.txt" either does not exist, or it is not a folder.');
  });

  it('reports the occupancy of the volume that holds its root', async () => {
    const shell = await withDrive();
    const used = await shell.run('(Get-PSDrive C).Used');
    expect(used).toMatch(/^\d+\.\d\d$/);
    expect(await shell.run('(Get-PSDrive X).Used')).toBe(used);
    expect(await shell.run('(Get-PSDrive X).Free')).toBe(await shell.run('(Get-PSDrive C).Free'));
  });

  it('gives that occupancy to the object New-PSDrive returns', async () => {
    const shell = await powershell();
    expect(await shell.run('(New-PSDrive -Name X -PSProvider FileSystem -Root C:\\Windows).Used')).toBe(await shell.run('(Get-PSDrive C).Used'));
  });

  it('is on the file system when no provider is named and its root is a path', async () => {
    const shell = await powershell();
    expect(await shell.run('(New-PSDrive -Name Win -Root C:\\Windows).Provider')).toBe('FileSystem');
    await shell.run('Set-Location Win:\\System32');
    expect(shell.prompt).toBe(PS('Win:\\System32'));
  });

  it('is gone once it is removed', async () => {
    const shell = await withDrive();
    await shell.run('Remove-PSDrive X');
    expect(await shell.run('Set-Location X:\\')).toContain("Cannot find drive. A drive with the name 'X' does not exist.");
  });
});

describe('a drive made with New-PSDrive on the registry', () => {
  it('is entered and names the key it stands for', async () => {
    const shell = await powershell();
    await shell.run('New-PSDrive -Name Soft -PSProvider Registry -Root HKLM:\\SOFTWARE | Out-Null');
    await shell.run('Set-Location Soft:\\Microsoft');
    expect(shell.prompt).toBe(PS('Soft:\\Microsoft'));
    expect(await shell.run('(Get-Location).ProviderPath')).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft');
  });
});

describe('a drive made with New-PSDrive without naming its provider', () => {
  it('is on the registry when its root is a key, and holds no occupancy', async () => {
    const shell = await powershell();
    expect(await shell.run('(New-PSDrive -Name Soft -Root HKLM:\\SOFTWARE).Provider')).toBe('Registry');
    expect(await shell.run('(Get-PSDrive Soft).Used')).toBe('');
    await shell.run('Set-Location Soft:\\Microsoft');
    expect(await shell.run('(Get-Location).ProviderPath')).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft');
  });
});

describe('Get-PSDrive -PSProvider', () => {
  it('keeps the drives of every provider named', async () => {
    const shell = await powershell();
    await shell.run('New-PSDrive -Name Soft -PSProvider Registry -Root HKLM:\\SOFTWARE | Out-Null');
    const names = (await shell.run('(Get-PSDrive -PSProvider FileSystem,Registry).Name -join ","')).split(',');
    expect(names).toContain('C');
    expect(names).toContain('Soft');
  });

  it('keeps only the drives of the provider named', async () => {
    const shell = await powershell();
    await shell.run('New-PSDrive -Name Soft -PSProvider Registry -Root HKLM:\\SOFTWARE | Out-Null');
    const names = (await shell.run('(Get-PSDrive -PSProvider Registry).Name -join ","')).split(',');
    expect(names).toContain('Soft');
    expect(names).not.toContain('C');
  });
});

describe('an object piped to a command that takes a path', () => {
  it('binds its Path property', async () => {
    const shell = await powershell();
    expect(await shell.run("[pscustomobject]@{ Path = 'C:\\Windows' } | Test-Path")).toBe('True');
    expect(await shell.run("[pscustomobject]@{ Path = 'C:\\nowhere' } | Test-Path")).toBe('False');
  });

  it('binds its PSPath property', async () => {
    const shell = await powershell();
    expect(await shell.run("[pscustomobject]@{ PSPath = 'C:\\Windows' } | Test-Path")).toBe('True');
  });

  it('binds its FullName property', async () => {
    const shell = await powershell();
    expect(await shell.run("[pscustomobject]@{ FullName = 'C:\\Windows' } | Test-Path")).toBe('True');
  });

  it('binds a file item', async () => {
    const shell = await powershell();
    expect(await shell.run('Get-Item C:\\Windows | Test-Path')).toBe('True');
    expect(await shell.run('Get-Item C:\\Windows | Split-Path -Leaf')).toBe('Windows');
  });
});

describe('a path with wildcard characters in its name', () => {
  it('is found by -LiteralPath and read as a pattern by -Path', async () => {
    const shell = await powershell();
    await shell.run("Set-Content -LiteralPath 'C:\\Users\\User\\a[1].txt' x");
    expect(await shell.run("Test-Path -LiteralPath 'C:\\Users\\User\\a[1].txt'")).toBe('True');
    expect(await shell.run("Test-Path 'C:\\Users\\User\\a[1].txt'")).toBe('False');
    expect(await shell.run("Test-Path -LiteralPath 'C:\\Users\\User\\a1.txt'")).toBe('False');
  });
});

describe('the variable $PWD and the names that look like it', () => {
  it('is read through a scope as well', async () => {
    const shell = await powershell();
    expect(await shell.run('"${global:PWD}"')).toBe('C:\\Users\\User');
    expect(await shell.run('"${script:PWD}"')).toBe('C:\\Users\\User');
  });

  it('is not the environment variable of the same name', async () => {
    const shell = await powershell();
    expect(await shell.run('"[$env:PWD]"')).toBe('[]');
    expect(await shell.run('"[$PWD]"')).toBe('[C:\\Users\\User]');
  });
});

describe('a range typed with spaces on the right of an assignment', () => {
  it('stays a range and not a command', async () => {
    const shell = await powershell();
    await shell.run('$r = 1 .. 3');
    expect(await shell.run('$r -join ","')).toBe('1,2,3');
  });
});

describe('Remove-Item reads its targets as the other path commands do', () => {
  it('removes what a listing pipes to it', async () => {
    const shell = await powershell();
    await shell.runAll('New-Item -ItemType Directory w8tmp | Out-Null', 'Set-Content w8tmp\\one.txt 1', 'Set-Content w8tmp\\two.txt 2');
    expect(await shell.run('Get-ChildItem w8tmp -Name')).toBe('one.txt\ntwo.txt');
    await shell.run('Get-ChildItem w8tmp | Remove-Item');
    expect(await shell.run('Get-ChildItem w8tmp -Name')).toBe('');
  });

  it('removes the item a piped string names', async () => {
    const shell = await powershell();
    await shell.run('Set-Content w8str.txt 1');
    await shell.run("'w8str.txt' | Remove-Item");
    expect(await shell.run('Test-Path w8str.txt')).toBe('False');
  });

  it('removes the item a piped object names by its Path property', async () => {
    const shell = await powershell();
    await shell.run('Set-Content w8obj.txt 1');
    await shell.run("[pscustomobject]@{ Path = 'w8obj.txt' } | Remove-Item");
    expect(await shell.run('Test-Path w8obj.txt')).toBe('False');
  });

  it('removes nothing when nothing is piped', async () => {
    const shell = await powershell();
    await shell.run('Set-Content w8keep.txt 1');
    await shell.run('$null | Remove-Item');
    expect(await shell.run('Test-Path w8keep.txt')).toBe('True');
  });

  it('refuses an empty path, given or piped, as the binder does', async () => {
    const shell = await powershell();
    const refusal = "Remove-Item : Cannot bind argument to parameter 'Path' because it is an empty string.";
    expect(await shell.run("Remove-Item ''")).toContain(refusal);
    expect(await shell.run("'' | Remove-Item")).toContain(refusal);
  });

  it('removes every path of an explicit list', async () => {
    const shell = await powershell();
    await shell.runAll('Set-Content w8a.txt 1', 'Set-Content w8b.txt 2');
    await shell.run('Remove-Item w8a.txt,w8b.txt');
    expect(await shell.run('Test-Path w8a.txt')).toBe('False');
    expect(await shell.run('Test-Path w8b.txt')).toBe('False');
  });
});

describe('Get-ChildItem and Get-Item take a piped path', () => {
  it('lists the folder a piped string or item names', async () => {
    const shell = await powershell();
    expect(await shell.run("'C:\\Windows\\System32\\drivers' | Get-ChildItem -Name")).toContain('etc');
    expect(await shell.run('Get-Item C:\\Windows\\System32\\drivers | Get-ChildItem -Name')).toContain('etc');
  });

  it('keeps the items that exist among the piped paths and reports the others', async () => {
    const shell = await powershell();
    const out = await shell.run("('C:\\Windows','C:\\nowhere' | Get-Item).FullName");
    expect(out).toContain('C:\\Windows');
    expect(out).toContain("Cannot find path 'C:\\nowhere' because it does not exist.");
  });
});

describe('what Get-Item returns', () => {
  it('is a single item and not a list when one item matches', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows) -is [array]')).toBe('False');
    expect(await shell.run('(Get-Item C:\\Windows\\S*) -is [array]')).toBe('True');
  });

  it('names parent, root and folder that exist', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows\\System32).Parent.Exists')).toBe('True');
    expect(await shell.run('(Get-Item C:\\Windows\\System32).Root.Exists')).toBe('True');
    expect(await shell.run('(Get-Item C:\\Windows\\System32\\drivers\\etc\\hosts).Directory.Exists')).toBe('True');
  });
});

describe('the item Get-Item and Get-ChildItem return', () => {
  it('names its parent folder', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows\\System32).Parent.FullName')).toBe('C:\\Windows');
    expect(await shell.run('(Get-Item C:\\Windows).Parent.FullName')).toBe('C:\\');
    expect(await shell.run('"$((Get-Item C:\\Windows\\System32).Parent)"')).toBe('Windows');
  });

  it('names its root', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows\\System32).Root.FullName')).toBe('C:\\');
  });

  it('names the folder of a file', async () => {
    const shell = await powershell();
    const hosts = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    expect(await shell.run(`(Get-Item ${hosts}).DirectoryName`)).toBe('C:\\Windows\\System32\\drivers\\etc');
    expect(await shell.run(`(Get-Item ${hosts}).Directory.Name`)).toBe('etc');
    expect(await shell.run(`"$((Get-Item ${hosts}).Directory)"`)).toBe('C:\\Windows\\System32\\drivers\\etc');
  });

  it('carries its provider path', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows).PSPath')).toBe('Microsoft.PowerShell.Core\\FileSystem::C:\\Windows');
    expect(await shell.run('(Get-Item C:\\Windows).PSParentPath')).toBe('Microsoft.PowerShell.Core\\FileSystem::C:\\');
    expect(await shell.run('(Get-Item C:\\Windows).PSChildName')).toBe('Windows');
  });

  it('exists and says what it is', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Windows).Exists')).toBe('True');
    expect(await shell.run('(Get-Item C:\\Windows).Attributes')).toBe('Directory');
    expect(await shell.run('(Get-Item C:\\nums.txt).Attributes')).toBe('Archive');
  });

  it('carries the full name, not the name typed', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item .\\Documents).FullName')).toBe('C:\\Users\\User\\Documents');
    expect(await shell.run('(Get-Item .).FullName')).toBe('C:\\Users\\User');
  });

  it('is found by a wildcard', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-Item C:\\Win*).FullName')).toBe('C:\\Windows');
  });

  it('keeps the same members when it comes from Get-ChildItem', async () => {
    const shell = await powershell();
    expect(await shell.run('(Get-ChildItem C:\\Windows -Directory | Select-Object -First 1).Parent.FullName')).toBe('C:\\Windows');
    expect(await shell.run('(Get-ChildItem C:\\Windows\\System32\\drivers\\etc -Name | Select-Object -First 1)')).not.toBe('');
  });
});

describe('Test-Path', () => {
  it('tells a folder from a file with -PathType', async () => {
    const shell = await powershell();
    expect(await shell.run('Test-Path C:\\Windows -PathType Container')).toBe('True');
    expect(await shell.run('Test-Path C:\\Windows -PathType Leaf')).toBe('False');
    expect(await shell.run('Test-Path C:\\nums.txt -PathType Leaf')).toBe('True');
    expect(await shell.run('Test-Path C:\\nums.txt -PathType Container')).toBe('False');
  });

  it('answers once for one path and once per path for several', async () => {
    const shell = await powershell();
    expect(await shell.run('(Test-Path C:\\Windows) -is [bool]')).toBe('True');
    expect(await shell.run('Test-Path C:\\Windows,C:\\nowhere')).toBe('True\nFalse');
    expect(await shell.run('(Test-Path C:\\Windows,C:\\nowhere).Count')).toBe('2');
    expect(await shell.run("'C:\\Windows','C:\\nowhere' | Test-Path")).toBe('True\nFalse');
  });

  it('answers False for a blank path and refuses a null one as the documentation says', async () => {
    const shell = await powershell();
    expect(await shell.run("Test-Path ' '")).toBe('False');
    expect(await shell.run("Test-Path ''")).toBe('False');
    const refusal = "Test-Path : Cannot bind argument to parameter 'Path' because it is null.";
    expect(await shell.run('Test-Path $null')).toContain(refusal);
    expect(await shell.run('Test-Path $null,$null')).toContain(refusal);
    expect(await shell.run('Test-Path @()')).toContain(refusal);
    expect(await shell.run('$null | Test-Path')).toContain(refusal);
  });

  it('judges the syntax of a path with -IsValid', async () => {
    const shell = await powershell();
    expect(await shell.run('Test-Path C:\\no\\such\\folder -IsValid')).toBe('True');
    expect(await shell.run('Test-Path "C:\\a|b" -IsValid')).toBe('False');
    expect(await shell.run('Test-Path "C:\\a<b" -IsValid')).toBe('False');
  });

  it('refuses a control character in the syntax of a path', async () => {
    const shell = await powershell();
    expect(await shell.run('Test-Path ("C:\\a" + [char]7 + "b") -IsValid')).toBe('False');
    expect(await shell.run('Test-Path ("C:\\a" + [char]32 + "b") -IsValid')).toBe('True');
  });
});

describe('a command on the right of an assignment', () => {
  it('takes a dot as its argument', async () => {
    const shell = await powershell();
    await shell.runAll('$here = Resolve-Path .', '$joined = Join-Path . x', '$ok = Test-Path .');
    expect(await shell.run('$here.Path')).toBe('C:\\Users\\User');
    expect(await shell.run('$joined')).toBe('.\\x');
    expect(await shell.run('$ok')).toBe('True');
  });

  it('takes dot-dot and a slash as its argument', async () => {
    const shell = await powershell();
    await shell.runAll('$up = Test-Path ..', '$slash = Test-Path ./');
    expect(await shell.run('$up')).toBe('True');
    expect(await shell.run('$slash')).toBe('True');
  });

  it('takes a wildcard as its argument', async () => {
    const shell = await powershell();
    await shell.run('$txt = Get-ChildItem C:\\*.txt -Name');
    expect(await shell.run('$txt.Count')).toBe('3');
  });

  it('works inside a condition', async () => {
    const shell = await powershell();
    expect(await shell.run('if (Test-Path .) { "yes" } else { "no" }')).toBe('yes');
  });
});
