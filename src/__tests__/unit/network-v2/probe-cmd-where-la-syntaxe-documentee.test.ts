/*
 * `where` suit sa syntaxe documentee : PATHEXT, /R, /Q, /F, /T, `$env:motif`,
 * `dossier:motif`, plusieurs motifs, et le code retour 0 / 1 / 2.
 *
 * Mesure de depart : `where cmd` et `where ping` ne trouvaient rien (le motif
 * etait compare au nom de fichier TEL QUEL, sans ajouter les extensions de
 * PATHEXT — alors que `cmd.exe` et `ping.exe` sont dans System32) ; `where /r
 * C:\Windows notepad.exe` jetait le `/r` ET son dossier (le dossier devenait
 * un second motif) ; `/q`, `/f` et `/t` etaient pris pour des motifs ;
 * `$path:ping` et `C:\Windows\System32:ping.exe` n'etaient pas lus ; un seul
 * motif etait cherche ; le code retour venait du texte « could not find ».
 *
 * L'AUTORITE — l'aide de `where /?` et la page `where` de Microsoft : le
 * repertoire courant puis PATH, la recherche « also done by appending the
 * extensions of the PATHEXT variable », `/R dir` recursif, `/Q` sans sortie,
 * `/F` nom entre guillemets, `/T` taille, date et heure, les formes
 * `$env:motif` et `dossier:motif` (liste de dossiers separes par `;`, jokers
 * admis), et le code retour 0 / 1 / 2. Le TEXTE DE L'AIDE est celui de la
 * memoire d'un `where /?` reel (aucune transcription n'est atteignable d'ici) ;
 * la mise en page de `/T` (taille sur 10 colonnes, puis date et heure comme
 * `dir`) n'est pas attestee non plus — c'est celle de `dir`, faute de mieux.
 *
 * Ecrite a l'aveugle, sur `executeCmdCommand`. 14 des 16 cas tombent avant
 * (git stash push -- src/network). Les 2 qui passent des deux cotes sont des
 * TEMOINS : un nom complet ou un joker, et le message d'un motif sans
 * correspondance — ce que l'ancien `where` savait deja faire, et sans quoi un
 * `where` qui ne rendrait rien passerait les autres cas par construction.
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
  const pc = new WindowsPC('windows-pc', 'WIN-WH');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\lab\\sub');
  fs.createFile('C:\\lab\\tool.cmd', '@echo off');
  fs.createFile('C:\\lab\\sub\\deep.txt', 'x');
  fs.createFile('C:\\lab\\readme.txt', 'x');
  await pc.executeCmdCommand('cd C:\\lab');
  return pc;
}

const lines = (out: string): string[] => (out === '' ? [] : out.split('\n'));
const level = async (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');

describe('PATHEXT', () => {
  it('finds a program by its name without the extension', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('where cmd'))[0]).toMatch(/^C:\\Windows\\System32\\cmd\.exe$/i);
    expect(lines(await pc.executeCmdCommand('where ping'))[0]).toMatch(/^C:\\Windows\\System32\\ping\.exe$/i);
  });

  it('lists the matches in the order of the search path', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('where notepad')).map(path => path.toLowerCase())).toEqual([
      'c:\\windows\\system32\\notepad.exe', 'c:\\windows\\notepad.exe',
    ]);
  });

  it('looks in the current directory first', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('where tool')).toBe('C:\\lab\\tool.cmd');
  });

  it('follows the extensions PATHEXT lists', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set PATHEXT=.EXE');

    expect(await pc.executeCmdCommand('where tool')).toContain('Could not find files');
    expect(lines(await pc.executeCmdCommand('where cmd'))[0]).toMatch(/cmd\.exe$/i);
  });
});

describe('where to look', () => {
  it('searches below the directory given to /R', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('where /r C:\\Windows notepad.exe')).map(path => path.toLowerCase()).sort()).toEqual([
      'c:\\windows\\notepad.exe', 'c:\\windows\\system32\\notepad.exe',
    ]);
    expect(await pc.executeCmdCommand('where /r C:\\lab *.txt')).toBe('C:\\lab\\readme.txt\nC:\\lab\\sub\\deep.txt');
  });

  it('reads $env:pattern', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('where $path:ping'))[0]).toMatch(/ping\.exe$/i);
    expect(await pc.executeCmdCommand('where $nosuchvar:ping')).toBe('ERROR: The environment variable "nosuchvar" is not defined.');
  });

  it('reads directory:pattern, with several directories and wildcards in them', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('where C:\\Windows\\System32:ping.exe'))[0]).toMatch(/^C:\\Windows\\System32\\ping\.exe$/i);
    expect(await pc.executeCmdCommand('where C:\\lab;C:\\lab\\sub:*.txt')).toBe('C:\\lab\\readme.txt\nC:\\lab\\sub\\deep.txt');
    expect(await pc.executeCmdCommand('where C:\\la*:tool.cmd')).toBe('C:\\lab\\tool.cmd');
  });

  it('searches every pattern it is given', async () => {
    const pc = await lab();
    const out = lines(await pc.executeCmdCommand('where tool readme.txt nosuch'));

    expect(out).toEqual(['C:\\lab\\tool.cmd', 'C:\\lab\\readme.txt', 'INFO: Could not find files for the given pattern(s).']);
  });
});

describe('what it prints', () => {
  it('prints nothing with /Q, and the level says what was found', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('where /q tool')).toBe('');
    expect(await level(pc)).toBe('0');
    expect(await pc.executeCmdCommand('where /q nosuch')).toBe('');
    expect(await level(pc)).toBe('1');
  });

  it('quotes the path with /F', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('where /f tool')).toBe('"C:\\lab\\tool.cmd"');
  });

  it('puts size, date and time before the path with /T', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('where /t readme.txt')).toMatch(/^\s+1 {2}\d{2}\/\d{2}\/\d{4} {2}\d{2}:\d{2} [AP]M {2}C:\\lab\\readme\.txt$/);
  });

  it('answers 0, 1 and 2', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('where tool');
    expect(await level(pc)).toBe('0');
    await pc.executeCmdCommand('where nosuch');
    expect(await level(pc)).toBe('1');
    await pc.executeCmdCommand('where /z tool');
    expect(await level(pc)).toBe('2');
  });

  it('refuses an option it does not know, and a missing pattern', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('where /z tool')).toBe("ERROR: Invalid argument or option - '/z'.\nType \"WHERE /?\" for usage.");
    expect((await pc.executeCmdCommand('where')).split('\n')[0]).toBe('ERROR: A pattern must be specified.');
  });

  it('prints its help', async () => {
    const pc = await lab();
    const help = lines(await pc.executeCmdCommand('where /?'));

    expect(help[0]).toBe('WHERE [/R dir] [/Q] [/F] [/T] pattern...');
    expect(help.join('\n')).toContain('PATHEXT');
  });
});

describe('what already worked', () => {
  it('finds a file by its full name and by a wildcard — WITNESS', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('where notepad.exe'))[0]).toMatch(/notepad\.exe$/i);
    expect(await pc.executeCmdCommand('where read*')).toBe('C:\\lab\\readme.txt');
  });

  it('reports a pattern nothing matches — WITNESS', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('where nosuch')).toBe('INFO: Could not find files for the given pattern(s).');
  });
});
