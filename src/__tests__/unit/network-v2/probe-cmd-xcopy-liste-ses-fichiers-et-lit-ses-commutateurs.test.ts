/*
 * `xcopy` : liste les fichiers qu'il copie, pose la question du fichier ou du
 * dossier, et lit ses commutateurs.
 *
 * Mesure de depart : `xcopy src dst /s` repondait « 3 File(s) copied » sans
 * nommer un seul fichier ; /E, /H, /D, /U, /A, /M, /L, /Q, /F, /EXCLUDE, /T,
 * /K, /R, /C et /P etaient avales sans effet (un fichier cache ou en
 * lecture seule etait traite comme les autres, et /E ne creait aucun
 * dossier vide) ; /Y n'existait pas, donc rien ne demandait jamais
 * confirmation avant d'ecraser ; un fichier copie vers un nom inconnu
 * n'obligeait jamais a dire s'il s'agissait d'un fichier ou d'un dossier ; le
 * dossier de destination pouvait etre DANS la source (copie cyclique) ; et le
 * code retour valait toujours 0.
 *
 * L'AUTORITE — l'aide `xcopy /?` de Windows, LUE DE MEMOIRE (aucune
 * transcription n'est atteignable d'ici) : chaque fichier copie est ecrit,
 * puis « N File(s) copied » (« N File(s) » avec /L) ; /S copie les
 * sous-dossiers non vides, /E y ajoute les vides, /T ne cree que
 * l'arborescence ; fichiers caches et systeme ignores sans /H ; /D:mm-jj-aaaa
 * les fichiers modifies a partir de cette date, /D seul ceux plus recents que
 * la destination ; /U seulement ceux deja presents ; /A le bit archive, /M le
 * meme et le remet a zero sur la source ; /EXCLUDE:fichier une liste de
 * chaines, un chemin qui en contient une est exclu ; /Q ne liste rien, /F
 * montre « source -> destination » ; /Y supprime et /-Y impose « Overwrite
 * X (Yes/No/All)? » (que COPYCMD pre-regle ; xcopy, contrairement a copy, la
 * pose AUSSI dans un script) ; sans /K l'attribut lecture seule est efface sur
 * la copie, sans /R un fichier de destination en lecture seule n'est pas
 * ecrase (« File creation error - Access is denied. »), /C continue apres
 * une erreur, /P demande « fichier (Y/N)? » pour chacun, /I presume un
 * dossier ; a defaut, pour UN fichier vers un nom inconnu, « Does X specify
 * a file name or directory name on the target (F = file, D = directory)? ».
 * Codes retour : 0 copie faite, 1 aucun fichier, 2 interrompu, 4 erreur. Le
 * simulateur ecrit le chemin TEL QUE TAPE devant chaque fichier ; l'usage de
 * l'initiale de lecteur (« C:fichier ») que je crois avoir vu n'est pas atteste
 * et n'est pas reproduit. /V /N /Z /B /J /G /COMPRESS sont acceptes sans effet
 * (verification, noms courts, mode redemarrable, sauvegarde, copie non
 * tamponnee, chiffrement, compression reseau : rien de tout cela n'existe ici).
 *
 * Ecrite a l'aveugle, sur `executeCommand` (entree standard du scenario).
 * 36 des 39 cas tombent avant (git stash push -- src/network). Les 3 qui
 * passent des deux cotes : « /E garde les dossiers vides » (l'ancienne
 * version creait deja tous les sous-dossiers : TEMOIN de non-regression),
 * « un nom inconnu devient un fichier sur F » (l'ancienne version copiait
 * vers ce nom sans poser la question : meme resultat) et « Yes » a une
 * question qui n'etait pas posee (passage par ABSENCE : il ecrasait
 * trivialement ; il garde la garantie apres le correctif). Mesure en passant :
 * `xcopy src src\inside /s` BOUCLAIT — l'ancienne version recopiait la
 * destination dans elle-meme pendant 15 secondes avant de s'arreter.
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
  const pc = new WindowsPC('windows-pc', 'WIN-XC');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\src\\sub\\deep');
  fs.mkdirp('C:\\src\\empty');
  fs.createFile('C:\\src\\a.txt', 'abc');
  fs.createFile('C:\\src\\b.log', 'hello');
  fs.createFile('C:\\src\\sub\\c.txt', 'deep');
  fs.createFile('C:\\src\\hid.txt', 'secret');
  fs.resolve('C:\\src\\hid.txt')!.attributes.add('hidden');
  fs.resolve('C:\\src\\a.txt')!.mtime = new Date(OLD);
  await pc.executeCmdCommand('cd C:\\');
  return pc;
}

const level = (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');
const has = (pc: WindowsPC, path: string): boolean => pc.getFileSystem().exists(path);

describe('listing', () => {
  it('writes each copied file as typed, then the count', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1')).toBe('src\\a.txt\nsrc\\b.log\n2 File(s) copied');
  });

  it('writes the sub-directory files with their relative path under /S', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1 /s')).toBe('src\\a.txt\nsrc\\b.log\nsrc\\sub\\c.txt\n3 File(s) copied');
  });

  it('lists nothing but the count with /Q', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1 /s /q')).toBe('3 File(s) copied');
  });

  it('shows source and destination with /F', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\d1\\ /f')).toBe('C:\\src\\a.txt -> C:\\d1\\a.txt\n1 File(s) copied');
  });

  it('copies nothing and counts without the word copied under /L', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1 /s /l')).toBe('src\\a.txt\nsrc\\b.log\nsrc\\sub\\c.txt\n3 File(s)');
    expect(has(pc, 'C:\\d1')).toBe(false);
  });

  it('copies a wildcard', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src\\*.txt C:\\d1')).toBe('src\\a.txt\n1 File(s) copied');
  });
});

describe('sub-directories', () => {
  it('leaves out empty directories under /S', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src C:\\d1 /s');

    expect(has(pc, 'C:\\d1\\sub')).toBe(true);
    expect(has(pc, 'C:\\d1\\empty')).toBe(false);
    expect(has(pc, 'C:\\d1\\sub\\deep')).toBe(false);
  });

  it('keeps the empty directories under /E', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src C:\\d1 /e');

    expect(has(pc, 'C:\\d1\\empty')).toBe(true);
    expect(has(pc, 'C:\\d1\\sub\\deep')).toBe(true);
  });

  it('copies the tree without its files under /T /E', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1 /t /e')).toBe('0 File(s) copied');
    expect(has(pc, 'C:\\d1\\sub\\deep')).toBe(true);
    expect(has(pc, 'C:\\d1\\a.txt')).toBe(false);
  });

  it('refuses a destination inside the source with /S', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\src\\inside /s')).toBe('Cannot perform a cyclic copy\n0 File(s) copied');
    expect(await level(pc)).toBe('4');
  });
});

describe('selection', () => {
  it('skips hidden files without /H and copies them with it', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src C:\\d1');
    await pc.executeCommand('xcopy src C:\\d2 /h');

    expect(has(pc, 'C:\\d1\\hid.txt')).toBe(false);
    expect(has(pc, 'C:\\d2\\hid.txt')).toBe(true);
  });

  it('takes the files changed since a date with /D:date', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1 /d:06-01-2020')).toBe('src\\b.log\n1 File(s) copied');
  });

  it('takes only the files newer than the destination with /D', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src C:\\d1');
    pc.getFileSystem().resolve('C:\\src\\b.log')!.mtime = new Date(Date.now() + 60_000);

    expect(await pc.executeCommand('xcopy src C:\\d1 /d /y')).toBe('src\\b.log\n1 File(s) copied');
  });

  it('takes only the files that already exist with /U', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');

    expect(await pc.executeCommand('xcopy src C:\\d1 /u /y')).toBe('src\\a.txt\n1 File(s) copied');
  });

  it('takes only the files with the archive bit under /A, and clears it under /M', async () => {
    const pc = await lab();
    const fs = pc.getFileSystem();
    fs.resolve('C:\\src\\a.txt')!.attributes.delete('archive');
    fs.resolve('C:\\src\\b.log')!.attributes.add('archive');

    expect(await pc.executeCommand('xcopy src C:\\d1 /m')).toBe('src\\b.log\n1 File(s) copied');
    expect(fs.resolve('C:\\src\\b.log')!.attributes.has('archive')).toBe(false);
  });

  it('excludes the paths that contain a string of the /EXCLUDE file', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\skip.txt', '.log\r\n');

    expect(await pc.executeCommand('xcopy src C:\\d1 /exclude:C:\\skip.txt')).toBe('src\\a.txt\n1 File(s) copied');
  });

  it('refuses an /EXCLUDE file that does not exist', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\d1 /exclude:nope.txt')).toBe('File not found - nope.txt\n0 File(s) copied');
  });
});

describe('overwriting', () => {
  it('asks in the xcopy wording', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src C:\\d1');

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\d1', 'n')).toContain('Overwrite C:\\d1\\a.txt (Yes/No/All)? ');
  });

  it('keeps the destination on No', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');
    const out = await pc.executeCommand('xcopy src\\a.txt C:\\d1', 'n');

    expect(out.endsWith('0 File(s) copied')).toBe(true);
    expect(pc.getFileSystem().readFile('C:\\d1\\a.txt').content).toBe('old');
  });

  it('overwrites on Yes', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');
    await pc.executeCommand('xcopy src\\a.txt C:\\d1', 'y');

    expect(pc.getFileSystem().readFile('C:\\d1\\a.txt').content).toBe('abc');
  });

  it('does not ask with /Y', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\d1 /y')).toBe('src\\a.txt\n1 File(s) copied');
  });

  it('still asks inside a batch script, unlike copy', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');
    pc.getFileSystem().createFile('C:\\run.bat', '@echo off\r\nxcopy src\\a.txt C:\\d1\r\n');

    expect(await pc.executeCommand('C:\\run.bat', 'n')).toContain('Overwrite C:\\d1\\a.txt (Yes/No/All)? ');
  });

  it('asks about each file under /P', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('xcopy src C:\\d1 /p', 'y\nn');

    expect(out).toContain('src\\a.txt (Y/N)? ');
    expect(out).toContain('src\\b.log (Y/N)? ');
    expect(out.endsWith('1 File(s) copied')).toBe(true);
  });
});

describe('read-only files', () => {
  it('clears the read-only attribute of the copy unless /K', async () => {
    const pc = await lab();
    pc.getFileSystem().resolve('C:\\src\\a.txt')!.attributes.add('readonly');
    await pc.executeCommand('xcopy src\\a.txt C:\\d1\\');
    await pc.executeCommand('xcopy src\\a.txt C:\\d2\\ /k');

    expect(pc.getFileSystem().resolve('C:\\d1\\a.txt')!.attributes.has('readonly')).toBe(false);
    expect(pc.getFileSystem().resolve('C:\\d2\\a.txt')!.attributes.has('readonly')).toBe(true);
  });

  it('refuses to overwrite a read-only destination without /R and returns 4', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');
    pc.getFileSystem().resolve('C:\\d1\\a.txt')!.attributes.add('readonly');

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\d1 /y')).toBe('File creation error - Access is denied.\n0 File(s) copied');
    expect(await level(pc)).toBe('4');
  });

  it('overwrites it with /R', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');
    pc.getFileSystem().resolve('C:\\d1\\a.txt')!.attributes.add('readonly');

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\d1 /y /r')).toBe('src\\a.txt\n1 File(s) copied');
  });

  it('goes on after an error with /C', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\d1');
    pc.getFileSystem().createFile('C:\\d1\\a.txt', 'old');
    pc.getFileSystem().resolve('C:\\d1\\a.txt')!.attributes.add('readonly');
    const out = await pc.executeCommand('xcopy src C:\\d1 /y /c');

    expect(out).toBe('File creation error - Access is denied.\nsrc\\b.log\n1 File(s) copied');
  });
});

describe('the destination', () => {
  it('asks whether a new name is a file or a directory, for one file', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('xcopy src\\a.txt C:\\new', 'd');

    expect(out).toContain('Does C:\\new specify a file name\nor directory name on the target\n(F = file, D = directory)? ');
    expect(pc.getFileSystem().isDirectory('C:\\new')).toBe(true);
  });

  it('makes a file on F', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src\\a.txt C:\\new', 'f');

    expect(pc.getFileSystem().isFile('C:\\new')).toBe(true);
  });

  it('stops with 2 when nobody answers', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('xcopy src\\a.txt C:\\new');

    expect(out.endsWith('0 File(s) copied')).toBe(true);
    expect(await level(pc)).toBe('2');
  });

  it('does not ask under /I', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\new /i')).toBe('src\\a.txt\n1 File(s) copied');
    expect(pc.getFileSystem().isDirectory('C:\\new')).toBe(true);
  });

  it('presumes a directory for several files', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src C:\\new')).toBe('src\\a.txt\nsrc\\b.log\n2 File(s) copied');
    expect(pc.getFileSystem().isDirectory('C:\\new')).toBe(true);
  });
});

describe('what a copy keeps', () => {
  it('keeps the last write time', async () => {
    const pc = await lab();
    await pc.executeCommand('xcopy src\\a.txt C:\\d1\\');

    expect(pc.getFileSystem().resolve('C:\\d1\\a.txt')!.mtime.getTime()).toBe(OLD.getTime());
  });

  it('copies the owner with /O', async () => {
    const pc = await lab();
    pc.getFileSystem().resolve('C:\\src\\a.txt')!.owner = 'LAB\\bob';
    await pc.executeCommand('xcopy src\\a.txt C:\\d1\\ /o');
    await pc.executeCommand('xcopy src\\a.txt C:\\d2\\');

    expect(pc.getFileSystem().resolve('C:\\d1\\a.txt')!.owner).toBe('LAB\\bob');
    expect(pc.getFileSystem().resolve('C:\\d2\\a.txt')!.owner).not.toBe('LAB\\bob');
  });
});

describe('errors', () => {
  it('names a missing source and returns 1', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy nope.txt C:\\d1\\')).toBe('File not found - nope.txt\n0 File(s) copied');
    expect(await level(pc)).toBe('1');
  });

  it('returns 1 when a wildcard matches nothing', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src\\*.zz C:\\d1\\')).toBe('0 File(s) copied');
    expect(await level(pc)).toBe('1');
  });

  it('rejects no operand and an unknown switch with 4', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy')).toBe('Invalid number of parameters');
    expect(await pc.executeCommand('xcopy src C:\\d1 /zz')).toBe('Invalid number of parameters');
    expect(await level(pc)).toBe('4');
  });

  it('refuses to copy a file onto itself and returns 4', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('cd C:\\src');

    expect(await pc.executeCommand('xcopy a.txt')).toBe('File cannot be copied onto itself\n0 File(s) copied');
    expect(await level(pc)).toBe('4');
  });

  it('accepts the switches that have nothing to act on', async () => {
    const pc = await lab();

    expect(await pc.executeCommand('xcopy src\\a.txt C:\\d1\\ /v /z /b /j')).toBe('src\\a.txt\n1 File(s) copied');
  });
});
