/*
 * `comp` compare deux fichiers octet par octet.
 *
 * Mesure de depart : `comp a.txt b.txt` repondait « 'comp' is not recognized
 * as an internal or external command » — la commande n'existait pas, alors
 * qu'elle est livree avec Windows et que `fc` (qui existait) n'en tient pas
 * lieu : `fc` compare des LIGNES, `comp` des OCTETS et rend un decalage.
 *
 * L'AUTORITE — l'aide `comp /?` et la page comp de Microsoft, LUES DE
 * MEMOIRE (aucune transcription n'est atteignable d'ici) : « Comparing a and
 * b... », puis « Files compare OK », ou « Compare error at OFFSET n » suivi de
 * « file1 = xx » et « file2 = yy » (decalage et octets en hexadecimal ;
 * /D les donne en decimal, /A en caracteres, /L remplace le decalage par un
 * numero de ligne, /N=n borne la comparaison aux n premieres lignes, /C
 * ignore la casse), « Files are different sizes. » quand les longueurs
 * different, « 10 Mismatches - ending compare » au dixieme ecart, « Can't
 * find/open file: » pour un fichier absent, et l'invite « Compare more files
 * (Y/N) ? » en fin de passe. Codes retour : 0 identiques, 1 differents,
 * 2 fichier introuvable. Sans nom de fichier, comp demande « Name of first
 * file to compare: », « Name of second file to compare: » puis « Option(s): ».
 * L'invite est lue sur l'entree standard du scenario quand il n'y a pas de
 * fenetre ; le chemin du scenario l'ecrit AVEC un saut de ligne (meme
 * convention que `set /p`).
 *
 * Ecrite a l'aveugle, sur `executeCommand` (entree standard du scenario).
 * 13 des 14 cas tombent avant (git stash push -- src/network src/terminal
 * src/shell src/cmd). Le seul qui passe des deux cotes est un TEMOIN :
 * `fc` sur les memes fichiers, que l'ajout de `comp` ne doit pas changer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-CP');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\lab');
  fs.createFile('C:\\lab\\a.txt', 'abc\nXyz');
  fs.createFile('C:\\lab\\same.txt', 'abc\nXyz');
  fs.createFile('C:\\lab\\case.txt', 'aBc\nxyz');
  fs.createFile('C:\\lab\\long.txt', 'abcd');
  fs.createFile('C:\\lab\\zeros.txt', 'a'.repeat(30));
  fs.createFile('C:\\lab\\ones.txt', 'b'.repeat(30));
  await pc.executeCmdCommand('cd C:\\lab');
  return pc;
}

const level = async (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');

describe('identical files', () => {
  it('says so and returns 0', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('comp a.txt same.txt', 'n')).toBe(
      'Comparing a.txt and same.txt...\nFiles compare OK\n\nCompare more files (Y/N) ? ');
    expect(await level(pc)).toBe('0');
  });
});

describe('different files', () => {
  it('reports each mismatching offset in hexadecimal and returns 1', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('comp a.txt case.txt', 'n')).toBe([
      'Comparing a.txt and case.txt...',
      'Compare error at OFFSET 1', 'file1 = 62', 'file2 = 42',
      'Compare error at OFFSET 4', 'file1 = 58', 'file2 = 78',
      '', 'Compare more files (Y/N) ? ',
    ].join('\n'));
    expect(await level(pc)).toBe('1');
  });

  it('shows offsets and bytes in decimal with /D', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp a.txt case.txt /d', 'n');

    expect(out).toContain('Compare error at OFFSET 4\nfile1 = 88\nfile2 = 120');
  });

  it('shows the bytes as characters with /A', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp a.txt case.txt /a', 'n');

    expect(out).toContain('Compare error at OFFSET 1\nfile1 = b\nfile2 = B');
  });

  it('shows line numbers instead of offsets with /L', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp a.txt case.txt /l', 'n');

    expect(out).toContain('Compare error at LINE 1');
    expect(out).toContain('Compare error at LINE 2');
    expect(out).not.toContain('OFFSET');
  });

  it('ignores the case with /C', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('comp a.txt case.txt /c', 'n')).toContain('Files compare OK');
    expect(await level(pc)).toBe('0');
  });

  it('compares only the first lines with /N=1', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp a.txt case.txt /n=1', 'n');

    expect(out).toContain('Compare error at OFFSET 1');
    expect(out).not.toContain('OFFSET 4');
  });

  it('stops at the tenth mismatch', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp zeros.txt ones.txt', 'n');

    expect(out.match(/Compare error at/g)).toHaveLength(10);
    expect(out).toContain('10 Mismatches - ending compare');
  });

  it('refuses files of different sizes', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('comp a.txt long.txt', 'n')).toContain('Files are different sizes.');
    expect(await level(pc)).toBe('1');
  });
});

describe('errors', () => {
  it('names the file it cannot open and returns 2', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('comp a.txt nope.txt', 'n')).toContain("Can't find/open file: nope.txt");
    expect(await level(pc)).toBe('2');
  });

  it('refuses an unknown switch', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('comp a.txt same.txt /z', 'n')).toBe('Invalid switch - /z');
  });
});

describe('the prompts', () => {
  it('compares again when the answer to "more files" is yes', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp a.txt same.txt', 'y\na.txt\ncase.txt\n\nn');

    expect(out).toContain('Name of first file to compare: ');
    expect(out).toContain('Name of second file to compare: ');
    expect(out).toContain('Option(s): ');
    expect(out).toContain('Comparing a.txt and case.txt...');
    expect(out).toContain('Compare error at OFFSET 1');
  });

  it('asks for the file names when none is given', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('comp', 'a.txt\nsame.txt\n\nn');

    expect(out).toContain('Comparing a.txt and same.txt...');
    expect(out).toContain('Files compare OK');
  });
});

describe('witness', () => {
  it('fc still compares the same files line by line', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('fc a.txt same.txt')).toContain('FC: no differences encountered');
  });
});
