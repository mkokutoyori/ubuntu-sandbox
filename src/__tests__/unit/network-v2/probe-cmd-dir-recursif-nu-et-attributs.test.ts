/*
 * `dir /s`, `dir /b` et `dir /a` de cmd.exe se combinent comme sur Windows :
 * un seul parcours produit la liste, un seul rendu l'imprime, que le format
 * soit complet, large ou nu.
 *
 * Mesure de depart, sur l'arbre C:\lab ci-dessous : `dir /s /b` entrelacait
 * le contenu d'un dossier avec celui de ses sous-dossiers (descente en
 * profondeur au milieu de la liste) ; `dir /s/b/a` ignorait les trois
 * commutateurs colles ; `dir/s/b` repondait « 'dir/s/b' is not recognized » ;
 * `dir /ad` (sans deux-points) etait ignore ; `dir /s /b *.txt` ignorait /s et
 * /b ; `dir /s /b one.txt` repondait « File Not Found » ; `dir /zz` etait
 * ignore sans un mot ; `/o` n'ordonnait rien ; `/s` descendait dans les
 * dossiers caches ; `dir C:\` montrait `.` et `..` a la racine d'un volume ;
 * les lignes de bilan n'avaient pas l'alignement de cmd.
 *
 * L'AUTORITE — l'aide de `dir` de cmd.exe (Microsoft Learn, « dir ») : /a
 * [[:]attributs] avec d h s r a i l o et le prefixe `-`, /b format nu, /o
 * [[:]ordre] avec n e g s d et le prefixe `-`, /s sous-dossiers, /l minuscules,
 * /c separateur de milliers (`/-c` le retire), /t[[:]champ] c a w. Sans /a,
 * les fichiers caches et systeme sont omis ; que /s ne parcoure pas non
 * plus les sous-dossiers caches sans /a est le comportement d'un cmd reel
 * tel que la memoire le donne, non atteste ici. Les lignes de bilan suivent la
 * disposition « %16s File(s) %14s bytes » / « %16s Dir(s) %15s bytes free » de
 * la chaine de ressource de cmd (reprise de ReactOS) ; aucune transcription
 * de Windows n'est atteignable d'ici pour la confirmer. Le texte
 * `Invalid switch - "zz".` est celui de la memoire d'un cmd reel, de meme
 * source. L'ordre par defaut du simulateur (dossiers d'abord) n'est pas
 * celui de NTFS (alphabetique, dossiers et fichiers meles) ; il est partage
 * avec PowerShell et les noms de l'arbre sont choisis pour que les deux
 * ordres coincident : ce fichier ne le fige pas.
 *
 * Trouve en chemin : le nom d'une commande cmd s'arrete a son premier
 * delimiteur, comme sur Windows — `ipconfig/all`, `cd..`, `cd\`, `dir\`,
 * `echo.` repondaient « is not recognized » — et le nom d'un fichier
 * commencait trois colonnes avant celui d'un dossier dans une meme liste.
 *
 * Ce que la correction ne fait pas, et dit : `/q` (proprietaire), `/x` (noms
 * courts 8.3) et `/p` (pause) sont acceptes et sans effet — le format de leur
 * colonne n'est atteste par aucune source lisible d'ici ; `/t:a` affiche la
 * date d'ecriture, le systeme de fichiers simule ne tenant pas de date de
 * dernier acces. Une adresse `C:/lab` garde ses barres obliques : cmd y lirait
 * un commutateur, le simulateur l'a toujours acceptee et un cas le garde.
 *
 * Ecrite a l'aveugle. 41 des 48 cas tombent avant (git stash push --
 * src/network). Passent des deux cotes : le TEMOIN du laboratoire (`dir /b`),
 * le TEMOIN de la casse conservee par defaut, et cinq non-regressions — le
 * dossier cache non parcouru, le point de depart relatif, `File Not Found`,
 * `dir /b /a`, et le chemin `C:/lab` garde entier.
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
  const pc = new WindowsPC('windows-pc', 'WIN-DIR');
  pc.setCurrentUser('Administrator');
  const steps = [
    'mkdir C:\\lab', 'mkdir C:\\lab\\alpha', 'mkdir C:\\lab\\alpha\\inner', 'mkdir C:\\lab\\beta',
    'mkdir C:\\lab\\chidden',
    'echo 123456789 > C:\\lab\\one.txt', 'echo 1 > C:\\lab\\two.log',
    'echo k > C:\\lab\\alpha\\keep.txt', 'echo leaf > C:\\lab\\alpha\\inner\\leaf.log',
    'echo b1 > C:\\lab\\beta\\b1.txt', 'echo s > C:\\lab\\chidden\\secret.txt',
    'echo x > C:\\lab\\xhidden.txt', 'echo y > C:\\lab\\ysystem.dat',
    'echo r > C:\\rootfile.txt',
    'attrib +h C:\\lab\\chidden', 'attrib +h C:\\lab\\xhidden.txt', 'attrib +s C:\\lab\\ysystem.dat',
    'cd C:\\lab',
  ];
  for (const step of steps) await pc.executeCmdCommand(step);
  return pc;
}

const lines = (out: string): string[] => (out === '' ? [] : out.split('\n'));

const VISIBLE_TREE = [
  'C:\\lab\\alpha', 'C:\\lab\\beta', 'C:\\lab\\one.txt', 'C:\\lab\\two.log',
  'C:\\lab\\alpha\\inner', 'C:\\lab\\alpha\\keep.txt',
  'C:\\lab\\alpha\\inner\\leaf.log',
  'C:\\lab\\beta\\b1.txt',
];

const WHOLE_TREE = [
  'C:\\lab\\alpha', 'C:\\lab\\beta', 'C:\\lab\\chidden', 'C:\\lab\\one.txt', 'C:\\lab\\two.log',
  'C:\\lab\\xhidden.txt', 'C:\\lab\\ysystem.dat',
  'C:\\lab\\alpha\\inner', 'C:\\lab\\alpha\\keep.txt',
  'C:\\lab\\alpha\\inner\\leaf.log',
  'C:\\lab\\beta\\b1.txt',
  'C:\\lab\\chidden\\secret.txt',
];

describe('dir /s /b — WITNESS of the lab', () => {
  it('lists the visible files of a plain directory by name', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b'))).toEqual(['alpha', 'beta', 'one.txt', 'two.log']);
  });
});

describe('dir /s /b', () => {
  it('prints the entries of a directory before those of its subdirectories', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b'))).toEqual(VISIBLE_TREE);
  });

  it('accepts the command name glued to its switches', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir/s/b'))).toEqual(VISIBLE_TREE);
  });

  it('accepts the switches glued together', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s/b'))).toEqual(VISIBLE_TREE);
  });

  it('does not enter a hidden directory', async () => {
    const pc = await lab();
    const out = await pc.executeCmdCommand('dir /s /b');

    expect(out).not.toContain('chidden');
    expect(out).not.toContain('secret.txt');
  });

  it('keeps the root of a volume free of a doubled backslash', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b C:\\rootfile.txt'))).toEqual(['C:\\rootfile.txt']);
  });

  it('prints full paths from a relative starting point', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b beta'))).toEqual(['C:\\lab\\beta\\b1.txt']);
  });
});

describe('dir /s /b /a', () => {
  it('lists hidden and system entries and enters the hidden directory', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b /a'))).toEqual(WHOLE_TREE);
  });

  it('is the same with the switches glued: /s/b/a', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s/b/a'))).toEqual(WHOLE_TREE);
  });

  it('is the same with the command name glued as well: dir/s/b/a', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir/s/b/a'))).toEqual(WHOLE_TREE);
  });

  it('keeps only the directories under /ad, the colon being optional', async () => {
    const pc = await lab();
    const expected = ['C:\\lab\\alpha', 'C:\\lab\\beta', 'C:\\lab\\chidden', 'C:\\lab\\alpha\\inner'];

    expect(lines(await pc.executeCmdCommand('dir /s /b /ad'))).toEqual(expected);
    expect(lines(await pc.executeCmdCommand('dir /s /b /a:d'))).toEqual(expected);
  });

  it('keeps only the files under /a-d and still descends into the directories', async () => {
    const pc = await lab();
    const files = WHOLE_TREE.filter(path => !['alpha', 'beta', 'chidden', 'inner'].some(name => path.endsWith(`\\${name}`)));

    expect(lines(await pc.executeCmdCommand('dir /s /b /a-d'))).toEqual(files);
  });

  it('keeps the hidden entries only under /ah', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b /ah'))).toEqual(['C:\\lab\\chidden', 'C:\\lab\\xhidden.txt']);
  });

  it('keeps the system entries only under /as — WITNESS of the next case', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b /as'))).toEqual(['C:\\lab\\ysystem.dat']);
  });

  it('requires every letter of /ahs at once: nothing is both hidden and system', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir /s /b /ahs')).toBe('File Not Found');
  });
});

describe('dir with a name or a pattern', () => {
  it('applies /s and /b to a wildcard in every visible directory', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b *.txt')))
      .toEqual(['C:\\lab\\one.txt', 'C:\\lab\\alpha\\keep.txt', 'C:\\lab\\beta\\b1.txt']);
  });

  it('reaches the hidden entries of a wildcard search under /a', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b /a *.txt')))
      .toEqual(['C:\\lab\\one.txt', 'C:\\lab\\xhidden.txt', 'C:\\lab\\alpha\\keep.txt', 'C:\\lab\\beta\\b1.txt', 'C:\\lab\\chidden\\secret.txt']);
  });

  it('searches the tree for a literal file name', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b leaf.log'))).toEqual(['C:\\lab\\alpha\\inner\\leaf.log']);
  });

  it('applies /b to a wildcard without /s: names only', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b *.txt'))).toEqual(['one.txt']);
  });

  it('treats *.* as every name, including those without an extension', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b *.*'))).toEqual(['alpha', 'beta', 'one.txt', 'two.log']);
  });

  it('answers File Not Found when nothing matches', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir /s /b *.nothing')).toBe('File Not Found');
    expect(await pc.executeCmdCommand('dir C:\\nope /s /b')).toBe('File Not Found');
  });
});

describe('dir attribute selection without /s', () => {
  it('shows hidden and system entries with a bare /a', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /a')))
      .toEqual(['alpha', 'beta', 'chidden', 'one.txt', 'two.log', 'xhidden.txt', 'ysystem.dat']);
  });

  it('keeps only the directories under /ad', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /ad'))).toEqual(['alpha', 'beta', 'chidden']);
  });
});

describe('dir switches that are not valid', () => {
  it('refuses an unknown switch instead of ignoring it', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir /zz')).toBe('Invalid switch - "zz".');
  });

  it('refuses an unknown attribute letter', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir /a:x')).toBe('Invalid switch - "a:x".');
  });

  it('refuses an unknown sort letter', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir /o:z')).toBe('Invalid switch - "o:z".');
  });
});

describe('dir /o', () => {
  it('sorts by name, reversed with a minus', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /o:-n'))).toEqual(['two.log', 'one.txt', 'beta', 'alpha']);
  });

  it('sorts by size, smallest first', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /o:s'))).toEqual(['alpha', 'beta', 'two.log', 'one.txt']);
    expect(lines(await pc.executeCmdCommand('dir /b /o:-s'))).toEqual(['one.txt', 'two.log', 'alpha', 'beta']);
  });

  it('sorts by extension', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /o:e'))).toEqual(['alpha', 'beta', 'two.log', 'one.txt']);
  });

  it('puts the files before the directories under /o:-g', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /o:-g'))).toEqual(['one.txt', 'two.log', 'alpha', 'beta']);
  });

  it('sorts by date, oldest first, and the minus reverses it', async () => {
    const pc = await lab();
    const oldest = lines(await pc.executeCmdCommand('dir /b /o:d'));
    const newest = lines(await pc.executeCmdCommand('dir /b /o:-d'));

    expect(oldest).not.toEqual(newest);
    expect([...oldest].reverse()).toEqual(newest);
  });

  it('accepts the order without a colon', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /b /o-n'))).toEqual(['two.log', 'one.txt', 'beta', 'alpha']);
  });

  it('applies the order inside every directory of a recursive listing', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('dir /s /b /o:-n *.txt')))
      .toEqual(['C:\\lab\\one.txt', 'C:\\lab\\alpha\\keep.txt', 'C:\\lab\\beta\\b1.txt']);
  });
});

describe('dir /l and /c', () => {
  async function mixedCase(): Promise<WindowsPC> {
    const pc = await lab();
    await pc.executeCmdCommand('mkdir C:\\Up');
    await pc.executeCmdCommand('echo 1 > C:\\Up\\MiXed.TxT');
    return pc;
  }

  it('keeps the case of a name by default — WITNESS', async () => {
    const pc = await mixedCase();

    expect(await pc.executeCmdCommand('dir /b C:\\Up')).toBe('MiXed.TxT');
  });

  it('prints names in lower case under /l', async () => {
    const pc = await mixedCase();

    expect(await pc.executeCmdCommand('dir /b /l C:\\Up')).toBe('mixed.txt');
  });

  it('prints sizes without a thousands separator under /-c', async () => {
    const pc = await lab();
    await pc.executeCmdCommand(`echo ${'x'.repeat(1500)} > C:\\lab\\big.dat`);
    const grouped = await pc.executeCmdCommand('dir big.dat');
    const plain = await pc.executeCmdCommand('dir /-c big.dat');

    expect(grouped).toMatch(/ 1,501 big\.dat/);
    expect(plain).toMatch(/ 1501 big\.dat/);
    expect(plain).not.toContain('1,501');
  });
});

describe('dir in the full format', () => {
  const DATE = '\\d\\d/\\d\\d/\\d{4}  \\d\\d:\\d\\d [AP]M';
  const fileSummary = (count: number, bytes: string): string =>
    `${String(count).padStart(16)} File(s) ${bytes.padStart(14)} bytes`;

  it('puts . and .. in a subdirectory but not at the root of a volume', async () => {
    const pc = await lab();
    const sub = await pc.executeCmdCommand('dir C:\\lab');
    const root = await pc.executeCmdCommand('dir C:\\');

    expect(sub).toMatch(new RegExp(`${DATE}    <DIR>          \\.\\n`));
    expect(sub).toMatch(new RegExp(`${DATE}    <DIR>          \\.\\.\\n`));
    expect(root).toContain(' Directory of C:\\');
    expect(root).not.toMatch(/<DIR> {10}\.\./);
    expect(root).not.toMatch(/<DIR> {10}\.(\n|$)/);
  });

  it('lists . and .. when the pattern matches them, not otherwise', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir *.*')).toMatch(/<DIR> {10}\.\./);
    expect(await pc.executeCmdCommand('dir *')).toMatch(/<DIR> {10}\.\./);
    expect(await pc.executeCmdCommand('dir *.txt')).not.toContain('<DIR>');
    expect(await pc.executeCmdCommand('dir /a-d')).not.toContain('<DIR>');
  });

  it('aligns the summary lines like cmd.exe', async () => {
    const pc = await lab();
    const out = lines(await pc.executeCmdCommand('dir *.txt'));

    const closing = out[out.length - 1];
    const free = /([\d,]+) bytes free$/.exec(closing)?.[1] ?? '';

    expect(out).toContain(fileSummary(1, '10'));
    expect(free).not.toBe('');
    expect(closing).toBe(`${'0'.padStart(16)} Dir(s) ${free.padStart(15)} bytes free`);
  });

  it('prints a block per directory with a file summary only, then a total, under /s', async () => {
    const pc = await lab();
    const out = lines(await pc.executeCmdCommand('dir /s *.txt'));
    const headings = out.filter(line => line.startsWith(' Directory of '));

    expect(headings).toEqual([' Directory of C:\\lab', ' Directory of C:\\lab\\alpha', ' Directory of C:\\lab\\beta']);
    expect(out.filter(line => /Dir\(s\)/.test(line))).toHaveLength(1);
    expect(out).toContain('     Total Files Listed:');
    expect(out).toContain(fileSummary(1, '10'));
    expect(out).toContain(fileSummary(3, '15'));
    expect(out.indexOf('     Total Files Listed:')).toBeGreaterThan(out.indexOf(' Directory of C:\\lab\\beta'));
  });

  it('skips a directory with no match under /s', async () => {
    const pc = await lab();
    const out = await pc.executeCmdCommand('dir /s *.log');

    expect(out).toContain(' Directory of C:\\lab\n');
    expect(out).toContain(' Directory of C:\\lab\\alpha\\inner');
    expect(out).not.toContain(' Directory of C:\\lab\\beta');
  });

  it('starts the name of a file and the name of a directory in the same column', async () => {
    const pc = await lab();
    const out = lines(await pc.executeCmdCommand('dir C:\\lab'));
    const directoryRow = out.find(line => line.endsWith(' alpha')) ?? '';
    const fileRow = out.find(line => line.endsWith(' one.txt')) ?? '';

    expect(directoryRow).toContain('<DIR>');
    expect(directoryRow.indexOf('alpha')).toBeGreaterThan(0);
    expect(directoryRow.indexOf('alpha')).toBe(fileRow.indexOf('one.txt'));
  });

  it('marks directories with brackets in the wide format, dots included', async () => {
    const pc = await lab();
    const out = await pc.executeCmdCommand('dir /w');

    expect(out).toContain('[.]');
    expect(out).toContain('[..]');
    expect(out).toContain('[alpha]');
    expect(out).toContain('one.txt');
  });
});

describe('the name of a command ends at its first delimiter', () => {
  it('runs ipconfig/all without a space — WITNESS of the delimiter', async () => {
    const pc = await lab();
    const out = await pc.executeCmdCommand('ipconfig/all');

    expect(out).not.toContain('is not recognized');
    expect(out).toContain('Windows IP Configuration');
  });

  it('goes up with cd.. and to the root with cd\\', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('cd C:\\lab\\alpha');
    await pc.executeCmdCommand('cd..');
    expect(await pc.executeCmdCommand('cd')).toBe('C:\\lab');

    await pc.executeCmdCommand('cd\\');
    expect(await pc.executeCmdCommand('cd')).toBe('C:\\');
  });

  it('lists the root with dir\\', async () => {
    const pc = await lab();
    const out = await pc.executeCmdCommand('dir\\');

    expect(out).toContain(' Directory of C:\\');
    expect(out).toContain('rootfile.txt');
  });

  it('prints an empty line for echo. and the text for echo.text', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('echo.')).toBe('');
    expect(await pc.executeCmdCommand('echo.hello')).toBe('hello');
  });

  it('keeps a path with a colon whole: C:/lab is not a command word followed by a switch', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('dir /b C:/lab/alpha')).toBe('inner\nkeep.txt');
  });
});
