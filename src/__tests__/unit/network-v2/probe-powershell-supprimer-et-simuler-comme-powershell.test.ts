/**
 * Sonde : Remove-Item suit RemoveItemCommand et le fournisseur de systeme de
 * fichiers, et -WhatIf est evalue par les commandes qui ecrivent au lieu
 * d'etre ignore.
 *
 * Mesure de depart (W14 + W16, avant ce lot) : `Remove-Item f -WhatIf`
 * SUPPRIMAIT le fichier (le parametre n'etait pas declare, donc jete), de
 * meme `New-Item f -WhatIf` et `Set-Content f x -WhatIf` creaient le fichier ;
 * un fichier en lecture seule ou cache etait supprime sans -Force ;
 * `Remove-Item * -Include *.log` et `-Exclude` etaient declares et jamais lus
 * (tout etait supprime) ; `Remove-Item <dossier courant> -Recurse` supprimait
 * les enfants puis repondait « The process cannot access the file because it
 * is being used by another process. » ; un joker sans correspondance repondait
 * avec les mots de cmd.
 *
 * Autorites : PowerShell 7.4.6 (tag v7.4.6) - Navigation.cs
 * (RemoveItemCommand : le chemin est resolu par le globber, qui filtre par
 * Include/Exclude/Filter hors -Recurse et ne leve rien pour un joker sans
 * correspondance ; IsCurrentLocationOrAncestor -> RemoveItemInUse avant toute
 * suppression), SessionStateContainer.cs (RemoveItem : ProcessPathItems
 * parcourt l'arbre pour -Recurse avec Include/Exclude), FileSystemProvider.cs
 * (RemoveFileSystemItem : un element cache, systeme ou en lecture seule sans
 * -Force -> PermissionError / RemoveFileSystemItemUnAuthorizedAccess ;
 * RemoveDirectoryInfoItem : ShouldProcess du dossier racine, puis des
 * enfants si -Recurse ; DirectoryNotEmpty), FileSystemProviderStrings.resx,
 * NavigationResources.resx (RemoveItemInUse, SetContentAction/Target...),
 * RegistryProviderStrings.resx, SessionStateProviderBaseStrings.resx pour les
 * actions et cibles de -WhatIf (« Remove File », « Item: ... Destination:
 * ... »...).
 *
 * Sur l'arbre sans ce lot : 20 des 24 cas tombent. Passent des deux cotes,
 * tous temoins : la suppression simple d'un fichier et d'un dossier vide, la
 * suppression recursive d'un dossier, le tube vers Remove-Item et la
 * suppression d'un fichier du dossier au-dessus de l'emplacement courant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function powershell(): Promise<Console> {
  const shell = await Console.open(new WindowsPC('windows-pc', 'WIN-RM', 0, 0));
  await shell.run('powershell');
  return shell;
}

async function lab(): Promise<Console> {
  const shell = await powershell();
  await shell.runAll(
    'New-Item -Name t -ItemType Directory',
    'Set-Content t\\a.txt one', 'Set-Content t\\b.txt two', 'Set-Content t\\c.log three',
    'New-Item -Path t -Name sub -ItemType Directory', 'Set-Content t\\sub\\d.txt four', 'Set-Content t\\sub\\e.log five',
  );
  return shell;
}

const names = async (shell: Console, folder = 't'): Promise<string[]> => {
  const out = await shell.run(`Get-ChildItem ${folder} -Force -Name`);
  return out === '' ? [] : out.split('\n').sort((left, right) => left.localeCompare(right));
};

const HERE = 'C:\\Users\\User\\t';

describe('Remove-Item removes what the provider would remove', () => {
  it('removes a file and a folder and says nothing', async () => {
    const shell = await lab();
    expect(await shell.run('Remove-Item t\\a.txt')).toBe('');
    await shell.run('New-Item -Path t -Name empty -ItemType Directory');
    expect(await shell.run('Remove-Item t\\empty')).toBe('');
    expect(await names(shell)).toEqual(['b.txt', 'c.log', 'sub']);
  });

  it('removes a whole folder with -Recurse', async () => {
    const shell = await lab();
    await shell.run('Remove-Item t\\sub -Recurse');
    expect(await names(shell)).toEqual(['a.txt', 'b.txt', 'c.log']);
  });

  it('removes every item that reaches it through the pipeline', async () => {
    const shell = await lab();
    await shell.run('Get-ChildItem t\\*.txt | Remove-Item');
    expect(await names(shell)).toEqual(['c.log', 'sub']);
  });

  it('says nothing and removes nothing for a wildcard that matches nothing', async () => {
    const shell = await lab();
    expect(await shell.run('Remove-Item t\\nope*')).toBe('');
    expect(await names(shell)).toEqual(['a.txt', 'b.txt', 'c.log', 'sub']);
  });

  it('keeps the items -Exclude names and removes the others of a wildcard', async () => {
    const shell = await lab();
    await shell.run('Remove-Item t\\*.txt -Exclude a*');
    expect(await names(shell)).toEqual(['a.txt', 'c.log', 'sub']);
  });

  it('removes only the items -Include names', async () => {
    const shell = await lab();
    await shell.run('Remove-Item t\\* -Include *.log');
    expect(await names(shell)).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('removes only the items -Filter names', async () => {
    const shell = await lab();
    await shell.run('Remove-Item t\\* -Filter *.txt');
    expect(await names(shell)).toEqual(['c.log', 'sub']);
  });

  it('removes the matching files of the whole tree with -Recurse -Include and keeps the others', async () => {
    const shell = await lab();
    await shell.run('Remove-Item t -Recurse -Include *.log');
    expect(await names(shell)).toEqual(['a.txt', 'b.txt', 'sub']);
    expect(await names(shell, 't\\sub')).toEqual(['d.txt']);
  });

  it('removes a folder that -Include names together with everything in it', async () => {
    const shell = await lab();
    await shell.run('Remove-Item t -Recurse -Include sub');
    expect(await shell.run('Test-Path t\\sub')).toBe('False');
    expect(await names(shell)).toEqual(['a.txt', 'b.txt', 'c.log']);
  });

  it('removes the files -Filter names in the whole tree and keeps the folders that still hold files', async () => {
    const shell = await lab();
    const out = await shell.run('Remove-Item t\\sub -Recurse -Filter *.log');
    expect(out).toContain(`Directory ${HERE}\\sub cannot be removed because it is not empty.`);
    expect(await names(shell, 't\\sub')).toEqual(['d.txt']);
  });
});

describe('Remove-Item refuses what is in use', () => {
  it('refuses the current folder and removes nothing', async () => {
    const shell = await lab();
    await shell.run('Set-Location t');
    const out = await shell.run('Remove-Item . -Recurse');
    expect(out).toContain(`Remove-Item : Cannot remove the item at '${HERE}' because it is in use.`);
    expect(out).toContain('InvalidOperation: (:) [Remove-Item], PSInvalidOperationException');
    expect(out).toContain('FullyQualifiedErrorId : InvalidOperation,Microsoft.PowerShell.Commands.RemoveItemCommand');
    expect(await names(shell, '.')).toEqual(['a.txt', 'b.txt', 'c.log', 'sub']);
  });

  it('refuses a folder above the current one and removes nothing', async () => {
    const shell = await lab();
    await shell.run('Set-Location t\\sub');
    const out = await shell.run('Remove-Item ..\\.. -Recurse');
    expect(out).toContain("Cannot remove the item at 'C:\\Users\\User' because it is in use.");
    expect(await shell.run('Test-Path ..\\a.txt')).toBe('True');
  });

  it('removes a file of the folder above the current one', async () => {
    const shell = await lab();
    await shell.run('Set-Location t\\sub');
    expect(await shell.run('Remove-Item ..\\a.txt')).toBe('');
    expect(await shell.run('Test-Path ..\\a.txt')).toBe('False');
  });
});

describe('Remove-Item needs -Force for a hidden, system or read-only item', () => {
  it.each(['+r', '+h', '+s'])('refuses attrib %s and removes with -Force', async (flag) => {
    const shell = await lab();
    await shell.run(`attrib ${flag} t\\a.txt`);
    const out = await shell.run('Remove-Item t\\a.txt');
    expect(out).toContain(`Remove-Item : Cannot remove item ${HERE}\\a.txt: You do not have sufficient access rights to perform this operation or the item is hidden, system, or read only.`);
    expect(out).toContain('PermissionDenied');
    expect(out).toContain('RemoveFileSystemItemUnAuthorizedAccess,Microsoft.PowerShell.Commands.RemoveItemCommand');
    expect(await shell.run('Test-Path t\\a.txt')).toBe('True');
    expect(await shell.run('Remove-Item t\\a.txt -Force')).toBe('');
    expect(await shell.run('Test-Path t\\a.txt')).toBe('False');
  });

  it('removes the unprotected files of a tree, names the protected one and keeps its folders', async () => {
    const shell = await lab();
    await shell.run('attrib +r t\\sub\\d.txt');
    const out = await shell.run('Remove-Item t\\sub -Recurse');
    expect(out).toContain(`Cannot remove item ${HERE}\\sub\\d.txt:`);
    expect(out).toContain(`Directory ${HERE}\\sub cannot be removed because it is not empty.`);
    expect(await names(shell, 't\\sub')).toEqual(['d.txt']);
    await shell.run('Remove-Item t\\sub -Recurse -Force');
    expect(await shell.run('Test-Path t\\sub')).toBe('False');
  });
});

describe('-WhatIf says what would happen and does nothing', () => {
  it('Remove-Item names the file', async () => {
    const shell = await lab();
    const out = await shell.run('Remove-Item t\\a.txt -WhatIf');
    expect(out).toBe(`What if: Performing the operation "Remove File" on target "${HERE}\\a.txt".`);
    expect(await shell.run('Test-Path t\\a.txt')).toBe('True');
  });

  it('Remove-Item -Recurse names the folder it starts with and removes nothing', async () => {
    const shell = await lab();
    const out = await shell.run('Remove-Item t\\sub -Recurse -WhatIf');
    expect(out).toBe(`What if: Performing the operation "Remove Directory" on target "${HERE}\\sub".`);
    expect(await names(shell, 't\\sub')).toEqual(['d.txt', 'e.log']);
  });

  it('is obeyed through $WhatIfPreference as well', async () => {
    const shell = await lab();
    await shell.run('$WhatIfPreference = $true');
    expect(await shell.run('Remove-Item t\\a.txt')).toContain('What if: Performing the operation "Remove File"');
    await shell.run('$WhatIfPreference = $false');
    await shell.run('Remove-Item t\\a.txt');
    expect(await shell.run('Test-Path t\\a.txt')).toBe('False');
  });

  it('New-Item creates nothing', async () => {
    const shell = await lab();
    expect(await shell.run('New-Item t\\f.txt -WhatIf')).toBe(`What if: Performing the operation "Create File" on target "Destination: ${HERE}\\f.txt".`);
    expect(await shell.run('New-Item t\\d -ItemType Directory -WhatIf')).toBe(`What if: Performing the operation "Create Directory" on target "Destination: ${HERE}\\d".`);
    expect(await shell.run('mkdir t\\md -WhatIf')).toBe(`What if: Performing the operation "Create Directory" on target "Destination: ${HERE}\\md".`);
    expect(await shell.run('Test-Path t\\f.txt, t\\d, t\\md')).toBe('False\nFalse\nFalse');
  });

  it('Set-Content, Add-Content and Clear-Content change nothing', async () => {
    const shell = await lab();
    expect(await shell.run('Set-Content t\\a.txt changed -WhatIf')).toBe(`What if: Performing the operation "Set Content" on target "Path: ${HERE}\\a.txt".`);
    expect(await shell.run('Add-Content t\\a.txt more -WhatIf')).toBe(`What if: Performing the operation "Add Content" on target "Path: ${HERE}\\a.txt".`);
    expect(await shell.run('Clear-Content t\\a.txt -WhatIf')).toBe(`What if: Performing the operation "Clear Content" on target "Item: ${HERE}\\a.txt".`);
    expect(await shell.run('Get-Content t\\a.txt')).toBe('one');
  });

  it('Move-Item, Rename-Item and Copy-Item change nothing', async () => {
    const shell = await lab();
    expect(await shell.run('Move-Item t\\a.txt t\\moved.txt -WhatIf')).toBe(`What if: Performing the operation "Move File" on target "Item: ${HERE}\\a.txt Destination: ${HERE}\\moved.txt".`);
    expect(await shell.run('Rename-Item t\\b.txt renamed.txt -WhatIf')).toBe(`What if: Performing the operation "Rename File" on target "Item: ${HERE}\\b.txt Destination: ${HERE}\\renamed.txt".`);
    expect(await shell.run('Copy-Item t\\c.log t\\copied.log -WhatIf')).toBe(`What if: Performing the operation "Copy File" on target "Item: ${HERE}\\c.log Destination: ${HERE}\\copied.log".`);
    expect(await shell.run('Move-Item t\\sub t\\moved -WhatIf')).toContain('"Move Directory"');
    expect(await names(shell)).toEqual(['a.txt', 'b.txt', 'c.log', 'sub']);
  });

  it('names the provider action for an environment variable and a registry key', async () => {
    const shell = await powershell();
    await shell.run('Set-Item Env:WI_ONE 1');
    expect(await shell.run('Remove-Item Env:WI_ONE -WhatIf')).toBe('What if: Performing the operation "Remove Item" on target "Item: WI_ONE".');
    expect(await shell.run('$env:WI_ONE')).toBe('1');
    await shell.run('New-Item HKCU:\\Software\\WiKey');
    expect(await shell.run('Remove-Item HKCU:\\Software\\WiKey -WhatIf')).toBe('What if: Performing the operation "Remove Key" on target "Item: HKEY_CURRENT_USER\\Software\\WiKey".');
    expect(await shell.run('Test-Path HKCU:\\Software\\WiKey')).toBe('True');
    expect(await shell.run('New-Item HKCU:\\Software\\WiOther -WhatIf')).toBe('What if: Performing the operation "New Item" on target "Item: HKEY_CURRENT_USER\\Software\\WiOther".');
    expect(await shell.run('Test-Path HKCU:\\Software\\WiOther')).toBe('False');
  });
});
