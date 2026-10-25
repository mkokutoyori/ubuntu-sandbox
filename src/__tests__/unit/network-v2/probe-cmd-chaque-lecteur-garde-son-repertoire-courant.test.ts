/**
 * Navigation de cmd dans l'arborescence : un repertoire courant par lecteur, des refus qui disent pourquoi, un
 * repertoire tenu ouvert qui ne se supprime pas, un shell enfant qui ne deplace pas son parent.
 *
 * Mesure de depart (6c86125ec), un WindowsPC et des terminaux WindowsTerminalSession. La machine ne retenait qu'UN
 * repertoire courant : `cd C:\Windows` depuis D: deplacait le terminal sur C: (`%CD%` redonnait C:\Windows), `cd D:`
 * changeait de lecteur sans afficher celui de D:, `dir D:` et `type D:fichier` ne lisaient pas le repertoire retenu
 * pour D:, `pushd D:` allait a la racine. `cd c:\windows\SYSTEM32` rangeait le chemin comme tape, alors que cmd range
 * le nom du disque. `cd` sur un fichier, un joker ou un lecteur absent, `cd /?` et `cd /d` seul repondaient tous
 * « The system cannot find the path specified. », la pile de `pushd` etait commune a tous les terminaux de la machine,
 * `rd` du repertoire courant (de ce terminal, d'un autre, ou d'un de ses parents) reussissait, comme `rd /s`, `ren`
 * et `move` du repertoire courant, `dir` d'un nom absent n'imprimait pas l'en-tete de volume, `prompt` n'existait pas,
 * un `cd` refuse ne coupait pas une chaine `&&` et ne declenchait pas `||`, `popd` vers un repertoire disparu se
 * taisait, quitter un lecteur n'en retenait pas le repertoire de depart (`D:` puis `cd C:` ne rendait pas le profil),
 * `normalizeWindowsPath('D:nom', cwd)` ne se resolvait pas par un repertoire de lecteur, et un `cmd`, un `powershell`
 * ou un `powershell -Command` enfant laissait son repertoire, ceux de ses lecteurs et sa pile au parent en sortant.
 *
 * Autorites (Microsoft Learn, pages lues) : `cd`/`chdir` -- avec les extensions de commande la casse tapee est
 * remplacee par celle du disque, les espaces ne delimitent pas, `cd X:` affiche le repertoire courant de X: et `/d`
 * change de lecteur ; `pushd`/`popd` -- une pile par instance de cmd, qui change aussi de lecteur ; `prompt` -- les
 * codes $A $B $C $D $E $F $G $H $L $N $P $Q $S $T $V $_ $$ puis $+ et $M ; « System Error Codes » -- 15
 * ERROR_INVALID_DRIVE, 3 ERROR_PATH_NOT_FOUND, 267 ERROR_DIRECTORY, 123 ERROR_INVALID_NAME, 32
 * ERROR_SHARING_VIOLATION, 145 ERROR_DIR_NOT_EMPTY. Un repertoire courant est tenu ouvert par son processus : lui et
 * chacun de ses parents repondent ERROR_SHARING_VIOLATION a `rd`, `move` et `ren`.
 *
 * Sur les 93 cas, 61 tombent avant la correction. Les 32 qui passent dans les deux etats sont de trois sortes. Les
 * TEMOINS, qui prouvent que le laboratoire sait retirer et renommer ce que les refus protegent : « removes the
 * directory once the terminal has left it », « removes a directory next to the current one », « leaves a directory of
 * another drive removable », « renames a directory nobody holds ». Les cas de NON-REGRESSION, que cmd faisait deja
 * juste et que le modele par lecteur pouvait casser : `cd` sans argument, `/d`, le refus d'un chemin absent,
 * l'errorlevel, les espaces sans guillemets, la pile de `pushd`/`popd` et la pile vide, `dir /b` d'un nom absent et
 * d'un fichier, le prompt par defaut, un enfant qui demarre dans le repertoire de son parent, `start /d`, `cmd /c`,
 * `cmd /k`, deux terminaux independants, et les fichiers de commandes (`cd` dans une ligne chainee, `cd /d` et
 * `pushd` d'un .bat rendus a l'appelant), et la fabrique du bail de session (une session faite pour un repertoire donne
 * s'y ouvre, une session faite sans repertoire s'ouvre dans le profil du compte). Les GARDE-FOUS nes du balayage et de la mutation de ce lot : l'errorlevel
 * de `dir` (le balayage a trouve que l'en-tete de volume, imprime avant « File Not Found », faisait lire 0 a une
 * heuristique qui ne regarde que la premiere ligne ; `dir`, `rd` et `ren` fixent maintenant eux-memes leur code), et
 * l'etiquette du volume dans l'en-tete de `dir D:\` et de `dir C:\Windows\Fonts`.
 *
 * Ce qui n'est PAS sourcable et reste une extrapolation : le texte de `popd` vers un repertoire disparu (ni la page de
 * `popd` ni celle de `pushd` ne le decrivent ; c'est celui que `cd` donne pour le meme chemin) et la valeur 1 de
 * l'errorlevel de `rd` et `ren` refuses (les pages ne la donnent pas ; `cd` refuse la fixe deja a 1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { normalizeWindowsPath } from '@/network/devices/windows/windowsPath';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

class Console {
  private constructor(private readonly session: WindowsTerminalSession) {}

  static async open(machine: WindowsPC, id: string): Promise<Console> {
    const session = new WindowsTerminalSession(id, machine);
    await session.init();
    return new Console(session);
  }

  get prompt(): string {
    return this.session.getPrompt();
  }

  async run(line: string): Promise<string> {
    const before = this.session.lines.length;
    this.session.setInput(line);
    this.session.setInputBuf(line);
    this.session.handleKey(key('Enter'));
    await settle();
    return this.session.lines.slice(before + 1).map(entry => entry.text).join('\n');
  }

  async runAll(...lines: string[]): Promise<string[]> {
    const outputs: string[] = [];
    for (const line of lines) outputs.push(await this.run(line));
    return outputs;
  }

  async directory(): Promise<string> {
    return this.run('cd');
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lab(): Promise<{ machine: WindowsPC; shell: Console }> {
  const machine = new WindowsPC('windows-pc', 'WIN-NAV', 0, 0);
  const shell = await Console.open(machine, 'a');
  await shell.runAll(
    'echo hello> D:\\Data\\inside.txt',
    'mkdir C:\\Users\\User\\MixedCase',
    'echo text> C:\\Users\\User\\plain.txt',
  );
  return { machine, shell };
}

const BUSY = 'The process cannot access the file because it is being used by another process.';

describe('cd without a drive switch', () => {
  it('prints the current directory when given no argument', async () => {
    const { shell } = await lab();
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });

  it('prints the current directory of another drive and stays on the current drive', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd D:')).toBe('D:\\');
    expect(await shell.directory()).toBe('C:\\Users\\User');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('prints the current directory of the current drive for cd C:', async () => {
    const { shell } = await lab();
    await shell.run('cd Documents');
    expect(await shell.run('cd C:')).toBe('C:\\Users\\User\\Documents');
    expect(shell.prompt).toBe('C:\\Users\\User\\Documents>');
  });

  it('remembers the directory of a drive that was left', async () => {
    const { shell } = await lab();
    await shell.runAll('D:', 'cd Data', 'C:');
    expect(await shell.run('cd D:')).toBe('D:\\Data');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('remembers where the terminal started on a drive it leaves', async () => {
    const { shell } = await lab();
    await shell.run('D:');
    expect(await shell.run('cd C:')).toBe('C:\\Users\\User');
  });

  it('changes the directory of another drive without leaving the current drive', async () => {
    const { shell } = await lab();
    await shell.runAll('D:', 'cd Data');
    expect(await shell.run('cd C:\\Windows')).toBe('');
    expect(shell.prompt).toBe('D:\\Data>');
    expect(await shell.run('cd C:')).toBe('C:\\Windows');
    await shell.run('C:');
    expect(shell.prompt).toBe('C:\\Windows>');
  });

  it('switches drive and directory with /d', async () => {
    const { shell } = await lab();
    await shell.run('cd /d D:\\Data');
    expect(shell.prompt).toBe('D:\\Data>');
    await shell.run('cd /d C:\\Windows');
    expect(shell.prompt).toBe('C:\\Windows>');
  });

  it('returns to the remembered directory of a drive with cd /d X:', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Windows');
    await shell.run('cd /d D:');
    expect(shell.prompt).toBe('D:\\Data>');
  });

  it('resolves a drive-relative path against the directory of that drive', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Users');
    expect(await shell.run('cd D:..')).toBe('');
    expect(shell.prompt).toBe('C:\\Users>');
    expect(await shell.run('cd D:')).toBe('D:\\');
  });

  it('lists the current directory of a drive for dir X:', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Windows');
    expect(await shell.run('dir /b D:')).toBe('inside.txt');
    expect(await shell.run('dir /b D:\\')).not.toContain('inside.txt');
  });

  it('reads a file by a drive-relative name', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Windows');
    expect(await shell.run('type D:inside.txt')).toContain('hello');
  });

  it('keeps %CD% on the current drive', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd C:\\Windows');
    expect(await shell.run('echo %CD%')).toBe('D:\\Data');
  });

  it('remembers drive directories when commands come straight from the API', async () => {
    const machine = new WindowsPC('windows-pc', 'WIN-API', 0, 0);
    await machine.executeCommand('cd /d D:\\Data');
    await machine.executeCommand('cd /d C:\\Windows');
    expect(await machine.executeCommand('cd D:')).toBe('D:\\Data');
    await machine.executeCommand('D:');
    expect(await machine.executeCommand('cd')).toBe('D:\\Data');
  });

  it('remembers where the machine started on a drive it leaves when commands come from the API', async () => {
    const machine = new WindowsPC('windows-pc', 'WIN-API', 0, 0);
    await machine.executeCommand('D:');
    expect(await machine.executeCommand('cd C:')).toBe('C:\\Users\\User');
  });
});

describe('a drive-relative name without a machine to ask', () => {
  it('resolves X:name against the working directory when X is its drive', () => {
    expect(normalizeWindowsPath('C:name', 'C:\\Users\\User')).toBe('C:\\Users\\User\\name');
  });

  it('resolves X:name against the root of another drive', () => {
    expect(normalizeWindowsPath('D:name', 'C:\\Users\\User')).toBe('D:\\name');
  });

  it('resolves X: alone to the directory it names', () => {
    expect(normalizeWindowsPath('C:', 'C:\\Users\\User')).toBe('C:\\Users\\User');
    expect(normalizeWindowsPath('D:', 'C:\\Users\\User')).toBe('D:\\');
  });

  it('asks the resolver for the directory of the drive when there is one', () => {
    expect(normalizeWindowsPath('D:name', 'C:\\Users\\User', () => 'D:\\Data')).toBe('D:\\Data\\name');
  });
});

describe('cd reports what it cannot enter', () => {
  it('names a missing drive', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd Z:')).toBe('The system cannot find the drive specified.');
    expect(await shell.run('cd Z:\\Temp')).toBe('The system cannot find the drive specified.');
    expect(await shell.run('cd /d Z:\\')).toBe('The system cannot find the drive specified.');
  });

  it('names a missing path on an existing drive', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd nonexistent')).toBe('The system cannot find the path specified.');
    expect(await shell.run('cd D:\\nonexistent')).toBe('The system cannot find the path specified.');
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });

  it('refuses a file as a directory name', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd plain.txt')).toBe('The directory name is invalid.');
    expect(await shell.run('cd /d C:\\Users\\User\\plain.txt')).toBe('The directory name is invalid.');
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });

  it('refuses wildcards', async () => {
    const { shell } = await lab();
    const message = 'The filename, directory name, or volume label syntax is incorrect.';
    expect(await shell.run('cd Doc*')).toBe(message);
    expect(await shell.run('cd D?cuments')).toBe(message);
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });

  it('sets the error level on every refusal and leaves it on success', async () => {
    const { shell } = await lab();
    await shell.run('cd nonexistent');
    expect(await shell.run('echo %errorlevel%')).toBe('1');
    await shell.run('ver > nul');
    await shell.run('cd plain.txt');
    expect(await shell.run('echo %errorlevel%')).toBe('1');
    await shell.run('cd Z:');
    expect(await shell.run('echo %errorlevel%')).toBe('1');
  });

  it('refuses the dot-dot-dot of a shell that does not know it', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd ...')).toBe('The system cannot find the path specified.');
  });

  it('accepts a name with spaces without quotes', async () => {
    const { shell } = await lab();
    await shell.run('cd /d C:\\Program Files');
    expect(shell.prompt).toBe('C:\\Program Files>');
  });
});

describe('cd stores the case the name has on the disk', () => {
  it('converts a typed path to the case of the disk', async () => {
    const { shell } = await lab();
    await shell.run('cd c:\\users\\user\\documents');
    expect(await shell.directory()).toBe('C:\\Users\\User\\Documents');
    expect(shell.prompt).toBe('C:\\Users\\User\\Documents>');
  });

  it('converts a relative name', async () => {
    const { shell } = await lab();
    await shell.run('cd DOCUMENTS');
    expect(await shell.directory()).toBe('C:\\Users\\User\\Documents');
  });

  it('converts after dot-dot', async () => {
    const { shell } = await lab();
    await shell.run('cd ..\\..\\WINDOWS\\system32');
    expect(await shell.directory()).toBe('C:\\Windows\\System32');
  });

  it('converts a name that carries mixed case on the disk', async () => {
    const { shell } = await lab();
    await shell.run('cd mixedcase');
    expect(await shell.directory()).toBe('C:\\Users\\User\\MixedCase');
  });

  it('converts for cd /d and chdir', async () => {
    const { shell } = await lab();
    await shell.run('cd /d c:\\program files');
    expect(shell.prompt).toBe('C:\\Program Files>');
    await shell.run('chdir /d d:\\data');
    expect(shell.prompt).toBe('D:\\Data>');
  });

  it('converts a drive directory set from another drive', async () => {
    const { shell } = await lab();
    await shell.run('cd d:\\data');
    expect(await shell.run('cd D:')).toBe('D:\\Data');
  });

  it('keeps the case of the name typed for a directory that is created afterwards', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Fresh', 'cd fresh');
    expect(await shell.directory()).toBe('C:\\Users\\User\\Fresh');
  });
});

describe('cd help and bare switches', () => {
  it('prints the current directory for cd /d without a path', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd /d')).toBe('C:\\Users\\User');
  });

  it('prints the help for cd /? and chdir /?', async () => {
    const { shell } = await lab();
    const help = await shell.run('cd /?');
    expect(help.split('\n')[0]).toBe('Displays the name of or changes the current directory.');
    expect(help).toContain('Type CD drive: to display the current directory in the specified drive.');
    expect(await shell.run('chdir /?')).toBe(help);
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });
});

describe('pushd and popd', () => {
  it('stores the directory and the drive and restores both', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'pushd C:\\Windows');
    expect(shell.prompt).toBe('C:\\Windows>');
    await shell.run('popd');
    expect(shell.prompt).toBe('D:\\Data>');
  });

  it('refuses a missing target and leaves the stack alone', async () => {
    const { shell } = await lab();
    expect(await shell.run('pushd C:\\nonexistent')).toBe('The system cannot find the path specified.');
    expect(await shell.run('pushd')).toBe('');
  });

  it('refuses a file and names a missing drive', async () => {
    const { shell } = await lab();
    expect(await shell.run('pushd plain.txt')).toBe('The directory name is invalid.');
    expect(await shell.run('pushd Z:\\')).toBe('The system cannot find the drive specified.');
    expect(await shell.run('pushd')).toBe('');
  });

  it('lists the stack from the most recent entry', async () => {
    const { shell } = await lab();
    await shell.runAll('pushd C:\\Windows', 'pushd System32');
    expect(await shell.run('pushd')).toBe('C:\\Windows\nC:\\Users\\User');
  });

  it('goes to the directory of a drive for pushd X:', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Windows');
    await shell.run('pushd D:');
    expect(shell.prompt).toBe('D:\\Data>');
  });

  it('converts the case of the pushed target', async () => {
    const { shell } = await lab();
    await shell.run('pushd c:\\WINDOWS');
    expect(shell.prompt).toBe('C:\\Windows>');
    expect(await shell.run('pushd')).toBe('C:\\Users\\User');
  });

  it('names the refusal when the directory to return to has gone', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Brief', 'cd Brief', 'pushd C:\\Windows', 'rd C:\\Users\\User\\Brief');
    expect(await shell.run('popd')).toBe('The system cannot find the path specified.');
    expect(shell.prompt).toBe('C:\\Windows>');
  });

  it('does nothing when the stack is empty', async () => {
    const { shell } = await lab();
    expect(await shell.run('popd')).toBe('');
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });

  it('gives every terminal its own stack', async () => {
    const { machine, shell } = await lab();
    const other = await Console.open(machine, 'b');
    await shell.run('pushd C:\\Windows');
    expect(await other.run('pushd')).toBe('');
    await other.run('popd');
    expect(await other.directory()).toBe('C:\\Users\\User');
    await shell.run('popd');
    expect(await shell.directory()).toBe('C:\\Users\\User');
  });

  it('keeps the drive directories across a pushed move', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Windows', 'pushd D:\\Shared', 'popd');
    expect(shell.prompt).toBe('C:\\Windows>');
    expect(await shell.run('cd D:')).toBe('D:\\Shared');
  });
});

describe('a directory in use cannot be removed', () => {
  it('refuses to remove the current directory of the terminal', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Inside', 'cd Inside');
    expect(await shell.run('rd C:\\Users\\User\\Inside')).toBe(BUSY);
    expect(await shell.run('rd .')).toBe(BUSY);
    expect(await shell.directory()).toBe('C:\\Users\\User\\Inside');
    expect(await shell.run('dir /b C:\\Users\\User')).toContain('Inside');
  });

  it('refuses to remove the current directory of another terminal', async () => {
    const { machine, shell } = await lab();
    const other = await Console.open(machine, 'b');
    await shell.run('mkdir Shared1');
    await other.run('cd Shared1');
    expect(await shell.run('rd Shared1')).toBe(BUSY);
    expect(await shell.run('dir /b')).toContain('Shared1');
  });

  it('refuses to remove a parent of the current directory', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Outer\\Inner', 'cd Outer\\Inner');
    expect(await shell.run('rd C:\\Users\\User\\Outer\\Inner')).toBe(BUSY);
    expect(await shell.run('rd /s /q C:\\Users\\User\\Outer')).toBe(`${BUSY}\nThe directory is not empty.`);
    expect(await shell.directory()).toBe('C:\\Users\\User\\Outer\\Inner');
    expect(await shell.run('dir /b C:\\Users\\User\\Outer')).toBe('Inner');
  });

  it('refuses a recursive removal of the current directory itself', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Inside', 'cd Inside');
    expect(await shell.run('rd /s /q C:\\Users\\User\\Inside')).toBe(BUSY);
    expect(await shell.run('rd /s /q .')).toBe(BUSY);
    expect(await shell.directory()).toBe('C:\\Users\\User\\Inside');
  });

  it('stops a chain at a refused rd and runs the failure branch', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Inside', 'cd Inside');
    expect(await shell.run('rd . && echo removed')).toBe(BUSY);
    expect(await shell.run('rd . || echo kept')).toBe(`${BUSY}\nkept`);
  });

  it('refuses to rename the current directory of the terminal', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Held', 'cd Held');
    expect(await shell.run('ren C:\\Users\\User\\Held Freed')).toBe(BUSY);
    expect(await shell.run('dir /b C:\\Users\\User')).toContain('Held');
  });

  it('refuses to move the current directory of the terminal', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Held', 'cd Held');
    expect(await shell.run('move C:\\Users\\User\\Held C:\\Users\\User\\Moved')).toContain(BUSY);
    expect(await shell.run('dir /b C:\\Users\\User')).toContain('Held');
  });

  it('renames a directory nobody holds', async () => {
    const { shell } = await lab();
    await shell.run('mkdir Free');
    expect(await shell.run('ren Free Freed')).toBe('');
    expect(await shell.run('dir /b')).toContain('Freed');
  });

  it('removes the directory once the terminal has left it', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Gone', 'cd Gone', 'cd ..');
    expect(await shell.run('rd Gone')).toBe('');
    expect(await shell.run('dir /b')).not.toContain('Gone');
  });

  it('removes a directory next to the current one', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir Left', 'mkdir Right', 'cd Left');
    expect(await shell.run('rd ..\\Right')).toBe('');
  });

  it('leaves a directory of another drive removable', async () => {
    const { shell } = await lab();
    await shell.runAll('mkdir D:\\Scratch', 'cd /d D:\\Scratch', 'cd /d C:\\Users\\User');
    expect(await shell.run('rd D:\\Scratch')).toBe('');
  });
});

describe('dir with nothing to list', () => {
  it('names the directory searched when a name matches nothing', async () => {
    const { shell } = await lab();
    const output = await shell.run('dir nonexist');
    expect(output.split('\n')).toEqual([
      ' Volume in drive C is Windows',
      expect.stringMatching(/^ Volume Serial Number is [0-9A-F]{4}-[0-9A-F]{4}$/),
      '',
      ' Directory of C:\\Users\\User',
      '',
      'File Not Found',
    ]);
  });

  it('sets the error level when nothing matches', async () => {
    const { shell } = await lab();
    expect((await shell.run('dir nonexist || echo missing')).split('\n').slice(-2)).toEqual(['File Not Found', 'missing']);
    expect(await shell.run('dir /b nonexist || echo missing')).toBe('File Not Found\nmissing');
  });

  it('leaves the error level at zero when something is listed', async () => {
    const { shell } = await lab();
    expect(await shell.run('dir /b plain.txt || echo missing')).toBe('plain.txt');
    expect(await shell.run('dir D:\\ && echo listed')).toMatch(/listed$/);
  });

  it('prints only File Not Found in bare format', async () => {
    const { shell } = await lab();
    expect(await shell.run('dir /b nonexist')).toBe('File Not Found');
  });

  it('lists a file by name', async () => {
    const { shell } = await lab();
    expect(await shell.run('dir /b plain.txt')).toBe('plain.txt');
  });
});

describe('dir names the volume of the drive it lists', () => {
  it('prints the label of the drive in the header', async () => {
    const { shell } = await lab();
    const lines = (await shell.run('dir D:\\')).split('\n');
    expect(lines[0]).toBe(' Volume in drive D is Data');
    expect(lines[1]).toMatch(/^ Volume Serial Number is [0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(lines[3]).toBe(' Directory of D:\\');
  });

  it('prints the label of the current drive in the header', async () => {
    const { shell } = await lab();
    const lines = (await shell.run('dir C:\\Windows\\Fonts')).split('\n');
    expect(lines[0]).toBe(' Volume in drive C is Windows');
    expect(lines[3]).toBe(' Directory of C:\\Windows\\Fonts');
  });
});

describe('prompt', () => {
  it('shows the directory by default', async () => {
    const { shell } = await lab();
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('shows text, drive and path with the documented codes', async () => {
    const { shell } = await lab();
    expect(await shell.run('prompt $P$G')).toBe('');
    expect(shell.prompt).toBe('C:\\Users\\User>');
    await shell.run('prompt [$N]$S$P$G');
    expect(shell.prompt).toBe('[C] C:\\Users\\User>');
    await shell.run('cd Documents');
    expect(shell.prompt).toBe('[C] C:\\Users\\User\\Documents>');
  });

  it('resets to the default when given no text', async () => {
    const { shell } = await lab();
    await shell.run('prompt $$$G');
    expect(shell.prompt).toBe('$>');
    await shell.run('prompt');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('erases the previous character with the backspace code', async () => {
    const { shell } = await lab();
    await shell.run('prompt ab$Hc$G');
    expect(shell.prompt).toBe('ac>');
  });

  it('counts the pushed directories with the plus code', async () => {
    const { shell } = await lab();
    await shell.runAll('prompt $+$P$G', 'pushd C:\\Windows', 'pushd System32');
    expect(shell.prompt).toBe('++C:\\Windows\\System32>');
    await shell.run('popd');
    expect(shell.prompt).toBe('+C:\\Windows>');
  });

  it('keeps the setting in the PROMPT variable', async () => {
    const { shell } = await lab();
    await shell.run('prompt $P$S$G');
    expect(await shell.run('echo %PROMPT%')).toBe('$P$S$G');
    expect(shell.prompt).toBe('C:\\Users\\User >');
  });

  it('keeps the setting in its own terminal', async () => {
    const { machine, shell } = await lab();
    const other = await Console.open(machine, 'b');
    await shell.run('prompt $N$G');
    expect(shell.prompt).toBe('C>');
    expect(other.prompt).toBe('C:\\Users\\User>');
  });
});

describe('child shells keep their directory to themselves', () => {
  it('does not carry the directory of a child cmd back to its parent', async () => {
    const { shell } = await lab();
    await shell.runAll('cmd', 'cd ..', 'cd /d D:\\Data');
    expect(shell.prompt).toBe('D:\\Data>');
    await shell.run('exit');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('runs the command of cmd /k in the child and keeps the child open', async () => {
    const { shell } = await lab();
    await shell.run('cmd /k cd \\Windows');
    expect(shell.prompt).toBe('C:\\Windows>');
    await shell.run('exit');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('prints what the command of cmd /k writes', async () => {
    const { shell } = await lab();
    const lines = (await shell.run('cmd /k echo ready')).split('\n');
    expect(lines[lines.length - 1]).toBe('ready');
  });

  it('starts a child cmd in the directory of the parent', async () => {
    const { shell } = await lab();
    await shell.run('cd Documents');
    await shell.run('cmd');
    expect(shell.prompt).toBe('C:\\Users\\User\\Documents>');
  });

  it('does not carry the directory of a child PowerShell back to its parent', async () => {
    const { shell } = await lab();
    await shell.runAll('powershell', 'cd C:\\Windows');
    expect(shell.prompt).toBe('PS C:\\Windows> ');
    await shell.run('exit');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('starts a child PowerShell in the directory of the parent', async () => {
    const { shell } = await lab();
    await shell.runAll('cd Documents', 'powershell');
    expect(shell.prompt).toBe('PS C:\\Users\\User\\Documents> ');
  });

  it('does not carry a one-shot PowerShell back to its parent', async () => {
    const { shell } = await lab();
    await shell.run('powershell -Command "Set-Location C:\\Windows"');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('does not carry a drive directory of a child back to its parent', async () => {
    const { shell } = await lab();
    await shell.runAll('powershell', 'cd D:\\Data', 'exit');
    expect(await shell.run('cd D:')).toBe('D:\\');
  });

  it('lets a child cmd read the drive directories of its parent', async () => {
    const { shell } = await lab();
    await shell.runAll('cd /d D:\\Data', 'cd /d C:\\Windows', 'cmd');
    expect(await shell.run('cd D:')).toBe('D:\\Data');
  });

  it('does not let start /d move the parent', async () => {
    const { shell } = await lab();
    await shell.run('start /d C:\\Windows cmd /c cd');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('does not carry the stack of a child cmd back to its parent', async () => {
    const { shell } = await lab();
    await shell.runAll('cmd', 'pushd C:\\Windows', 'exit');
    expect(await shell.run('pushd')).toBe('');
  });

  it('runs cmd /c without moving the parent', async () => {
    const { shell } = await lab();
    expect(await shell.run('cmd /c cd C:\\Windows ^& cd')).toBe('C:\\Windows');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });

  it('gives a sibling terminal its own directory', async () => {
    const { machine, shell } = await lab();
    const other = await Console.open(machine, 'b');
    await shell.run('cd /d C:\\Windows');
    expect(other.prompt).toBe('C:\\Users\\User>');
    await other.run('cd /d D:\\Data');
    expect(shell.prompt).toBe('C:\\Windows>');
  });
});

describe('the session a child shell leases from the machine', () => {
  it('holds the directory of a child cmd while it is open and frees it on exit', async () => {
    const { machine, shell } = await lab();
    const other = await Console.open(machine, 'b');
    await shell.runAll('mkdir Held', 'cmd', 'cd Held');
    expect(await other.run('rd C:\\Users\\User\\Held')).toBe(BUSY);
    await shell.run('exit');
    expect(await other.run('rd C:\\Users\\User\\Held')).toBe('');
  });

  it('holds the directory of a child PowerShell while it is open and frees it on exit', async () => {
    const { machine, shell } = await lab();
    const other = await Console.open(machine, 'b');
    await shell.runAll('mkdir Held', 'powershell', 'cd Held');
    expect(await other.run('rd C:\\Users\\User\\Held')).toBe(BUSY);
    await shell.run('exit');
    expect(await other.run('rd C:\\Users\\User\\Held')).toBe('');
  });

  it('gives nothing to a machine that is not a Windows PC', async () => {
    const { machine } = await lab();
    const { leaseWindowsSession, returnWindowsSession } = await import('@/shell/adapters/WindowsShellSessionLease');
    const linux = new LinuxPC('linux-pc', 'LX');
    expect(leaseWindowsSession({ device: linux, user: 'User' })).toBeNull();
    expect(() => returnWindowsSession(linux, null)).not.toThrow();
    expect(() => returnWindowsSession(machine, null)).not.toThrow();
  });

  it('starts a shell made for a given directory in that directory', async () => {
    const { machine } = await lab();
    const { installDefaultShells } = await import('@/shell/registerDefaults');
    const { ShellFactory } = await import('@/shell/ShellFactory');
    installDefaultShells();
    const shell = ShellFactory.create('cmd', { device: machine, user: 'User', cwd: 'C:\\Windows' });
    expect(shell.getPrompt()).toBe('C:\\Windows>');
  });

  it('starts a shell made without a directory in the profile of its account', async () => {
    const { machine } = await lab();
    const { installDefaultShells } = await import('@/shell/registerDefaults');
    const { ShellFactory } = await import('@/shell/ShellFactory');
    installDefaultShells();
    const shell = ShellFactory.create('cmd', { device: machine, user: 'User' });
    expect(shell.getPrompt()).toBe('C:\\Users\\User>');
  });
});

describe('batch files and chained commands', () => {
  it('echoes the lines of a batch file after the prompt text', async () => {
    const { shell } = await lab();
    await shell.runAll('prompt [$N]$G', 'echo cd> echo.bat');
    expect(await shell.run('call C:\\Users\\User\\echo.bat')).toContain('[C]>cd');
  });

  it('reads the directory after cd in the same line', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd \\Windows & cd')).toBe('C:\\Windows');
    expect(await shell.run('cd .. && cd')).toBe('C:\\');
  });

  it('stops a chain at a refused cd', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd nonexistent && echo ok')).toBe('The system cannot find the path specified.');
    expect(await shell.run('cd plain.txt && echo ok')).toBe('The directory name is invalid.');
  });

  it('runs the failure branch after a refused cd', async () => {
    const { shell } = await lab();
    expect(await shell.run('cd plain.txt || echo failed')).toBe('The directory name is invalid.\nfailed');
  });

  it('carries a batch file cd /d back to the caller as cmd does', async () => {
    const { shell } = await lab();
    await shell.runAll('echo cd /d C:\\Windows> go.bat', 'call go.bat');
    expect(shell.prompt).toBe('C:\\Windows>');
  });

  it('keeps a pushd of a batch file for the caller until popd', async () => {
    const { shell } = await lab();
    await shell.runAll('echo pushd C:\\Windows> in.bat', 'echo popd> out.bat', 'call C:\\Users\\User\\in.bat');
    expect(shell.prompt).toBe('C:\\Windows>');
    await shell.run('call C:\\Users\\User\\out.bat');
    expect(shell.prompt).toBe('C:\\Users\\User>');
  });
});
