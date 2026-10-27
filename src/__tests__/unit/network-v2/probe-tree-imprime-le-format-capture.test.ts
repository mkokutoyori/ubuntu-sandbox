/**
 * `tree` imprime ce que Windows imprime : un en-tete qui nomme le volume et donne son numero de serie NTFS, le chemin
 * en majuscules (ou `C:.` pour le repertoire courant), les caracteres graphiques ou ASCII selon /A, et avec /F les
 * fichiers d'un dossier AVANT ses sous-dossiers, separes par une ligne a la marge du dossier.
 *
 * Mesure de depart (6c86125ec), un WindowsPC dont le dossier `C:\Testing\Opus\V8.x\Test Folder` reproduit l'exemple de
 * Directory Opus. `tree` n'imprimait ni en-tete ni numero de serie, reprenait le chemin comme tape (`C:\Users\...`
 * au lieu de `C:\USERS\...`), ne dessinait jamais en ASCII (`/A` etait lu puis jete : le commentaire disait « already
 * default »), melangeait fichiers et dossiers dans l'ordre alphabetique avec les memes connecteurs, et ne savait pas
 * repondre a `/?`.
 *
 * Autorites. La page Microsoft Learn de `tree` ne donne que la syntaxe : ce sont des transcriptions capturees qui font
 * foi. forum.dlang.org (2008, `C:\DMD` pour un dossier installe sous `\dmd`) et resource.dopus.com/t/printtree-user-command/2432
 * (2006, `T:\TESTING\OPUS\V8.X\TEST FOLDER`) donnent l'en-tete « Folder PATH listing for volume X » puis « Volume
 * serial number is », le chemin en MAJUSCULES, les connecteurs `+---` `\---` `|   ` et, pour /F, la mise en page de
 * l'exemple 2 de Directory Opus que le cas « lists the files of a folder before its subfolders and separates the
 * blocks » reproduit ligne a ligne (fichiers a la marge du dossier, ligne de separation a espaces finals, aucune apres
 * le tout dernier bloc). essential-books.onrender.com/essential/batch/tree-f6a1e4d3145540269ec9215b579a55ba.html
 * (Windows recent, volume NTFS) donne `C:.` pour le repertoire courant, les caracteres graphiques par defaut, le
 * numero de serie NTFS « 00000177 3207:BC63 » dont la moitie basse 3207:BC63 est celle que `vol` imprime pour le
 * meme volume (3207-BC63), et le texte de `tree /?`. Les volumes FAT des captures anciennes impriment « 3071-688E » :
 * le format depend du systeme de fichiers, et tous les volumes de ce simulateur sont NTFS. La moitie haute est
 * deterministe par machine et par lecteur comme la basse, aucune capture n'en donne la regle.
 *
 * Ce qui n'est PAS fait, faute de transcription : le message d'un dossier sans sous-dossier (seul ReactOS le nomme, et
 * il ecrit « No subdirectories exist ») et le libelle exact d'un chemin invalide, qui gardent leur texte.
 *
 * Sur les 18 cas, 16 tombent avant la correction. Les 2 qui passent dans les deux etats sont des TEMOINS : « lists
 * every subfolder of the directory in alphabetical order » (le dossier lu est bien celui du laboratoire) et « names a
 * directory that does not exist » (le refus d'un chemin absent n'a pas ete perdu).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

const ROOT = 'C:\\Testing\\Opus\\V8.x\\Test Folder';

function lab(): WindowsPC {
  const machine = new WindowsPC('windows-pc', 'WIN-TREE', 0, 0);
  const fs = machine.getFileSystem();
  for (const name of ['Root File 1.txt', 'Root File 2.txt', 'Root File 3.txt']) {
    fs.mkdirp(ROOT);
    fs.createFile(`${ROOT}\\${name}`, 'x');
  }
  for (const letter of ['A', 'B', 'C']) {
    fs.mkdirp(`${ROOT}\\Folder ${letter}\\Subfolder ${letter}`);
    fs.createFile(`${ROOT}\\Folder ${letter}\\File ${letter}.txt`, 'x');
    fs.createFile(`${ROOT}\\Folder ${letter}\\Subfolder ${letter}\\Subfile ${letter}.txt`, 'x');
  }
  return machine;
}

async function body(machine: WindowsPC, command: string): Promise<string[]> {
  return (await machine.executeCommand(command)).split('\n').slice(3);
}

const SERIAL = /^Volume serial number is [0-9A-F]{8} [0-9A-F]{4}:[0-9A-F]{4}$/;

describe('tree heading', () => {
  it('names the volume and gives its serial number as an NTFS volume does', async () => {
    const machine = lab();
    const lines = (await machine.executeCommand(`tree "${ROOT}"`)).split('\n');
    expect(lines[0]).toBe('Folder PATH listing for volume Windows');
    expect(lines[1]).toMatch(SERIAL);
  });

  it('shares the low half of the serial number with dir and vol', async () => {
    const machine = lab();
    const vol = (await machine.executeCommand('vol')).match(/Volume Serial Number is ([0-9A-F]{4})-([0-9A-F]{4})/);
    const tree = (await machine.executeCommand(`tree "${ROOT}"`)).split('\n')[1];
    expect(vol).not.toBeNull();
    expect(tree.endsWith(`${vol![1]}:${vol![2]}`)).toBe(true);
  });

  it('writes the serial number of any machine as hexadecimal digits', () => {
    for (let index = 0; index < 60; index++) {
      expect(new WindowsFileSystem(`HOST-${index}`).getNtfsVolumeSerialNumber('C')).toMatch(/^[0-9A-F]{8} [0-9A-F]{4}:[0-9A-F]{4}$/);
    }
  });

  it('prints the current directory of the drive as the drive and a dot', async () => {
    const machine = lab();
    await machine.executeCommand(`cd /d "${ROOT}"`);
    expect((await machine.executeCommand('tree')).split('\n')[2]).toBe('C:.');
  });

  it('prints the full path of an explicit directory in upper case', async () => {
    const machine = lab();
    expect((await machine.executeCommand(`tree "${ROOT}"`)).split('\n')[2]).toBe('C:\\TESTING\\OPUS\\V8.X\\TEST FOLDER');
  });

  it('resolves a relative directory before printing it', async () => {
    const machine = lab();
    await machine.executeCommand('cd /d C:\\Testing\\Opus');
    expect((await machine.executeCommand('tree "V8.x\\Test Folder"')).split('\n')[2]).toBe('C:\\TESTING\\OPUS\\V8.X\\TEST FOLDER');
  });

  it('prints a drive root with its backslash', async () => {
    const machine = lab();
    expect((await machine.executeCommand('tree C:\\ /A')).split('\n')[2]).toBe('C:\\');
  });
});

describe('tree glyphs', () => {
  it('draws extended characters by default', async () => {
    const machine = lab();
    expect(await body(machine, `tree "${ROOT}"`)).toEqual([
      '├───Folder A',
      '│   └───Subfolder A',
      '├───Folder B',
      '│   └───Subfolder B',
      '└───Folder C',
      '    └───Subfolder C',
    ]);
  });

  it('draws ASCII characters with /A', async () => {
    const machine = lab();
    expect(await body(machine, `tree "${ROOT}" /A`)).toEqual([
      '+---Folder A',
      '|   \\---Subfolder A',
      '+---Folder B',
      '|   \\---Subfolder B',
      '\\---Folder C',
      '    \\---Subfolder C',
    ]);
  });

  it('accepts the switches before the path', async () => {
    const machine = lab();
    expect(await body(machine, `tree /A "${ROOT}"`)).toContain('\\---Folder C');
  });
});

describe('tree /F', () => {
  it('lists the files of a folder before its subfolders and separates the blocks', async () => {
    const machine = lab();
    expect(await body(machine, `tree "${ROOT}" /F /A`)).toEqual([
      '|   Root File 1.txt',
      '|   Root File 2.txt',
      '|   Root File 3.txt',
      '|   ',
      '+---Folder A',
      '|   |   File A.txt',
      '|   |   ',
      '|   \\---Subfolder A',
      '|           Subfile A.txt',
      '|           ',
      '+---Folder B',
      '|   |   File B.txt',
      '|   |   ',
      '|   \\---Subfolder B',
      '|           Subfile B.txt',
      '|           ',
      '\\---Folder C',
      '    |   File C.txt',
      '    |   ',
      '    \\---Subfolder C',
      '            Subfile C.txt',
    ]);
  });

  it('uses the extended characters for the bar of a folder that has files and subfolders', async () => {
    const machine = lab();
    const lines = await body(machine, `tree "${ROOT}" /F`);
    expect(lines.slice(0, 5)).toEqual(['│   Root File 1.txt', '│   Root File 2.txt', '│   Root File 3.txt', '│   ', '├───Folder A']);
  });

  it('puts no separator after the very last block', async () => {
    const machine = lab();
    const lines = await body(machine, `tree "${ROOT}" /F /A`);
    expect(lines[lines.length - 1]).toBe('            Subfile C.txt');
  });

  it('prints no separator after a folder that holds no files', async () => {
    const machine = new WindowsPC('windows-pc', 'WIN-TREE', 0, 0);
    const fs = machine.getFileSystem();
    fs.mkdirp('C:\\Lab\\Empty');
    fs.mkdirp('C:\\Lab\\Nested\\Inner');
    fs.createFile('C:\\Lab\\Nested\\Inner\\i.txt', 'x');
    fs.mkdirp('C:\\Lab\\Data');
    fs.createFile('C:\\Lab\\Data\\d.txt', 'x');
    expect(await body(machine, 'tree C:\\Lab /F /A')).toEqual([
      '+---Data',
      '|       d.txt',
      '|       ',
      '+---Empty',
      '\\---Nested',
      '    \\---Inner',
      '            i.txt',
    ]);
  });

  it('indents the files of a folder without subfolders by one level', async () => {
    const machine = lab();
    const lines = await body(machine, `tree "${ROOT}\\Folder A\\Subfolder A" /F /A`);
    expect(lines).toEqual(['    Subfile A.txt']);
  });
});

describe('tree help', () => {
  it('prints the usage with /?', async () => {
    const machine = lab();
    expect(await machine.executeCommand('tree /?')).toBe([
      'Graphically displays the folder structure of a drive or path.',
      '',
      'TREE [drive:][path] [/F] [/A]',
      '',
      '   /F   Display the names of the files in each folder.',
      '   /A   Use ASCII instead of extended characters.',
    ].join('\n'));
  });
});

describe('tree witnesses', () => {
  it('lists every subfolder of the directory in alphabetical order', async () => {
    const machine = lab();
    const out = await machine.executeCommand(`tree "${ROOT}"`);
    const folders = out.split('\n').filter(line => /Folder [ABC]$/.test(line)).map(line => line.slice(-8));
    expect(folders).toEqual(['Folder A', 'Folder B', 'Folder C']);
  });

  it('names a directory that does not exist', async () => {
    const machine = lab();
    expect(await machine.executeCommand('tree C:\\nonexistent')).toContain('Invalid path');
  });
});
