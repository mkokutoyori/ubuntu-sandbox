/**
 * Sonde : un chemin absent est rapporte par son chemin ABSOLU, avec la meme
 * erreur (ItemNotFoundException / PathNotFound / ObjectNotFound) quelle que
 * soit la commande, et un lecteur absent par DriveNotFoundException.
 *
 * Mesure de depart (W14 + W16, avant ce lot) : `cd nope`, `Push-Location
 * nope`, `cat nope`, `Clear-Content nope`, `Get-Acl nope`, `Resolve-Path
 * nope`, `Convert-Path nope`, `Split-Path nope -Resolve`,
 * `Get-AuthenticodeSignature nope` repondaient « Cannot find path 'nope' »
 * (le chemin tel que tape) ; `Get-FileHash nope` repondait « Could not find
 * file '<absolu>'. » ; `cd Z:\x` ecrivait un message de lecteur sans
 * DriveNotFoundException ni DriveNotFound dans la categorie ; une vingtaine de
 * constructions a la main du meme texte.
 *
 * Autorites : PowerShell 7.4.6 (tag v7.4.6), LocationGlobber.cs
 * (ExpandMshGlobPath : un chemin sans joker qui n'existe pas leve
 * ItemNotFoundException avec le chemin qualifie par le lecteur, resolu depuis
 * l'emplacement courant ; GetGlobbedProviderPathsFromProviderPath : le chemin
 * du fournisseur), SessionStateLocationAPIs.cs (SetLocation : un chemin qui
 * existe mais n'est pas un conteneur leve avec le chemin TEL QUE TAPE, comme
 * une absence de correspondance a un joker), SessionStateStrings.resx
 * (PathNotFound, DriveNotFound), Navigation.cs ; `cd -` est un chemin de ce
 * nom sous Windows PowerShell 5.1 (l'historique d'emplacements est une
 * fonction de PowerShell 7).
 *
 * Sur l'arbre sans ce lot : 16 des 23 cas tombent. Passent des deux cotes,
 * tous temoins : `Get-Item` et `ls` (qui disaient deja le chemin absolu), un
 * chemin absolu tape en entier, le chemin tel que tape quand le chemin
 * existe mais n'est pas un dossier, un joker sans correspondance, les
 * dossiers de HKCU: et de Env: (deja qualifies par leur lecteur) et le
 * lecteur absent sous PowerShell 7 dont le texte etait deja le bon.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const HOME = 'C:\\Users\\User';

function shellFor(language: 'desktop' | 'core'): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc, { language }).subShell;
}

async function run(sub: PowerShellSubShell, line: string): Promise<string[]> {
  return (await sub.processLine(line)).output;
}

describe('a missing path is reported by its absolute path', () => {
  it.each([
    ['cd nope', 'cd', 'Set-Location'],
    ['Set-Location nope', 'Set-Location', 'Set-Location'],
    ['Push-Location nope', 'Push-Location', 'Push-Location'],
    ['cat nope', 'cat', 'Get-Content'],
    ['Get-Content nope', 'Get-Content', 'Get-Content'],
    ['Get-Item nope', 'Get-Item', 'Get-Item'],
    ['ls nope', 'ls', 'Get-ChildItem'],
    ['Clear-Content nope', 'Clear-Content', 'Clear-Content'],
    ['Get-Acl nope', 'Get-Acl', 'Get-Acl'],
    ['Resolve-Path nope', 'Resolve-Path', 'Resolve-Path'],
    ['Convert-Path nope', 'Convert-Path', 'Convert-Path'],
    ['Split-Path nope -Resolve', 'Split-Path', 'Split-Path'],
    ['Get-FileHash nope', 'Get-FileHash', 'Get-FileHash'],
    ['Get-AuthenticodeSignature nope', 'Get-AuthenticodeSignature', 'Get-AuthenticodeSignature'],
  ])('%s', async (line, typed, cmdlet) => {
    const out = await run(shellFor('desktop'), line);
    expect(out[0]).toBe(`${typed} : Cannot find path '${HOME}\\nope' because it does not exist.`);
    expect(out[1]).toContain(`ObjectNotFound: (${HOME}\\nope:String) [${cmdlet}], ItemNotFoundException`);
    expect(out[2]).toBe(`    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.${cmdlet.replace('-', '')}Command`);
  });

  it('resolves the missing name against the current location, not the home', async () => {
    const sub = shellFor('desktop');
    await run(sub, 'cd C:\\Windows');
    expect((await run(sub, 'cd nope'))[0]).toBe("cd : Cannot find path 'C:\\Windows\\nope' because it does not exist.");
    expect((await run(sub, 'cd ..\\nope'))[0]).toBe("cd : Cannot find path 'C:\\nope' because it does not exist.");
    expect((await run(sub, 'cd .\\a\\b'))[0]).toBe("cd : Cannot find path 'C:\\Windows\\a\\b' because it does not exist.");
  });

  it('keeps an absolute path as it was typed', async () => {
    const out = await run(shellFor('desktop'), 'Get-Item C:\\Users\\nope');
    expect(out[0]).toBe("Get-Item : Cannot find path 'C:\\Users\\nope' because it does not exist.");
  });

  it('reads cd - as a path of that name', async () => {
    const out = await run(shellFor('desktop'), 'cd -');
    expect(out[0]).toBe(`cd : Cannot find path '${HOME}\\-' because it does not exist.`);
  });

  it('names a file that exists but is not a container as it was typed', async () => {
    const sub = shellFor('desktop');
    await run(sub, "Set-Content afile.txt 'x'");
    expect((await run(sub, 'cd afile.txt'))[0]).toBe("cd : Cannot find path 'afile.txt' because it does not exist.");
  });

  it('names a wildcard that matches nothing as it was typed', async () => {
    expect((await run(shellFor('desktop'), 'cd nope*'))[0]).toBe("cd : Cannot find path 'nope*' because it does not exist.");
  });

  it('keeps the drive-qualified path of a provider that is not the file system', async () => {
    const sub = shellFor('desktop');
    expect((await run(sub, 'cd HKCU:\\nope'))[0]).toBe("cd : Cannot find path 'HKCU:\\nope' because it does not exist.");
    expect((await run(sub, 'cd Env:\\nope'))[0]).toBe("cd : Cannot find path 'Env:\\nope' because it does not exist.");
  });

  it('keeps the absolute path under PowerShell 7 too', async () => {
    const out = await run(shellFor('core'), 'cd nope');
    expect(out).toEqual([`Set-Location: Cannot find path '${HOME}\\nope' because it does not exist.`]);
  });
});

describe('a missing drive is a DriveNotFoundException', () => {
  it('names the drive and records the exception', async () => {
    const out = await run(shellFor('desktop'), 'cd Z:\\x');
    expect(out[0]).toBe("cd : Cannot find drive. A drive with the name 'Z' does not exist.");
    expect(out[1]).toContain('ObjectNotFound: (Z:String) [Set-Location], DriveNotFoundException');
    expect(out[2]).toBe('    + FullyQualifiedErrorId : DriveNotFound,Microsoft.PowerShell.Commands.SetLocationCommand');
  });

  it('says the same under PowerShell 7', async () => {
    const out = await run(shellFor('core'), 'cd Z:\\x');
    expect(out).toEqual(["Set-Location: Cannot find drive. A drive with the name 'Z' does not exist."]);
  });
});
