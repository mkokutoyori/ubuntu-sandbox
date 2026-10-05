/*
 * `robocopy` : la copie robuste, son compte rendu et son code retour.
 *
 * Mesure de depart : `robocopy src dst` repondait « 'robocopy' is not
 * recognized as an internal or external command » — l'outil que tout
 * administrateur Windows utilise pour copier un arbre, le sauvegarder ou le
 * synchroniser n'existait pas, alors que le depot fournissait deja copy, move
 * et xcopy.
 *
 * L'AUTORITE — l'aide `robocopy /?` et la page robocopy de Microsoft, LUES DE
 * MEMOIRE (aucune transcription n'est atteignable d'ici). Ce qui est
 * reproduit : le bandeau (« ROBOCOPY :: Robust File Copy for Windows »),
 * « Started / Source / Dest / Files / Options » avec les options dans
 * l'ordre ou je les ai vues (/S /E /DCOPY /COPY /PURGE /MIR … /R /W), les
 * lignes de dossier (« New Dir » ou rien, le nombre de fichiers, le chemin
 * SOURCE), les lignes de fichier avec leur classe (New File, Newer, Older,
 * Changed, same, Tweaked, *EXTRA File), les pourcentages « 0% / 100% », le
 * tableau Total/Copied/Skipped/Mismatch/FAILED/Extras, « Speed » et « Ended ».
 * Les classes : un fichier sans vis-a-vis est New File ; a heure egale et
 * taille differente il est Changed, a heure et taille egales mais attributs
 * differents Tweaked, sinon same ; sinon la source est Newer ou Older que la
 * destination. Par defaut on copie New, Newer, Older et Changed ; /XO /XN /XC
 * /XL en excluent, /IS et /IT ajoutent same et Tweaked. /S copie les
 * sous-dossiers non vides, /E les vides aussi, /LEV:n limite la profondeur,
 * /PURGE supprime de la destination ce qui n'est plus a la source, /MIR vaut
 * /E plus /PURGE, /MOV et /MOVE deplacent. Le code retour est un masque : 1
 * des fichiers copies, 2 des supplementaires (extras), 4 des differences de
 * type (mismatch), 8 des echecs, 16 une erreur fatale. `robocopy` sans
 * argument, un parametre invalide et une source absente rendent 16.
 *
 * Ce qui n'est PAS reproduit, faute de pouvoir l'attester : le gabarit exact
 * des lignes d'exclusion (« Exc Files / Exc Dirs ») ; l'aide `/?` complete
 * (le simulateur n'en liste que les options qu'il evalue) ; l'usage
 * d'unites k/m/g pour les tailles (seul « m » et « g » a partir de 1 Mio / 1
 * Gio, la limite basse n'etant pas attestee) ; les vitesses, toujours 0 (le
 * temps virtuel ne passe pas) ; les relances apres echec : /R:1000000
 * /W:30 par defaut bloquerait un vrai robocopy pendant un an, le simulateur
 * arrete donc apres 3 relances et ecrit « ERROR : RETRY LIMIT EXCEEDED. ».
 * /Z /B /ZB /J /MT /DST /NOOFFLOAD /ETA /256 /COMPRESS /EFSRAW sont acceptes
 * sans effet : mode redemarrable, sauvegarde, copie non tamponnee, fils
 * multiples, heure d'ete, offload, estimation, chemins longs, compression
 * reseau, EFS n'existent pas dans ce systeme de fichiers. /A+: et /A-:
 * evaluent R, A, S et H ; les attributs C, N, E, T sont acceptes sans effet.
 *
 * Ecrite a l'aveugle. 46 des 50 cas tombent avant (git stash push --
 * src/network : la commande n'existe pas). Les 4 qui passent des deux cotes :
 * trois par ABSENCE (« /XL laisse les fichiers isoles », « sans /S on
 * n'entre pas dans les sous-dossiers », « /L ne supprime rien » : sans
 * robocopy, rien n'est copie ni supprime, ce qu'elles affirment) — elles
 * gardent la garantie apres le correctif, ou la commande copie et supprime
 * pour de bon — et un TEMOIN qui prouve que le laboratoire est sain : le meme
 * arbre, copie par xcopy, garde ses heures.
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
const FUTURE = (): Date => new Date(Date.now() + 3_600_000);

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-RB');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\src\\sub');
  fs.mkdirp('C:\\src\\empty');
  fs.createFile('C:\\src\\a.txt', 'abc');
  fs.createFile('C:\\src\\b.log', 'hello');
  fs.createFile('C:\\src\\sub\\c.txt', 'deep');
  for (const path of ['C:\\src\\a.txt', 'C:\\src\\b.log', 'C:\\src\\sub\\c.txt']) fs.resolve(path)!.mtime = new Date(OLD);
  await pc.executeCmdCommand('cd C:\\');
  return pc;
}

const run = (pc: WindowsPC, command: string): Promise<string> => pc.executeCommand(command);
const level = (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');
const entry = (pc: WindowsPC, path: string) => pc.getFileSystem().resolve(path);
const has = (pc: WindowsPC, path: string): boolean => pc.getFileSystem().exists(path);

function table(out: string): { dirs: number[]; files: number[]; bytes: number[] } {
  const read = (label: string): number[] => {
    const line = out.split('\n').find(candidate => candidate.startsWith(label));
    return line === undefined ? [] : line.slice(label.length).trim().split(/\s+/).map(Number);
  };
  return { dirs: read('    Dirs :'), files: read('   Files :'), bytes: read('   Bytes :') };
}

describe('the job header', () => {
  it('opens with the banner', async () => {
    const pc = await lab();
    const lines = (await run(pc, 'robocopy src dst')).split('\n');

    expect(lines.slice(0, 4)).toEqual([
      '', '-'.repeat(79), '   ROBOCOPY     ::     Robust File Copy for Windows'.padEnd(79), '-'.repeat(79),
    ]);
  });

  it('names the start, the source, the destination, the files and the options', async () => {
    const pc = await lab();
    const lines = (await run(pc, 'robocopy src dst')).split('\n');

    expect(lines[5]).toMatch(/^ {2}Started : \w+day, \w+ \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} [AP]M$/);
    expect(lines.slice(6, 12)).toEqual([
      '   Source : C:\\src\\', '     Dest : C:\\dst\\', '', '    Files : *.*', '\t    ',
      '  Options : *.* /DCOPY:DA /COPY:DAT /R:1000000 /W:30 ',
    ]);
  });

  it('echoes the options in the order robocopy writes them', async () => {
    const pc = await lab();

    expect(await run(pc, 'robocopy src dst /purge /e /w:5 /r:2')).toContain(
      '  Options : *.* /S /E /DCOPY:DA /COPY:DAT /PURGE /R:2 /W:5 ');
    expect(await run(pc, 'robocopy src dst /mir')).toContain(
      '  Options : *.* /S /E /DCOPY:DA /COPY:DAT /PURGE /MIR /R:1000000 /W:30 ');
  });

  it('lists the file patterns', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst *.txt');

    expect(out).toContain('    Files : *.txt');
    expect(has(pc, 'C:\\dst\\a.txt')).toBe(true);
    expect(has(pc, 'C:\\dst\\b.log')).toBe(false);
  });

  it('writes the excluded names under the files line', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /s /xf b.log /xd empty');

    expect(out).toContain('Exc Files : b.log');
    expect(out).toContain(' Exc Dirs : empty');
  });
});

describe('a first copy', () => {
  it('lists the new directory, the new files and their progress', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst');

    expect(out).toContain('\t  New Dir          2\tC:\\src\\');
    expect(out).toContain('\t    New File  \t\t       3\ta.txt\n  0%  \n100%  ');
    expect(out).toContain('\t    New File  \t\t       5\tb.log');
  });

  it('copies the files with their dates and counts them', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst');

    expect(entry(pc, 'C:\\dst\\a.txt')!.mtime.getTime()).toBe(OLD.getTime());
    expect(table(out)).toEqual({ dirs: [1, 1, 0, 0, 0, 0], files: [2, 2, 0, 0, 0, 0], bytes: [8, 8, 0, 0, 0, 0] });
  });

  it('writes the summary layout', async () => {
    const pc = await lab();
    const lines = (await run(pc, 'robocopy src dst')).split('\n');
    const at = lines.indexOf('               Total    Copied   Skipped  Mismatch    FAILED    Extras');

    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('    Dirs :         1         1         0         0         0         0');
    expect(lines[at + 4]).toBe('   Times :   0:00:00   0:00:00                       0:00:00   0:00:00');
    expect(lines[lines.length - 1]).toMatch(/^ {3}Ended : \w+day, /);
  });

  it('returns 1 for copied files', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');

    expect(has(pc, 'C:\\dst\\a.txt')).toBe(true);
    expect(await level(pc)).toBe('1');
  });
});

describe('a second copy', () => {
  it('finds the files the same and copies nothing', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    const out = await run(pc, 'robocopy src dst');

    expect(out).toContain('\t    same      \t\t       3\ta.txt');
    expect(table(out).files).toEqual([2, 0, 2, 0, 0, 0]);
    expect(table(out).dirs).toEqual([1, 0, 1, 0, 0, 0]);
    expect(await level(pc)).toBe('0');
  });

  it('copies a newer source file', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    pc.getFileSystem().createFile('C:\\src\\b.log', 'hello again');
    const out = await run(pc, 'robocopy src dst');

    expect(out).toContain('\t    Newer     \t\t      11\tb.log');
    expect(pc.getFileSystem().readFile('C:\\dst\\b.log').content).toBe('hello again');
  });

  it('copies an older source file unless /XO', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    entry(pc, 'C:\\dst\\b.log')!.mtime = FUTURE();
    entry(pc, 'C:\\dst\\b.log')!.content = 'newer here';

    expect(await run(pc, 'robocopy src dst /xo')).toContain('Copied   Skipped');
    expect(pc.getFileSystem().readFile('C:\\dst\\b.log').content).toBe('newer here');
    expect(await run(pc, 'robocopy src dst')).toContain('\t    Older     \t\t       5\tb.log');
    expect(pc.getFileSystem().readFile('C:\\dst\\b.log').content).toBe('hello');
  });

  it('leaves the newer files alone under /XN', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    pc.getFileSystem().createFile('C:\\src\\b.log', 'hello again');
    await run(pc, 'robocopy src dst /xn');

    expect(pc.getFileSystem().readFile('C:\\dst\\b.log').content).toBe('hello');
  });

  it('calls a file with the same time and another size Changed', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    const source = entry(pc, 'C:\\src\\b.log')!;
    source.content = 'hello!!';
    source.size = 7;

    expect(await run(pc, 'robocopy src dst')).toContain('\t    Changed   \t\t       7\tb.log');
    expect(await run(pc, 'robocopy src dst /xc')).not.toContain('Changed');
  });

  it('skips a Tweaked file unless /IT', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    entry(pc, 'C:\\src\\a.txt')!.attributes.add('hidden');

    expect(await run(pc, 'robocopy src dst')).not.toContain('Tweaked');
    expect(await run(pc, 'robocopy src dst /it')).toContain('\t    Tweaked   \t\t       3\ta.txt');
  });

  it('copies the same files under /IS', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    const out = await run(pc, 'robocopy src dst /is');

    expect(table(out).files).toEqual([2, 2, 0, 0, 0, 0]);
  });

  it('leaves the lonely files out under /XL', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst /xl');

    expect(has(pc, 'C:\\dst\\a.txt')).toBe(false);
  });
});

describe('directories', () => {
  it('does not enter sub-directories without /S', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst');

    expect(out).not.toContain('C:\\src\\sub\\');
    expect(has(pc, 'C:\\dst\\sub')).toBe(false);
  });

  it('enters the non-empty ones with /S and skips the empty ones', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /s');

    expect(out).toContain('\t  New Dir          1\tC:\\src\\sub\\');
    expect(has(pc, 'C:\\dst\\sub\\c.txt')).toBe(true);
    expect(has(pc, 'C:\\dst\\empty')).toBe(false);
  });

  it('copies the empty ones too with /E', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /e');

    expect(out).toContain('\t  New Dir          0\tC:\\src\\empty\\');
    expect(has(pc, 'C:\\dst\\empty')).toBe(true);
    expect(table(out).dirs).toEqual([3, 3, 0, 0, 0, 0]);
  });

  it('stops at the depth of /LEV', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\src\\sub\\deep');
    pc.getFileSystem().createFile('C:\\src\\sub\\deep\\d.txt', 'd');
    await run(pc, 'robocopy src dst /s /lev:2');

    expect(has(pc, 'C:\\dst\\sub\\c.txt')).toBe(true);
    expect(has(pc, 'C:\\dst\\sub\\deep')).toBe(false);
  });

  it('leaves out the directories of /XD and the files of /XF', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst /s /xd sub /xf b.log');

    expect(has(pc, 'C:\\dst\\sub')).toBe(false);
    expect(has(pc, 'C:\\dst\\b.log')).toBe(false);
    expect(has(pc, 'C:\\dst\\a.txt')).toBe(true);
  });

  it('does not copy the destination into itself when it sits inside the source', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src src\\inside /e');

    expect(has(pc, 'C:\\src\\inside\\a.txt')).toBe(true);
    expect(has(pc, 'C:\\src\\inside\\inside')).toBe(false);
  });
});

describe('extras and mirroring', () => {
  it('lists the files that exist only at the destination and returns 3', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\dst');
    pc.getFileSystem().createFile('C:\\dst\\extra.txt', 'xxxxx');
    const out = await run(pc, 'robocopy src dst');

    expect(out).toContain('\t  *EXTRA File \t\t       5\textra.txt');
    expect(table(out).files).toEqual([3, 2, 0, 0, 0, 1]);
    expect(has(pc, 'C:\\dst\\extra.txt')).toBe(true);
    expect(await level(pc)).toBe('3');
  });

  it('deletes them under /PURGE', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\dst');
    pc.getFileSystem().createFile('C:\\dst\\extra.txt', 'xxxxx');
    await run(pc, 'robocopy src dst /purge');

    expect(has(pc, 'C:\\dst\\extra.txt')).toBe(false);
  });

  it('deletes an extra directory with its files under /MIR', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\dst\\old');
    pc.getFileSystem().createFile('C:\\dst\\old\\x.txt', 'x');
    const out = await run(pc, 'robocopy src dst /mir');

    expect(out).toContain('\t*EXTRA Dir        -1\tC:\\dst\\old\\');
    expect(out).toContain('\t  *EXTRA File \t\t       1\tx.txt');
    expect(has(pc, 'C:\\dst\\old')).toBe(false);
    expect(table(out).dirs[5]).toBe(1);
  });

  it('reports without deleting under /L', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\dst');
    pc.getFileSystem().createFile('C:\\dst\\extra.txt', 'xxxxx');
    await run(pc, 'robocopy src dst /mir /l');

    expect(has(pc, 'C:\\dst\\extra.txt')).toBe(true);
  });

  it('returns 4 for a file where the destination has a directory', async () => {
    const pc = await lab();
    pc.getFileSystem().mkdirp('C:\\dst\\a.txt');
    const out = await run(pc, 'robocopy src dst');

    expect(table(out).files[3]).toBe(1);
    expect(await level(pc)).toBe('5');
  });
});

describe('moving', () => {
  it('deletes the source files after copying them under /MOV', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst /mov');

    expect(has(pc, 'C:\\dst\\a.txt')).toBe(true);
    expect(has(pc, 'C:\\src\\a.txt')).toBe(false);
    expect(has(pc, 'C:\\src')).toBe(true);
  });

  it('deletes the emptied source directories too under /MOVE', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst /move /e');

    expect(has(pc, 'C:\\dst\\sub\\c.txt')).toBe(true);
    expect(has(pc, 'C:\\src')).toBe(false);
  });
});

describe('selection by size', () => {
  it('leaves out the files bigger than /MAX and smaller than /MIN', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst1 /max:4');
    await run(pc, 'robocopy src dst2 /min:4');

    expect(has(pc, 'C:\\dst1\\a.txt')).toBe(true);
    expect(has(pc, 'C:\\dst1\\b.log')).toBe(false);
    expect(has(pc, 'C:\\dst2\\a.txt')).toBe(false);
    expect(has(pc, 'C:\\dst2\\b.log')).toBe(true);
  });
});

describe('what is written about each file', () => {
  it('copies nothing under /L and still counts', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /l');

    expect(has(pc, 'C:\\dst')).toBe(false);
    expect(out).toContain('  Options : *.* /L /DCOPY:DA /COPY:DAT /R:1000000 /W:30 ');
    expect(out).not.toContain('100%');
    expect(table(out).files).toEqual([2, 2, 0, 0, 0, 0]);
    expect(await level(pc)).toBe('1');
  });

  it('shows the full path under /FP and the time stamp under /TS', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /fp /ts');

    expect(out).toContain('\t    New File  \t\t       3\t2020/01/02 03:04:00 C:\\src\\a.txt');
  });

  it('abbreviates large sizes unless /BYTES', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\src\\big.bin', 'x'.repeat(2 * 1_048_576));

    expect(await run(pc, 'robocopy src dst1 big.bin')).toContain('\t    New File  \t\t   2.0 m\tbig.bin');
    expect(await run(pc, 'robocopy src dst2 big.bin /bytes')).toContain('\t    New File  \t\t 2097152\tbig.bin');
  });

  it('drops the pieces its switches name', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /njh /njs /ndl /nc /ns /np');

    expect(out).toBe('\t\t\ta.txt\n\t\t\tb.log');
  });

  it('drops the file names under /NFL and the directory names under /NDL', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /nfl');

    expect(out).not.toContain('a.txt');
    expect(out).toContain('C:\\src\\');
    expect(await run(pc, 'robocopy src dst3 /ndl')).not.toContain('New Dir');
  });
});

describe('what a copy keeps', () => {
  it('keeps the time by default and not under /COPY:D', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst1');
    await run(pc, 'robocopy src dst2 /copy:d');

    expect(entry(pc, 'C:\\dst1\\a.txt')!.mtime.getTime()).toBe(OLD.getTime());
    expect(entry(pc, 'C:\\dst2\\a.txt')!.mtime.getTime()).toBeGreaterThan(OLD.getTime());
  });

  it('adds and removes attributes with /A+ and /A-', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst /a+:rh /a-:a');
    const attributes = entry(pc, 'C:\\dst\\a.txt')!.attributes;

    expect(attributes.has('readonly')).toBe(true);
    expect(attributes.has('hidden')).toBe(true);
    expect(attributes.has('archive')).toBe(false);
  });

  it('creates empty files under /CREATE', async () => {
    const pc = await lab();
    await run(pc, 'robocopy src dst /create');

    expect(pc.getFileSystem().readFile('C:\\dst\\b.log').content).toBe('');
    expect(entry(pc, 'C:\\dst\\b.log')!.size).toBe(0);
  });

  it('copies the owner under /COPYALL and not by default', async () => {
    const pc = await lab();
    entry(pc, 'C:\\src\\a.txt')!.owner = 'LAB\\bob';
    await run(pc, 'robocopy src dst1 /copyall');
    await run(pc, 'robocopy src dst2');

    expect(entry(pc, 'C:\\dst1\\a.txt')!.owner).toBe('LAB\\bob');
    expect(entry(pc, 'C:\\dst2\\a.txt')!.owner).not.toBe('LAB\\bob');
  });
});

describe('failures', () => {
  async function blocked(): Promise<WindowsPC> {
    const pc = await lab();
    await run(pc, 'robocopy src dst');
    entry(pc, 'C:\\dst\\a.txt')!.mtime = new Date('2019-01-01T00:00:00Z');
    entry(pc, 'C:\\dst\\a.txt')!.attributes.add('readonly');
    return pc;
  }

  it('reports an access denied, waits and retries, then gives up', async () => {
    const pc = await blocked();
    const out = await run(pc, 'robocopy src dst /r:2 /w:5');

    expect(out).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} ERROR 5 \(0x00000005\) Copying File C:\\src\\a\.txt\nAccess is denied\./);
    expect(out.match(/Waiting 5 seconds\.\.\. Retrying\.\.\./g)).toHaveLength(2);
    expect(out).toContain('ERROR : RETRY LIMIT EXCEEDED.');
    expect(table(out).files).toEqual([2, 0, 1, 0, 1, 0]);
    expect(await level(pc)).toBe('8');
  });

  it('does not wait with /R:0', async () => {
    const pc = await blocked();
    const out = await run(pc, 'robocopy src dst /r:0');

    expect(out).toContain('Access is denied.');
    expect(out).not.toContain('Waiting');
    expect(out).not.toContain('RETRY LIMIT EXCEEDED');
  });
});

describe('the log', () => {
  it('writes the report to the file and nothing to the console under /LOG', async () => {
    const pc = await lab();

    expect(await run(pc, 'robocopy src dst /log:C:\\r.log')).toBe('');
    expect(pc.getFileSystem().readFile('C:\\r.log').content).toContain('Robust File Copy for Windows');
  });

  it('shows the report too under /TEE, and appends under /LOG+', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy src dst /log:C:\\r.log /tee');
    await run(pc, 'robocopy src dst /log+:C:\\r.log');
    const content = pc.getFileSystem().readFile('C:\\r.log').content!;

    expect(out).toContain('Robust File Copy for Windows');
    expect(content.match(/Robust File Copy for Windows/g)).toHaveLength(2);
  });
});

describe('errors', () => {
  it('writes the simple usage and returns 16 without arguments', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy');

    expect(out).toContain('             Simple Usage :: ROBOCOPY source destination /MIR');
    expect(out).toContain('****  /MIR can DELETE files as well as copy them !');
    expect(await level(pc)).toBe('16');
  });

  it('names the invalid parameter by its position', async () => {
    const pc = await lab();

    expect(await run(pc, 'robocopy src dst /zz')).toContain('ERROR : Invalid Parameter #3 : "/zz"');
    expect(await level(pc)).toBe('16');
  });

  it('reports a missing source with its error code and returns 16', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy nope dst');

    expect(out).toMatch(/ERROR 3 \(0x00000003\) Accessing Source Directory C:\\nope\\\nThe system cannot find the path specified\.$/);
    expect(await level(pc)).toBe('16');
  });

  it('lists the options it evaluates under /?', async () => {
    const pc = await lab();
    const out = await run(pc, 'robocopy /?');

    expect(out).toContain('Usage :: ROBOCOPY source destination [file [file]...] [options]');
    expect(await level(pc)).toBe('0');
  });

  it('accepts the switches that have nothing to act on', async () => {
    const pc = await lab();

    expect(await run(pc, 'robocopy src dst /z /b /zb /j /mt:8 /dst /nooffload /eta /256')).toContain('    Dirs :');
  });
});

describe('witness', () => {
  it('xcopy copies the same tree and keeps its dates, so the lab is sound', async () => {
    const pc = await lab();
    await run(pc, 'xcopy src C:\\wit /s /i /y');

    expect(entry(pc, 'C:\\wit\\a.txt')!.mtime.getTime()).toBe(OLD.getTime());
  });
});
