/*
 * `nano -H` et `nano -P` sur une vraie machine Linux simulee (utilisateur, droits, variables d'environnement de la
 * session), la ou nano-state-oracle et probe-nano-state rejouent le moteur seul contre un vrai nano 7.2 lance en root.
 * Les cas non-root ont ete mesures a la main avec le vrai binaire (setpriv --reuid=65534, HOME dans un dossier a soi) :
 *   - un utilisateur ordinaire lit $HOME ; root ignore $HOME et lit l'entree de /etc/passwd (get_homedir) ;
 *   - les dossiers .local, .local/share et nano naissent en 0700, les deux fichiers en 0600, au nom de l'utilisateur ;
 *   - un $HOME sans droit d'ecriture donne « Unable to create directory <home>/.local/share/nano/: No such file or
 *     directory » (les deux mkdir de .local et .local/share echouent en silence, le dernier ne trouve plus son parent),
 *     l'alerte « Problems with history file » et, a la sortie, le texte complet sur le terminal ;
 *   - un fichier d'historique illisible donne « Error reading <fichier>: Permission denied », une alerte au demarrage,
 *     et le fichier est abandonne pour la session ; illisible en ecriture : « Error writing ... » a la sortie.
 *
 * Mesure : un moteur qui ignore -H et -P laissait tomber 9 des 12 tests ; sans le cablage du terminal et du systeme de
 * fichiers de production (`git stash push -- src/terminal src/components`) 10 des 12 tombent.  Les deux qui passent dans
 * les deux mesures sont des TEMOINS : « sans -H ni -P, rien n'est cree » prouve que le lab ne cree pas les fichiers de
 * lui-meme, et « les positions d'un utilisateur ne sont pas celles d'un autre » prouve que le curseur de root reste en
 * haut sans journal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { parseNanoCommandLine } from '@/network/devices/linux/editors/nano/NanoCommandLine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { applyNanoStep } from '../../support/oracle/nanoScreenReplay';

let pc: LinuxPC;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await pc.executeCommand('printf "alpha\\nbeta\\ngamma\\ndelta\\n" > /tmp/t.txt');
  await pc.executeCommand('chmod 666 /tmp/t.txt');
});

const asRoot = (command: string): Promise<string> => pc.executeCommand(`sudo bash -c '${command.replace(/'/g, "'\\''")}'`);

function open(args: string[], session?: LinuxShellSession): NanoEngine {
  const invocation = parseNanoCommandLine(args);
  if (invocation.kind !== 'open') throw new Error('not an opening command line');
  const fs = new LinuxEditorFsContext(pc, session);
  const name = invocation.files[0].path;
  const absolute = fs.resolvePath(name);
  const engine = new NanoEngine(fs, absolute, fs.readFile(absolute) ?? '', fs.readFile(absolute) === null, false, undefined, false, {
    settings: invocation.settings, start: invocation.files[0].start ?? null, displayName: name,
  });
  engine.resize(24, 80);
  return engine;
}

function keys(engine: NanoEngine, ...steps: string[]): void {
  for (const step of steps) applyNanoStep(engine, step);
}

const alice = (): LinuxShellSession => pc.openShellSession({ user: 'alice' });
const root = (): LinuxShellSession => pc.openShellSession({ user: 'root' });

describe('nano -H -P on a machine, one measured behaviour per test', () => {
  it('creates the state directory private to root, with private files', async () => {
    const engine = open(['-H', '-P', '/tmp/t.txt'], root());
    keys(engine, 'C-w', 'beta', 'Enter', 'Down', 'C-x');
    expect(engine.exited).toBe(true);
    const listing = await asRoot('ls -la /root/.local/share/nano');
    expect(listing).toMatch(/^drwx------ .* \.$/m);
    expect(listing).toMatch(/^-rw------- .* root root .* filepos_history$/m);
    expect(listing).toMatch(/^-rw------- .* root root .* search_history$/m);
    expect(await asRoot('cat /root/.local/share/nano/filepos_history')).toBe('/tmp/t.txt 3 1');
    expect(await asRoot('cat /root/.local/share/nano/search_history')).toBe('beta\n\n\n');
  });

  it('WITNESS: without -H and -P nothing is created', async () => {
    const engine = open(['/tmp/t.txt'], root());
    keys(engine, 'C-w', 'beta', 'Enter', 'Down', 'C-x');
    expect(engine.exited).toBe(true);
    expect(await asRoot('ls -a /root')).not.toContain('.local');
  });

  it('puts an ordinary user\'s files in their own home, owned by them', async () => {
    const engine = open(['-H', '-P', '/tmp/t.txt'], alice());
    keys(engine, 'C-w', 'gamma', 'Enter', 'C-x');
    const listing = await asRoot('ls -la /home/alice/.local/share/nano');
    expect(listing).toMatch(/^-rw------- .* alice alice .* filepos_history$/m);
    expect(listing).toMatch(/^-rw------- .* alice alice .* search_history$/m);
    expect(await asRoot('ls -ld /home/alice/.local /home/alice/.local/share /home/alice/.local/share/nano')).toMatch(/^(drwx------ .*\n?){3}$/);
  });

  it('restores the cursor the next time the same user opens the same file', () => {
    const first = open(['-P', '/tmp/t.txt'], alice());
    keys(first, 'Down', 'Down', 'Right', 'C-x');
    const second = open(['-P', '/tmp/t.txt'], alice());
    expect(second.cursorLine).toBe(2);
    expect(second.cursorCol).toBe(1);
  });

  it('keeps one user\'s positions out of another user\'s file', () => {
    keys(open(['-P', '/tmp/t.txt'], alice()), 'Down', 'C-x');
    expect(open(['-P', '/tmp/t.txt'], root()).cursorLine).toBe(0);
  });

  it('recalls a search typed in an earlier session', () => {
    keys(open(['-H', '/tmp/t.txt'], alice()), 'C-w', 'delta', 'Enter', 'C-x');
    const later = open(['-H', '/tmp/t.txt'], alice());
    keys(later, 'C-w', 'Up');
    expect(later.searchQuery).toBe('delta');
  });

  it('lets root ignore $HOME and use the password database', async () => {
    const session = root();
    session.env.set('HOME', '/home/alice');
    keys(open(['-H', '/tmp/t.txt'], session), 'C-w', 'beta', 'Enter', 'C-x');
    expect(await asRoot('ls /root/.local/share/nano')).toContain('search_history');
    expect(await asRoot('ls -a /home/alice')).not.toContain('.local');
  });

  it('reads XDG_DATA_HOME from the session environment', async () => {
    await asRoot('mkdir -p /home/alice/xdg && chown alice:alice /home/alice/xdg');
    const session = alice();
    session.env.set('XDG_DATA_HOME', '/home/alice/xdg');
    keys(open(['-H', '/tmp/t.txt'], session), 'C-w', 'beta', 'Enter', 'C-x');
    expect(await asRoot('cat /home/alice/xdg/nano/search_history')).toBe('beta\n\n\n');
    expect(await asRoot('ls -a /home/alice')).not.toContain('.local');
  });

  it('says why the directory could not be made, and keeps going without the logs', async () => {
    await asRoot('chmod 555 /home/alice');
    const engine = open(['-H', '-P', '/tmp/t.txt'], alice());
    expect(engine.statusMessage).toBe('[ Problems with history file ]');
    keys(engine, 'C-w', 'beta', 'Enter', 'C-x');
    expect(engine.exited).toBe(true);
    expect(engine.exitNotice).toBe('Unable to create directory /home/alice/.local/share/nano/: No such file or directory\nIt is required for saving/loading search history or cursor positions.\n\n');
    expect(await asRoot('ls -a /home/alice')).not.toContain('.local');
  });

  it('abandons an unreadable history file for the session and reports it on exit', async () => {
    await asRoot('mkdir -p /home/alice/.local/share/nano && printf "x\\n\\n\\n\\n" > /home/alice/.local/share/nano/search_history');
    await asRoot('chown -R alice:alice /home/alice/.local && chown root:root /home/alice/.local/share/nano/search_history && chmod 000 /home/alice/.local/share/nano/search_history');
    const engine = open(['-H', '/tmp/t.txt'], alice());
    expect(engine.statusMessage).toBe('[ Problems with history file ]');
    keys(engine, 'C-w', 'Up');
    expect(engine.searchQuery).toBe('');
    keys(engine, 'C-c', 'C-x');
    expect(engine.exitNotice).toBe('Error reading /home/alice/.local/share/nano/search_history: Permission denied\n');
  });

  it('reports an unwritable log on exit, positions before histories', async () => {
    await asRoot('mkdir -p /home/alice/.local/share/nano');
    await asRoot('printf "x\\n\\n\\n\\n" > /home/alice/.local/share/nano/search_history && printf "/nowhere 1 1\\n" > /home/alice/.local/share/nano/filepos_history');
    await asRoot('chown -R alice:alice /home/alice/.local && chown root:root /home/alice/.local/share/nano/* && chmod 444 /home/alice/.local/share/nano/*');
    const engine = open(['-H', '-P', '/tmp/t.txt'], alice());
    keys(engine, 'C-w', 'beta', 'Enter', 'Down', 'C-x');
    expect(engine.exitNotice).toBe('Error writing /home/alice/.local/share/nano/filepos_history: Permission denied\nError writing /home/alice/.local/share/nano/search_history: Permission denied\n');
  });

  it('prints the exit notice in the terminal once the editor is closed', () => {
    const session = new LinuxTerminalSession('term-1', pc);
    session.editorExit(true, 'Unable to create directory /x/: Not a directory\nIt is required.\n\n');
    expect(session.lines.slice(-3).map((l) => l.text)).toEqual(['Unable to create directory /x/: Not a directory', 'It is required.', '']);
  });
});
