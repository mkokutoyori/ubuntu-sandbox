/*
 * `copy` et `move` : dates conservees, jokers, `+`, et la question avant
 * d'ecraser.
 *
 * Mesure de depart : `copy a.txt b.txt` donnait a b.txt la date DU JOUR (la
 * copie recreait le fichier) ; `copy *.txt dest` repondait « The system cannot
 * find the file specified. » ; `copy /y a b` prenait `/y` pour un nom de
 * fichier ; `copy a.txt a.txt` « copiait » en silence ; `a+b` n'etait pas
 * reconnu ; un fichier cache perdait son attribut ; `move` recreait lui aussi
 * le fichier (date, attributs perdus) et ne savait deplacer ni un dossier
 * ni plusieurs fichiers, et aucun des deux ne demandait jamais confirmation
 * avant d'ecraser.
 *
 * L'AUTORITE — l'aide `copy /?` et `move /?` de cmd, LUES DE MEMOIRE (aucune
 * transcription n'est atteignable d'ici) : la copie garde l'heure de derniere
 * ecriture de la source et ses attributs (le bit archive est pose) ; un joker
 * fait ecrire chaque nom, puis « N file(s) copied. » ; plusieurs sources (`+`
 * ou joker) vers un FICHIER sont concatenees ; « The file cannot be copied
 * onto itself. » ; /Y supprime, /-Y impose la question « Overwrite X?
 * (Yes/No/All): », que COPYCMD peut pre-regler et qui est supprimee par
 * defaut dans un script (« unless the COPY command is being executed from
 * within a batch script »). `move` ecrit la meme question, « N file(s)
 * moved. », « N dir(s) moved. » pour un dossier, et refuse « Cannot move
 * multiple files to a single file. ». Les commutateurs /V /N /Z /L /D de
 * copy sont acceptes sans effet (verification, noms courts, mode
 * redemarrable, liens, dechiffrement : rien de tout cela n'existe dans ce
 * systeme de fichiers) — c'est ce que fait un vrai cmd quand l'option est
 * sans objet.
 * La question est lue sur l'entree standard du scenario ; le code retour de
 * la reponse « No » n'est pas atteste d'ici (le simulateur rend 0).
 *
 * Ecrite a l'aveugle, sur `executeCommand` (entree standard du scenario).
 * 25 des 32 cas tombent avant (git stash push -- src/network src/cmd). Les 7
 * qui passent des deux cotes : quatre TEMOINS de non-regression (copie
 * simple, deplacement dans un dossier, source absente de copy et de move),
 * et trois qui passent par ABSENCE — « Yes », COPYCMD=/Y et le script ne
 * demandaient rien avant non plus, donc ils ecrasaient trivialement ; ils
 * gardent la garantie apres le correctif, ou la question existe.
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

const OLD = new Date('2020-01-02T03:04:00Z');

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-CM');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\src\\sub');
  fs.mkdirp('C:\\dst');
  fs.createFile('C:\\src\\a.txt', 'abc');
  fs.createFile('C:\\src\\b.txt', 'hello');
  fs.createFile('C:\\src\\c.log', 'log');
  fs.createFile('C:\\src\\sub\\deep.txt', 'deep');
  const a = fs.resolve('C:\\src\\a.txt')!;
  a.mtime = new Date(OLD);
  a.attributes.add('hidden');
  await pc.executeCmdCommand('cd C:\\');
  return pc;
}

const level = (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');

describe('a copied file keeps what the source had', () => {
  it('keeps the last write time', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\a.txt C:\\a2.txt');

    expect(pc.getFileSystem().resolve('C:\\a2.txt')!.mtime.getTime()).toBe(OLD.getTime());
  });

  it('keeps the hidden attribute and sets the archive bit', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\a.txt C:\\a2.txt');
    const attributes = pc.getFileSystem().resolve('C:\\a2.txt')!.attributes;

    expect(attributes.has('hidden')).toBe(true);
    expect(attributes.has('archive')).toBe(true);
  });

  it('keeps the time for PowerShell Copy-Item too, since one filesystem serves both', async () => {
    const pc = await lab();
    await pc.executeCommand('powershell -Command "Copy-Item C:\\src\\a.txt C:\\a3.txt"');

    expect(pc.getFileSystem().resolve('C:\\a3.txt')!.mtime.getTime()).toBe(OLD.getTime());
  });

  it('is a plain copy for an ordinary file', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy src\\b.txt C:\\b2.txt')).toBe('        1 file(s) copied.');
    expect(pc.getFileSystem().readFile('C:\\b2.txt').content).toBe('hello');
  });
});

describe('copy with wildcards and directories', () => {
  it('writes each name, then the count', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy src\\*.txt C:\\dst')).toBe('src\\a.txt\nsrc\\b.txt\n        2 file(s) copied.');
    expect(pc.getFileSystem().exists('C:\\dst\\b.txt')).toBe(true);
  });

  it('treats *.* as every name', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('copy src\\*.* C:\\dst');

    expect(out.endsWith('        3 file(s) copied.')).toBe(true);
  });

  it('copies the files of a directory used as a source', async () => {
    const pc = await lab();

    expect((await pc.executeCommand('copy src C:\\dst')).endsWith('        3 file(s) copied.')).toBe(true);
    expect(pc.getFileSystem().exists('C:\\dst\\sub')).toBe(false);
  });

  it('reports a missing parent directory', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy src\\a.txt C:\\nowhere\\')).toBe('The system cannot find the path specified.');
  });
});

describe('copy with +', () => {
  it('concatenates the sources into the destination', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy src\\a.txt+src\\b.txt C:\\cat.txt')).toBe('src\\a.txt\nsrc\\b.txt\n        1 file(s) copied.');
    expect(pc.getFileSystem().readFile('C:\\cat.txt').content).toContain('abchello');
  });

  it('concatenates a wildcard into a single file', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('copy src\\*.txt C:\\all.txt');

    expect(out.endsWith('        1 file(s) copied.')).toBe(true);
    expect(pc.getFileSystem().readFile('C:\\all.txt').content).toContain('abchello');
  });

  it('adds a Ctrl-Z in ASCII mode and none with /B', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\a.txt+src\\b.txt C:\\ascii.txt');
    await pc.executeCommand('copy /b src\\a.txt+src\\b.txt C:\\binary.txt');

    expect(pc.getFileSystem().readFile('C:\\ascii.txt').content!.endsWith('\u001a')).toBe(true);
    expect(pc.getFileSystem().readFile('C:\\binary.txt').content).toBe('abchello');
  });
});

describe('the overwrite question', () => {
  it('is asked on stdin when the destination exists', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');
    const out = await pc.executeCommand('copy src\\a.txt C:\\dst\\x.txt', 'n');

    expect(out).toContain('Overwrite C:\\dst\\x.txt? (Yes/No/All): ');
  });

  it('keeps the destination on No', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');
    const out = await pc.executeCommand('copy src\\a.txt C:\\dst\\x.txt', 'n');

    expect(out.endsWith('        0 file(s) copied.')).toBe(true);
    expect(pc.getFileSystem().readFile('C:\\dst\\x.txt').content).toBe('hello');
  });

  it('overwrites on Yes', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');
    await pc.executeCommand('copy src\\a.txt C:\\dst\\x.txt', 'y');

    expect(pc.getFileSystem().readFile('C:\\dst\\x.txt').content).toBe('abc');
  });

  it('asks once more per file until All', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\*.txt C:\\dst');
    const out = await pc.executeCommand('copy src\\*.txt C:\\dst', 'a');

    expect(out.match(/Overwrite /g)).toHaveLength(1);
    expect(out.endsWith('        2 file(s) copied.')).toBe(true);
  });

  it('is not asked with /Y', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');

    expect(await pc.executeCommand('copy /y src\\a.txt C:\\dst\\x.txt')).toBe('        1 file(s) copied.');
  });

  it('is not asked when COPYCMD holds /Y', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set COPYCMD=/Y');
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');

    expect(await pc.executeCommand('copy src\\a.txt C:\\dst\\x.txt')).toBe('        1 file(s) copied.');
  });

  it('is not asked inside a batch script', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\run.bat', '@echo off\r\ncopy src\\b.txt C:\\dst\\x.txt\r\ncopy src\\a.txt C:\\dst\\x.txt\r\n');

    expect(await pc.executeCommand('C:\\run.bat')).toBe('        1 file(s) copied.\n        1 file(s) copied.');
  });

  it('is asked inside a batch script with /-Y', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\run.bat', '@echo off\r\ncopy src\\b.txt C:\\dst\\x.txt\r\ncopy /-y src\\a.txt C:\\dst\\x.txt\r\n');

    expect(await pc.executeCommand('C:\\run.bat', 'n')).toContain('Overwrite C:\\dst\\x.txt? (Yes/No/All): ');
  });
});

describe('copy errors', () => {
  it('refuses to copy a file onto itself', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy src\\b.txt src\\b.txt')).toBe(
      'The file cannot be copied onto itself.\n        0 file(s) copied.');
    expect(await level(pc)).toBe('1');
  });

  it('refuses to overwrite a read-only file', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');
    pc.getFileSystem().resolve('C:\\dst\\x.txt')!.attributes.add('readonly');
    const out = await pc.executeCommand('copy /y src\\a.txt C:\\dst\\x.txt');

    expect(out).toBe('Access is denied.\n        0 file(s) copied.');
  });

  it('names a missing source', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy nope.txt C:\\x.txt')).toBe('The system cannot find the file specified.');
  });

  it('is a syntax error without arguments or with three operands', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy')).toBe('The syntax of the command is incorrect.');
    expect(await pc.executeCommand('copy a b c')).toBe('The syntax of the command is incorrect.');
  });
});

describe('move', () => {
  it('keeps the time and the attributes', async () => {
    const pc = await lab();
    await pc.executeCommand('move src\\a.txt C:\\dst\\moved.txt');
    const entry = pc.getFileSystem().resolve('C:\\dst\\moved.txt')!;

    expect(entry.mtime.getTime()).toBe(OLD.getTime());
    expect(entry.attributes.has('hidden')).toBe(true);
    expect(pc.getFileSystem().exists('C:\\src\\a.txt')).toBe(false);
  });

  it('moves a file into a directory', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('move src\\b.txt C:\\dst')).toBe('        1 file(s) moved.');
    expect(pc.getFileSystem().exists('C:\\dst\\b.txt')).toBe(true);
  });

  it('moves a directory and counts it as a directory', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('move src\\sub C:\\moved')).toBe('        1 dir(s) moved.');
    expect(pc.getFileSystem().exists('C:\\moved\\deep.txt')).toBe(true);
  });

  it('writes each moved file with its full path for a wildcard', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('move src\\*.txt C:\\dst')).toBe('C:\\src\\a.txt\nC:\\src\\b.txt\n        2 file(s) moved.');
  });

  it('refuses several files to a single file', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('move src\\*.txt C:\\one.txt')).toBe(
      'Cannot move multiple files to a single file.\n        0 file(s) moved.');
  });

  it('asks before overwriting, and keeps the destination on No', async () => {
    const pc = await lab();
    await pc.executeCommand('copy src\\b.txt C:\\dst\\x.txt');
    const out = await pc.executeCommand('move src\\c.log C:\\dst\\x.txt', 'n');

    expect(out).toContain('Overwrite C:\\dst\\x.txt? (Yes/No/All): ');
    expect(pc.getFileSystem().readFile('C:\\dst\\x.txt').content).toBe('hello');
    expect(pc.getFileSystem().exists('C:\\src\\c.log')).toBe(true);
  });

  it('names a missing source', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('move nope.txt C:\\x.txt')).toBe('The system cannot find the file specified.');
    expect(await level(pc)).toBe('1');
  });
});

describe('switches without an object are accepted', () => {
  it('copies with /V, /Z and /N', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy /v /z /n src\\b.txt C:\\v.txt')).toBe('        1 file(s) copied.');
  });
});

describe('an unknown switch', () => {
  it('is a syntax error', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('copy /q src\\b.txt C:\\q.txt')).toBe('The syntax of the command is incorrect.');
  });
});
