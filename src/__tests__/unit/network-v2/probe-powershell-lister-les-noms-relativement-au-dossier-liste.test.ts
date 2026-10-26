/**
 * Sonde : `Get-ChildItem -Name` ecrit le chemin de chaque element RELATIVEMENT
 * au dossier d'ou la liste est partie (`a\b\deep.txt`), et plus seulement son
 * nom (`deep.txt`) quand -Recurse descend dans des sous-dossiers.
 *
 * Mesure de depart (mandeng a 3cd85c4bb) : `Get-ChildItem -Recurse -Name` rendait
 * `a`, `top.txt`, `b`, `mid.txt`, `deep.txt` : les noms de tous les niveaux a
 * la file, si bien qu'on ne savait plus dans quel dossier se trouvait `mid.txt`
 * ni si `b` etait un sous-dossier de `a` ; le meme resultat pour un chemin
 * donne, pour une liste de chemins, pour -File et pour -Filter.
 *
 * Autorites : PowerShell 7.4.6 (tag v7.4.6), SessionStateContainer.cs
 * (GetChildNames : avec -Recurse chaque nom est le chemin relatif au conteneur
 * de depart, MakePath(prefixe, nom)) et FileSystemProvider.cs (Dir : dans un
 * dossier les sous-dossiers d'abord puis les fichiers, chacun trie par nom,
 * puis la descente dans chaque sous-dossier ; un element cache est omis sans
 * -Force).
 *
 * Sur l'arbre sans ce lot : 8 des 10 cas tombent. Passent des deux cotes,
 * tous temoins : le listage sans -Recurse (`a`, `top.txt`) et le nom d'un
 * fichier donne en entier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Console } from './_helpers/windowsConsole';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lab(): Promise<Console> {
  const console = await Console.open(new WindowsPC('windows-pc', 'WIN-NM', 0, 0));
  await console.run('powershell');
  await console.runAll(
    'New-Item -Path C:\\lab\\a\\b -ItemType Directory', 'Set-Content C:\\lab\\top.txt t', 'Set-Content C:\\lab\\a\\mid.txt m',
    'Set-Content C:\\lab\\a\\b\\deep.txt d', 'Set-Location C:\\lab',
  );
  return console;
}

const lines = async (shell: Console, line: string): Promise<string[]> => {
  const out = await shell.run(line);
  return out === '' ? [] : out.split('\n');
};

describe('Get-ChildItem -Name names each item relative to the folder the listing started from', () => {
  it('descends with the folders of each level in the name', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem -Recurse -Name')).toEqual(['a', 'top.txt', 'a\\b', 'a\\mid.txt', 'a\\b\\deep.txt']);
  });

  it('is relative to a folder that was named in full', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem C:\\lab\\a -Recurse -Name')).toEqual(['b', 'mid.txt', 'b\\deep.txt']);
  });

  it('is relative to a folder that was named relatively', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem a -Recurse -Name')).toEqual(['b', 'mid.txt', 'b\\deep.txt']);
  });

  it('is relative to each folder of a list', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem C:\\lab\\a, C:\\lab\\a\\b -Recurse -Name')).toEqual(['b', 'mid.txt', 'b\\deep.txt', 'deep.txt']);
  });

  it('keeps the folders of the path of the files that -File selects', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem -Recurse -Name -File')).toEqual(['top.txt', 'a\\mid.txt', 'a\\b\\deep.txt']);
  });

  it('keeps the folders of the path of the files that -Filter selects', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem -Recurse -Name -Filter *.txt')).toEqual(['top.txt', 'a\\mid.txt', 'a\\b\\deep.txt']);
  });

  it('is relative to the root of a drive', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem C:\\ -Recurse -Name -Filter deep.txt')).toEqual(['lab\\a\\b\\deep.txt']);
  });

  it('leaves out a hidden item and the path to it unless -Force is given', async () => {
    const shell = await lab();
    await shell.run('attrib +h a\\mid.txt');
    expect(await lines(shell, 'Get-ChildItem -Recurse -Name -File')).toEqual(['top.txt', 'a\\b\\deep.txt']);
    expect(await lines(shell, 'Get-ChildItem -Recurse -Name -File -Force')).toEqual(['top.txt', 'a\\mid.txt', 'a\\b\\deep.txt']);
  });
});

describe('the other listings do not move', () => {
  it('lists the names of one folder without -Recurse', async () => {
    const shell = await lab();
    expect(await lines(shell, 'Get-ChildItem -Name')).toEqual(['a', 'top.txt']);
  });

  it('gives a file named in full back as its name', async () => {
    const shell = await lab();
    expect(await shell.run('Get-ChildItem C:\\lab\\top.txt -Name')).toBe('top.txt');
  });
});
